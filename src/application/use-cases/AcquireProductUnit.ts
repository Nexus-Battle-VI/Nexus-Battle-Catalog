import { ProductId } from '../../domain/value-objects/canonical-product-values'
import {
  asStrictObject,
  parseString,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import { CanonicalProductNotFoundError, ProductSoldOutError } from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import {
  OutboxStatus,
  type CanonicalProductUnitOfWorkPort,
  type CanonicalProductWritePort,
  type OutboxEntry,
  type ProductAcquisitionPort,
  type ProductOutboxPort,
  type TransactionContext,
} from '../ports/CanonicalProductPorts'

export interface AcquireProductUnitDependencies {
  readonly products: CanonicalProductWritePort
  readonly acquisitions: ProductAcquisitionPort
  readonly clock: ClockPort
  readonly idGenerator: IdGeneratorPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly outbox?: ProductOutboxPort
}

export interface AcquisitionResult {
  readonly productId: string
  readonly acquisitionId: string
  readonly availableUnits: number | null
  readonly soldOut: boolean
  /** Cierto cuando esta llamada era un reintento ya procesado. */
  readonly replayed: boolean
}

/**
 * Consume una unidad de un producto (HU-34, CA-01 y CA-03).
 *
 * ES IDEMPOTENTE POR `acquisitionId`. Quien llama reintenta -un tiempo de
 * espera agotado con la peticion ya procesada al otro lado es lo normal-, y sin
 * idempotencia el reintento restaria una segunda unidad. Ese error no se ve:
 * nadie recibe un fallo, el producto simplemente se agota antes de lo que debia.
 *
 * DECREMENTO Y RESERVA VAN EN LA MISMA TRANSACCION, y por eso su orden no
 * decide la correccion: si cualquiera de los dos falla, no queda ninguno.
 * - Si la reserva choca, la adquisicion ya se proceso en otra ejecucion. Se
 *   aborta y se responde con el resultado REGISTRADO, no con la disponibilidad
 *   actual: dos respuestas a la misma peticion que se contradijeran serian peor
 *   que un error.
 * - Si el decremento no encuentra nada, la transaccion se aborta entera y la
 *   reserva no queda escrita: un producto agotado hoy puede adquirirse manana
 *   si el administrador amplia el tiraje, y ese identificador debe seguir
 *   siendo utilizable.
 *
 * En tiraje infinito NO se escribe en el producto -CA-03-, pero la reserva SI
 * se registra: es lo que permite responder igual ante un reintento.
 */
export class AcquireProductUnit {
  constructor(private readonly deps: AcquireProductUnitDependencies) {}

  async execute(rawProductId: string, rawCommand: unknown): Promise<AcquisitionResult> {
    const productId = await this.resolveProductId(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['acquisitionId', 'playerId'])
    const acquisitionId = ProductId.create(
      parseString(requiredValue(record, 'acquisitionId', 'command'), 'command.acquisitionId'),
    ).value
    const playerId = parseString(requiredValue(record, 'playerId', 'command'), 'command.playerId')

    const yaProcesada = await this.deps.acquisitions.findById(acquisitionId)

    if (yaProcesada !== null) {
      return {
        productId: yaProcesada.productId,
        acquisitionId,
        availableUnits: yaProcesada.availableUnits,
        soldOut: yaProcesada.availableUnits === 0,
        replayed: true,
      }
    }

    const trabajo = async (tx?: TransactionContext): Promise<AcquisitionResult> => {
      const decremento = await this.deps.products.decrementAvailability(productId, tx)

      if (decremento === null) {
        // No hay coincidencia. Distinguir «no existe» de «agotado» exige mirar,
        // porque las dos respuestas HTTP son distintas y confundirlas le diria
        // a quien llama algo falso sobre por que fallo.
        const producto = await this.deps.products.findById(productId)

        if (producto === null) {
          throw new CanonicalProductNotFoundError(productId.value)
        }

        throw new ProductSoldOutError(productId.value)
      }

      const now = this.deps.clock.now()
      const reservada = await this.deps.acquisitions.claim(
        {
          acquisitionId,
          productId: productId.value,
          playerId,
          availableUnits: decremento.availableUnits,
          at: now,
        },
        tx,
      )

      if (reservada === null) {
        // Otra ejecucion de la MISMA adquisicion gano la carrera entre la
        // consulta de arriba y esta escritura. Se aborta para no dejar el
        // decremento hecho dos veces; el reintento entrara por la rama de
        // reproduccion.
        throw new AcquisitionAlreadyClaimed()
      }

      if (decremento.depleted && this.deps.outbox) {
        const eventId = this.deps.idGenerator.generate()

        await this.deps.outbox.record(
          {
            eventId,
            aggregateId: productId.value,
            aggregateType: 'CanonicalProduct',
            eventType: 'catalog.product.stock.depleted',
            eventVersion: 1,
            status: OutboxStatus.Pending,
            payload: { productId: productId.value, availableUnits: 0 },
            createdAt: now,
            updatedAt: now,
            leaseExpiresAt: null,
            attempts: 0,
            lastError: null,
            dispatchedAt: null,
            purgeAt: null,
          } satisfies OutboxEntry,
          tx,
        )
      }

      return {
        productId: productId.value,
        acquisitionId,
        availableUnits: decremento.availableUnits,
        soldOut: decremento.depleted,
        replayed: false,
      }
    }

    try {
      return this.deps.unitOfWork
        ? await this.deps.unitOfWork.executeTransaction(trabajo)
        : await trabajo()
    } catch (error: unknown) {
      if (!(error instanceof AcquisitionAlreadyClaimed)) {
        throw error
      }

      const registrada = await this.deps.acquisitions.findById(acquisitionId)

      if (registrada === null) {
        throw error
      }

      return {
        productId: registrada.productId,
        acquisitionId,
        availableUnits: registrada.availableUnits,
        soldOut: registrada.availableUnits === 0,
        replayed: true,
      }
    }
  }

  /**
   * Acepta el identificador canonico o, si no lo es, el SKU.
   *
   * NO es una comodidad. Commerce identifica los productos por SKU y hoy no
   * tiene ninguna via para conocer el identificador canonico; sin esta
   * resolucion, el unico llamador real del contrato interno no podria usarlo.
   *
   * El orden importa y no es intercambiable: un UUID en minusculas TAMBIEN
   * encaja en el patron de SKU, asi que se comprueba primero la forma canonica.
   * Al reves, un identificador valido se buscaria como alias y no se
   * encontraria.
   *
   * `sku` esta marcado como deprecado en el contrato. Sustituir esto es trabajo
   * de ADR-006, que define la integracion entre contextos; queda dicho aqui
   * para que no se tome por permanente.
   */
  private async resolveProductId(raw: string): Promise<ProductId> {
    const valor = raw.trim()

    if (UUID.test(valor)) {
      return ProductId.create(valor)
    }

    const porSku = await this.deps.products.findBySku(valor)

    if (porSku === null) {
      throw new CanonicalProductNotFoundError(valor)
    }

    return porSku.productId
  }
}

/** Forma canónica de un identificador de producto. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Señal interna: la adquisición se reservó en otra ejecución simultánea. */
class AcquisitionAlreadyClaimed extends Error {
  constructor() {
    super('La adquisicion ya estaba reservada.')
    this.name = 'AcquisitionAlreadyClaimed'
  }
}
