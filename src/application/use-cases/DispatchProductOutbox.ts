import { describeError } from '../services/describe-error'
import { buildProductEventEnvelope } from '../services/ProductEventEnvelopeFactory'
import {
  DISPATCHABLE_EVENT_TYPES,
  resolveProductEventDestination,
} from '../services/ProductEventRouting'
import type { OutboxEntry, ProductOutboxPort } from '../ports/CanonicalProductPorts'
import type { LoggerPort } from '../ports/LoggerPort'
import type { ProductEventPublisherPort } from '../ports/ProductEventPublisherPort'

/** Lease por defecto de un ciclo de despacho (decision tecnica interna, no requisito funcional). */
export const DEFAULT_LEASE_DURATION_MS = 30_000

export interface DispatchProductOutboxDependencies {
  readonly outbox: ProductOutboxPort
  readonly publisher: ProductEventPublisherPort
  readonly logger: LoggerPort
  readonly workerId: string
  readonly batchSize: number
  readonly leaseDurationMs?: number
}

export interface DispatchBatchResult {
  readonly claimed: number
  readonly succeeded: number
  readonly failed: number
}

/**
 * Dispatcher UNICO del outbox de Producto hacia SQS (HU-38): reclama solo los
 * `eventType` aprobados (created + los cuatro de ciclo de vida), enruta cada
 * uno a su cola (ADR-017/ADR-018), construye y valida el envelope, publica y
 * marca el resultado. Reutiliza `ProductOutboxPort`; no crea otro outbox ni
 * otro dispatcher por evento.
 */
export class DispatchProductOutbox {
  constructor(private readonly deps: DispatchProductOutboxDependencies) {}

  async dispatchBatch(): Promise<DispatchBatchResult> {
    const leaseDurationMs = this.deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS

    const entries = await this.deps.outbox.claim(
      this.deps.workerId,
      this.deps.batchSize,
      leaseDurationMs,
      DISPATCHABLE_EVENT_TYPES,
    )

    if (entries.length === 0) {
      return { claimed: 0, succeeded: 0, failed: 0 }
    }

    this.deps.logger.info('outbox_claimed', {
      count: entries.length,
      workerId: this.deps.workerId,
    })

    let succeeded = 0
    let failed = 0

    // Despacho secuencial deliberado: preserva el orden de intento dentro del
    // lote y evita saturar la cola con envios concurrentes de un mismo ciclo.
    for (const entry of entries) {
      const ok = await this.dispatchOne(entry)
      if (ok) succeeded += 1
      else failed += 1
    }

    this.deps.logger.info('event_dispatch_batch_completed', {
      claimed: entries.length,
      succeeded,
      failed,
      workerId: this.deps.workerId,
    })

    return { claimed: entries.length, succeeded, failed }
  }

  private async dispatchOne(entry: OutboxEntry): Promise<boolean> {
    const attempt = entry.attempts + 1
    const baseContext = {
      eventId: entry.eventId,
      aggregateId: entry.aggregateId,
      eventType: entry.eventType,
      eventVersion: entry.eventVersion,
      attempt,
      workerId: this.deps.workerId,
    }

    let envelope
    let destination
    try {
      destination = resolveProductEventDestination(entry.eventType)
      envelope = buildProductEventEnvelope(entry)
    } catch (error) {
      const reason = describeError(error)
      await this.deps.outbox.fail(entry.eventId, reason)
      this.deps.logger.warn('event_dispatch_failed', { ...baseContext, error: reason })
      return false
    }

    const startedAt = Date.now()
    try {
      await this.deps.publisher.publish(destination, envelope)
    } catch (error) {
      const reason = describeError(error)
      await this.deps.outbox.fail(entry.eventId, reason)
      this.deps.logger.warn('event_dispatch_failed', { ...baseContext, destination, error: reason })
      return false
    }

    this.deps.logger.info('event_dispatch_succeeded', {
      ...baseContext,
      destination,
      latencyMs: Date.now() - startedAt,
    })

    try {
      await this.deps.outbox.complete(entry.eventId)
      this.deps.logger.info('event_dispatch_completed', {
        eventId: entry.eventId,
        workerId: this.deps.workerId,
      })
    } catch (error) {
      // At-least-once (ADR-017/018): el envio a SQS ya tuvo exito. Si marcar
      // complete() falla, NO se llama a fail() -seria una segunda senal de
      // fallo sobre un evento que SI se publico, y reiniciaria una politica
      // de reintentos que no aplica aqui-. El lease sigue su curso y expira
      // solo: el MISMO eventId se reclama y se publica otra vez. Un
      // duplicado con el mismo eventId es exactamente lo que el contrato
      // acepta; Notifications deduplica por eventId.
      this.deps.logger.warn('event_dispatch_complete_failed', {
        eventId: entry.eventId,
        workerId: this.deps.workerId,
        error: describeError(error),
      })
    }

    return true
  }
}
