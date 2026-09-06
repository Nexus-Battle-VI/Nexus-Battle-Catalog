import { LifecycleStatus, ProductId } from '../../domain/value-objects/canonical-product-values'
import {
  asStrictObject,
  parseEnum,
  parseString,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import {
  CanonicalProductNotFoundError,
  OutboxPayloadTooLargeError,
} from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import {
  OutboxStatus,
  type AuditActor,
  type CanonicalProductUnitOfWorkPort,
  type CanonicalProductWritePort,
  type OutboxEntry,
  type ProductAuditEntry,
  type ProductAuditPort,
  type ProductOutboxPort,
  type TransactionContext,
} from '../ports/CanonicalProductPorts'

export interface UpdateProductLifecycleStatusDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
}

const MAX_PAYLOAD_BYTES = 256 * 1024

const ACTION_BY_STATUS: Record<LifecycleStatus, string> = {
  [LifecycleStatus.Suspended]: 'PRODUCT_SUSPENDED',
  [LifecycleStatus.Active]: 'PRODUCT_REACTIVATED',
}

const EVENT_TYPE_BY_STATUS: Record<LifecycleStatus, string> = {
  [LifecycleStatus.Suspended]: 'catalog.product.suspended',
  [LifecycleStatus.Active]: 'catalog.product.reactivated',
}

/**
 * Suspende o reactiva un producto (HU-35): borrado logico (CA-01) y
 * reactivacion (CA-03), con motivo obligatorio (CA-02) y auditoria
 * idempotente (HU-35, caso adicional de idempotencia). Mismo patron
 * transaccional que `AdjustProductInventory`/`ConfigureProductPremium`:
 * producto, auditoria (RNF-06) y evento de outbox se escriben juntos
 * (ADR-015).
 *
 * La notificacion a jugadores (HU-038) NO se implementa aqui: este caso de
 * uso solo produce el evento de outbox; consumirlo es responsabilidad de
 * HU-038 cuando exista.
 */
export class UpdateProductLifecycleStatus {
  constructor(private readonly deps: UpdateProductLifecycleStatusDependencies) {}

  async execute(
    rawProductId: string,
    rawCommand: unknown,
    actor?: AuditActor,
  ): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['status', 'reason'])
    const targetStatus = parseEnum(requiredValue(record, 'status', 'command'), 'command.status', [
      LifecycleStatus.Suspended,
      LifecycleStatus.Active,
    ])
    const reason = parseString(requiredValue(record, 'reason', 'command'), 'command.reason', {
      minLength: 10,
    })

    const actual = await this.deps.products.findById(productId)

    if (actual === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    const now = this.deps.clock.now()
    const actualizado =
      targetStatus === LifecycleStatus.Suspended ? actual.suspend(now) : actual.reactivate(now)

    // IDEMPOTENCIA: el dominio devuelve el MISMO agregado (misma referencia)
    // cuando el producto ya estaba en el estado destino. Se detecta aqui para
    // responder de forma informativa sin escribir un segundo evento de
    // auditoria ni de outbox.
    if (actualizado === actual) {
      return toCanonicalProductDto(actual.toSnapshot())
    }

    const nuevo = actualizado.toSnapshot()
    const dto = toCanonicalProductDto(nuevo)
    const eventId = this.deps.idGenerator.generate()

    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: ACTION_BY_STATUS[targetStatus],
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot: nuevo,
      delta: { reason },
    }

    const payload = dto as unknown as Record<string, unknown>

    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new OutboxPayloadTooLargeError(Buffer.byteLength(JSON.stringify(payload), 'utf8'))
    }

    const outboxEntry: OutboxEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      eventType: EVENT_TYPE_BY_STATUS[targetStatus],
      eventVersion: 1,
      status: OutboxStatus.Pending,
      payload,
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      dispatchedAt: null,
      purgeAt: null,
    }

    const escribir = async (tx?: TransactionContext): Promise<void> => {
      await this.deps.products.update(actualizado, actual.version, tx)
      if (this.deps.audit) await this.deps.audit.record(auditEntry, tx)
      if (this.deps.outbox) await this.deps.outbox.record(outboxEntry, tx)
    }

    if (this.deps.unitOfWork) {
      await this.deps.unitOfWork.executeTransaction(async (tx) => {
        await escribir(tx)
      })
    } else {
      await escribir()
    }

    return dto
  }
}
