import { Long, MongoServerError, type ClientSession, type Collection, type Db } from 'mongodb'

import type {
  AcquisitionRecord,
  ProductAcquisitionPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'

interface AcquisitionDocument {
  readonly _id: string
  readonly productId: string
  readonly playerId: string
  readonly availableUnits?: Long | null
  readonly at: Date
}

/**
 * Registro de adquisiciones consumidas (HU-34).
 *
 * SE INTENTA INSERTAR Y EL CHOQUE ES LA RESPUESTA. `_id` es el identificador de
 * adquisicion, asi que la unicidad la impone MongoDB. Consultar primero y
 * escribir despues dejaria abierta exactamente la ventana que este registro
 * viene a cerrar: dos reintentos simultaneos verian los dos que no existe.
 */
export class MongoProductAcquisitionRepository implements ProductAcquisitionPort {
  private readonly acquisitions: Collection<AcquisitionDocument>

  constructor(db: Db) {
    this.acquisitions = db.collection<AcquisitionDocument>('acquisitions')
  }

  async claim(
    record: AcquisitionRecord,
    context?: TransactionContext,
  ): Promise<AcquisitionRecord | null> {
    const session = context?.session ? (context.session as ClientSession) : undefined

    try {
      await this.acquisitions.insertOne(
        {
          _id: record.acquisitionId,
          productId: record.productId,
          playerId: record.playerId,
          availableUnits:
            record.availableUnits === null ? null : Long.fromNumber(record.availableUnits),
          at: record.at,
        },
        { session },
      )

      return record
    } catch (error: unknown) {
      if (error instanceof MongoServerError && error.code === 11000) {
        return null
      }

      throw error
    }
  }

  async findById(acquisitionId: string): Promise<AcquisitionRecord | null> {
    const document = await this.acquisitions.findOne({ _id: acquisitionId })

    return document === null ? null : toRecord(document)
  }
}

const toRecord = (document: AcquisitionDocument): AcquisitionRecord => ({
  acquisitionId: document._id,
  productId: document.productId,
  playerId: document.playerId,
  availableUnits:
    document.availableUnits === null || document.availableUnits === undefined
      ? null
      : Number(document.availableUnits.toString()),
  at: document.at,
})
