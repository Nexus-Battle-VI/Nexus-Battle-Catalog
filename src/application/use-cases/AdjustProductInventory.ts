import { PrintRun } from '../../domain/value-objects/canonical-product-values'
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

export interface AdjustProductInventoryDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
}

const MAX_PAYLOAD_BYTES = 256 * 1024

/**
 * Ajusta el tiraje de un producto ya existente (HU-34, CA-02).
 *
 * TODO OCURRE EN UNA TRANSACCION: el producto, la entrada de auditoria y el
 * evento del outbox. Un ajuste sin rastro auditable no es un ajuste valido
 * (RNF-06), y la unica forma de garantizar que las tres cosas pasan o no pasa
 * ninguna es escribirlas juntas.
 *
 * LA ESCRITURA VA CONDICIONADA A LA VERSION LEIDA. Dos administradores
 * ajustando el mismo producto a la vez leerian el mismo estado; sin esa
 * condicion, el segundo pisaria al primero y la auditoria registraria dos
 * valores anteriores iguales que no describen lo que paso.
 */
export class AdjustProductInventory {
  constructor(private readonly deps: AdjustProductInventoryDependencies) {}

  async execute(
    rawProductId: string,
    rawCommand: unknown,
    actor?: AuditActor,
  ): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['printRun'])
    const printRun = PrintRun.create(
      parseInteger(requiredValue(record, 'printRun', 'command'), 'command.printRun'),
    )

    const actual = await this.deps.products.findById(productId)

    if (actual === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    const now = this.deps.clock.now()
    const ajustado = actual.adjustPrintRun(printRun, now)
    const anterior = actual.toSnapshot()
    const nuevo = ajustado.toSnapshot()
    const dto = toCanonicalProductDto(nuevo)

    const eventId = this.deps.idGenerator.generate()

    // El delta lleva los DOS valores. Guardar solo el nuevo dejaria la
    // auditoria incapaz de responder a la unica pregunta que se le hace:
    // que habia antes.
    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_PRINT_RUN_ADJUSTED',
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot: nuevo,
      delta: {
        printRun: { valorAnterior: anterior.printRun, valorNuevo: nuevo.printRun },
        availableUnits: {
          valorAnterior: anterior.availableUnits,
          valorNuevo: nuevo.availableUnits,
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
      eventType: 'catalog.product.inventory.adjusted',
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
      await this.deps.products.update(ajustado, actual.version, tx)
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
