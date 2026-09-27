import {
  ProductDescription,
  ProductId,
  ProductImageUrl,
} from '../../domain/value-objects/canonical-product-values'
import { ProductName } from '../../domain/value-objects/catalog-values'
import { DomainError } from '../../domain/errors/DomainError'
import {
  asStrictObject,
  optionalValue,
  parseString,
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

export interface UpdateProductDetailsDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
}

const MAX_PAYLOAD_BYTES = 256 * 1024
const EDITABLE_KEYS = ['name', 'imageUrl', 'description'] as const

/**
 * Edita los campos de presentacion de un producto canonico ya existente:
 * `name`, `imageUrl`, `description` -pedido explicito del cliente del
 * proyecto ("editar productos" en el panel de administracion-.
 *
 * `type` Y `attributes` NO SE ACEPTAN AQUI. No es una omision: Combat empareja
 * efectos por `type` y Player-Inventory calcula equipo por `attributes`
 * (`product-attributes.ts`/`product-effects.ts`), asi que son un limite de
 * alcance deliberado. `asStrictObject` los rechaza igual que rechazaria
 * cualquier otra clave no declarada.
 *
 * Mismo patron transaccional que `AdjustProductInventory` /
 * `ConfigureProductPremium` / `UpdateProductLifecycleStatus`: producto,
 * auditoria (RNF-06) y evento de outbox se escriben juntos (ADR-015). La
 * concurrencia optimista es la MISMA que esos tres casos de uso: no hay un
 * campo `version` en el cuerpo de la peticion -ninguno de los otros tres lo
 * tiene tampoco-, la condicion viaja con la version que este caso de uso leyo
 * de `products.findById`, y `products.update` la comprueba en la escritura.
 */
export class UpdateProductDetails {
  constructor(private readonly deps: UpdateProductDetailsDependencies) {}

  async execute(
    rawProductId: string,
    rawCommand: unknown,
    actor: AuditActor | undefined,
    trace: RequestTraceContext,
  ): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', [...EDITABLE_KEYS])

    const hasAnyField = EDITABLE_KEYS.some((key) => optionalValue(record, key) !== undefined)

    if (!hasAnyField) {
      throw new DomainError(
        'command debe incluir al menos un campo editable: name, imageUrl o description.',
      )
    }

    const rawName = optionalValue(record, 'name')
    const rawImageUrl = optionalValue(record, 'imageUrl')
    const rawDescription = optionalValue(record, 'description')

    const name =
      rawName === undefined ? undefined : ProductName.create(parseString(rawName, 'command.name'))
    const imageUrl =
      rawImageUrl === undefined
        ? undefined
        : ProductImageUrl.create(parseString(rawImageUrl, 'command.imageUrl'))
    const description =
      rawDescription === undefined
        ? undefined
        : ProductDescription.create(parseString(rawDescription, 'command.description'))

    const actual = await this.deps.products.findById(productId)

    if (actual === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    const now = this.deps.clock.now()
    const actualizado = actual.updateDetails({ name, imageUrl, description }, now)
    const anterior = actual.toSnapshot()
    const nuevo = actualizado.toSnapshot()
    const dto = toCanonicalProductDto(nuevo)

    const eventId = this.deps.idGenerator.generate()

    // El delta lleva SOLO los campos que de verdad cambiaron, mismo criterio
    // que `UpdateProductLifecycleStatus` con `reason`: registrar los tres
    // siempre sugeriria que los tres se tocaron, aunque la peticion solo
    // trajera uno.
    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_DETAILS_UPDATED',
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot: nuevo,
      delta: {
        ...(name === undefined
          ? {}
          : { name: { valorAnterior: anterior.name, valorNuevo: nuevo.name } }),
        ...(imageUrl === undefined
          ? {}
          : { imageUrl: { valorAnterior: anterior.imageUrl, valorNuevo: nuevo.imageUrl } }),
        ...(description === undefined
          ? {}
          : {
              description: {
                valorAnterior: anterior.description,
                valorNuevo: nuevo.description,
              },
            }),
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
      eventType: 'catalog.product.details.updated',
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
