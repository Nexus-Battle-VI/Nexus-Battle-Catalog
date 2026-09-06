import type { OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common'

import type { DispatchProductOutbox } from '../../application/use-cases/DispatchProductOutbox'
import type { Logger } from '../observability/logger'

/** Intervalo entre ciclos (decision tecnica interna, no requisito funcional). */
const DEFAULT_POLL_INTERVAL_MS = 2_000

export interface OutboxDispatcherWorkerOptions {
  readonly enabled: boolean
  readonly dispatcher: DispatchProductOutbox
  readonly logger: Logger
  readonly pollIntervalMs?: number
}

/**
 * Ciclo minimo de fondo compatible con Nest (HU-38, seccion 22). Catalog no
 * tenia ningun patron de worker/scheduler previo -auditado en codigo: no
 * existe-, asi que este es el mecanismo mas simple que cumple los
 * requisitos: no arranca si el despacho esta deshabilitado, un solo ciclo a
 * la vez (el siguiente se agenda solo cuando el anterior termino, nunca por
 * `setInterval` solapado), y `onApplicationShutdown` detiene el timer para un
 * apagado limpio sin perder leases a mitad de ciclo.
 */
export class OutboxDispatcherWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private readonly pollIntervalMs: number

  constructor(private readonly options: OutboxDispatcherWorkerOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.options.logger.info('dispatcher_disabled', {
        detail: 'CATALOG_EVENT_DISPATCH_ENABLED=false: el outbox no se despacha.',
      })
      return
    }

    this.options.logger.info('dispatcher_started', { pollIntervalMs: this.pollIntervalMs })
    this.scheduleNext(0)
  }

  onApplicationShutdown(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return

    this.timer = setTimeout(() => {
      void this.tick()
    }, delayMs)
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    try {
      await this.options.dispatcher.dispatchBatch()
    } catch (error) {
      this.options.logger.error('dispatcher_cycle_failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.scheduleNext(this.pollIntervalMs)
    }
  }
}
