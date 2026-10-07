import { ProductId } from '../../domain/value-objects/canonical-product-values'
import {
  asStrictObject,
  parseInteger,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import {
  CanonicalProductNotFoundError,
  OutboxPayloadTooLargeError,
} from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { RequestTraceContext } from '../ports/RequestTraceContext'
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

export interface ConfigureProductDropChanceDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
}

const MAX_PAYLOAD_BYTES = 256 * 1024

/**
 * Configura la tasa de caida Versus (`dropChanceBasisPoints`) de un producto
 * ARMA/ARMADURA/ITEM canonico ya existente (HU-30, Task HU-30.1).
 *
 * Brecha confirmada en auditoria: `UpdateProductDetails` declara `attributes`
 * explicitamente no editable (Combat/Player-Inventory dependen de su forma) y
 * ningun otro contrato permitia fijar esta tasa sobre un producto creado
 * antes de HU-30. Sin ella, `CaptureBattleDropSnapshot` de Player-Inventory
 * rechaza la instantanea con `DROP_RATE_UNAVAILABLE` y Combat no puede
 * iniciar ninguna batalla donde ese producto este equipado (HU-29 ya exige
 * capturar la instantanea al arrancar). Esta operacion es la via minima para
 * cerrar esa brecha sin reabrir la inmutabilidad general de `attributes`.
 *
 * Mismo patron transaccional que `ConfigureProductPremium`: producto,
 * auditoria (RNF-06) y evento de outbox se escriben juntos (ADR-015).
 */
export class ConfigureProductDropChance {
  constructor(private readonly deps: ConfigureProductDropChanceDependencies) {}

  async execute(
    rawProductId: string,
    rawCommand: unknown,
    actor: AuditActor | undefined,
    trace: RequestTraceContext,
  ): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['dropChanceBasisPoints'])
    const dropChanceBasisPoints = parseInteger(
      requiredValue(record, 'dropChanceBasisPoints', 'command'),
      'command.dropChanceBasisPoints',
      { minimum: 0, maximum: 10_000 },
    )

    const actual = await this.deps.products.findById(productId)

    if (actual === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    const now = this.deps.clock.now()
    const configurado = actual.configureDropChance(dropChanceBasisPoints, now)
    const anterior = actual.toSnapshot()
    const nuevo = configurado.toSnapshot()
    const dto = toCanonicalProductDto(nuevo)

    const eventId = this.deps.idGenerator.generate()

    const anteriorValues = anterior.attributes.values as unknown as Record<string, unknown>
    const nuevoValues = nuevo.attributes.values as unknown as Record<string, unknown>

    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_DROP_CHANCE_CONFIGURED',
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot: nuevo,
      delta: {
        dropChanceBasisPoints: {
          valorAnterior: anteriorValues.dropChanceBasisPoints ?? null,
          valorNuevo: nuevoValues.dropChanceBasisPoints ?? null,
        },
      },
    }

    const payload = dto as unknown as Record<string, unknown>

    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_PAYLOAD_BYTES) {
      throw new OutboxPayloadTooLargeError(Buffer.byteLength(JSON.stringify(payload), 'utf8'))
    }

    const outboxEntry: OutboxEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      eventType: 'catalog.product.drop-chance.configured',
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
      correlationId: trace.correlationId,
    }

    const escribir = async (tx?: TransactionContext): Promise<void> => {
      await this.deps.products.update(configurado, actual.version, tx)
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
