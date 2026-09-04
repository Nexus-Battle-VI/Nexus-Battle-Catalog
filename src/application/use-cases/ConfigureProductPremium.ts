import {
  CreditsPrice,
  ProductId,
  ProductPricing,
} from '../../domain/value-objects/canonical-product-values'
import { Money } from '../../domain/value-objects/catalog-values'
import {
  asStrictObject,
  optionalValue,
  parseBoolean,
  parseInteger,
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

export interface ConfigureProductPremiumDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
}

const MAX_PAYLOAD_BYTES = 256 * 1024

const parseRealMoneyPrice = (raw: unknown): Money | null => {
  if (raw === null || raw === undefined) return null

  const record = asStrictObject(raw, 'command.realMoneyPrice', ['amount', 'currency'])
  const amount = parseInteger(
    requiredValue(record, 'amount', 'command.realMoneyPrice'),
    'command.realMoneyPrice.amount',
  )
  const currency = parseString(
    requiredValue(record, 'currency', 'command.realMoneyPrice'),
    'command.realMoneyPrice.currency',
  )

  return Money.create(amount, currency)
}

/**
 * Activa/actualiza la condicion premium de un producto canonico (HU-36,
 * CA-01/CA-02).
 *
 * Sigue el mismo patron transaccional que `AdjustProductInventory`: producto,
 * auditoria (RNF-06) y evento de outbox se escriben juntos (ADR-015). Retirar
 * premium queda fuera de esta operacion; vease el comentario de
 * `CanonicalProduct.configurePremium`.
 */
export class ConfigureProductPremium {
  constructor(private readonly deps: ConfigureProductPremiumDependencies) {}

  async execute(
    rawProductId: string,
    rawCommand: unknown,
    actor?: AuditActor,
  ): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['premium', 'realMoneyPrice'])
    const premium = parseBoolean(requiredValue(record, 'premium', 'command'), 'command.premium')
    const realMoneyPrice = parseRealMoneyPrice(optionalValue(record, 'realMoneyPrice'))

    const actual = await this.deps.products.findById(productId)

    if (actual === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    const pricing = ProductPricing.create({
      creditsPrice: CreditsPrice.create(actual.creditsPrice.value),
      premium,
      realMoneyPrice,
    })

    const now = this.deps.clock.now()
    const configurado = actual.configurePremium(pricing, now)
    const anterior = actual.toSnapshot()
    const nuevo = configurado.toSnapshot()
    const dto = toCanonicalProductDto(nuevo)

    const eventId = this.deps.idGenerator.generate()

    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_PREMIUM_CONFIGURED',
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot: nuevo,
      delta: {
        premium: { valorAnterior: anterior.premium, valorNuevo: nuevo.premium },
        realMoneyPrice: {
          valorAnterior: anterior.realMoneyPrice,
          valorNuevo: nuevo.realMoneyPrice,
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
      eventType: 'catalog.product.premium.configured',
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
