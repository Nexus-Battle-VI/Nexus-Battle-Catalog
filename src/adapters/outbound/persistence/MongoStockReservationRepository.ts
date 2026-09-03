import {
  Long,
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type MongoClient,
} from 'mongodb'
import type {
  ReserveStockCommand,
  StockReservation,
  StockReservationPort,
  StockReservationResult,
} from '../../../application/ports/StockReservationPort'
import {
  assertReservationMatches,
  assertReservationTransition,
  reservationResult,
  StockReservationConflictError,
  StockReservationNotFoundError,
} from '../../../application/use-cases/StockReservations'
import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import type { CanonicalProductDocument } from './canonical-mapping'

interface ReservationDocument {
  readonly _id: string
  readonly playerId: string
  readonly lines: readonly { readonly productId: string; readonly quantity: Long }[]
  readonly state: StockReservation['state']
  readonly rejection?: StockReservation['rejection']
  readonly createdAt: Date
  readonly updatedAt: Date
}

const readRecord = (document: ReservationDocument): StockReservation => ({
  reservationId: document._id,
  playerId: document.playerId,
  state: document.state,
  lines: document.lines.map((line) => ({
    productId: line.productId,
    quantity: line.quantity.toNumber(),
  })),
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  ...(document.rejection === undefined ? {} : { rejection: document.rejection }),
})

/** Stock and operation identity share a Mongo transaction; process restarts preserve both. */
export class MongoStockReservationRepository implements StockReservationPort {
  private readonly records: Collection<ReservationDocument>
  private readonly products: Collection<CanonicalProductDocument>

  constructor(
    db: Db,
    private readonly client: MongoClient,
  ) {
    this.records = db.collection<ReservationDocument>('stock_reservations')
    this.products = db.collection<CanonicalProductDocument>('products')
  }

  private async transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession()
    try {
      return await session.withTransaction(() => work(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      })
    } finally {
      await session.endSession()
    }
  }

  async reserve(command: ReserveStockCommand, at: Date): Promise<StockReservationResult> {
    try {
      const outcome = await this.transaction(async (session) => {
        const previous = await this.records.findOne({ _id: command.reservationId }, { session })
        if (previous !== null) {
          const record = readRecord(previous)
          assertReservationMatches(record, command)
          return { record, replayed: true }
        }
        let rejection: StockReservation['rejection']
        const finiteLines: ReserveStockCommand['lines'][number][] = []
        for (const line of command.lines) {
          const current = await this.products.findOne(
            { _id: line.productId, type: { $exists: true } },
            { session },
          )
          if (current === null) {
            rejection = {
              kind: 'MISSING_PRODUCT',
              message: `El producto ${line.productId} no existe.`,
            }
            break
          }
          if (current.lifecycleStatus !== 'ACTIVE') {
            rejection = { kind: 'UNAVAILABLE', message: `Producto suspendido: ${line.productId}.` }
            break
          }
          if (current.printRunMode === 'INFINITE') continue
          if (
            current.availableUnits === null ||
            current.availableUnits.lessThan(Long.fromNumber(line.quantity))
          ) {
            rejection = {
              kind: 'UNAVAILABLE',
              message: `Unidades insuficientes: ${line.productId}.`,
            }
            break
          }
          finiteLines.push(line)
        }
        // Validate the complete snapshot before touching stock. Negative results
        // are durable too: a delayed retry cannot turn a rejected purchase into a
        // successful reservation after a restock.
        for (const line of rejection === undefined ? finiteLines : []) {
          const updated = await this.products.updateOne(
            {
              _id: line.productId,
              lifecycleStatus: 'ACTIVE',
              printRunMode: { $ne: 'INFINITE' },
              availableUnits: { $gte: Long.fromNumber(line.quantity) },
            },
            {
              $inc: {
                availableUnits: Long.fromNumber(-line.quantity),
                version: Long.fromNumber(1),
              },
              $set: { updatedAt: at },
            },
            { session },
          )
          if (updated.matchedCount !== 1)
            throw new Error('Stock changed during reservation; retry the same identity.')
        }
        const record: StockReservation = {
          ...command,
          state: rejection === undefined ? 'RESERVED' : 'REJECTED',
          ...(rejection === undefined ? {} : { rejection }),
          createdAt: at,
          updatedAt: at,
        }
        await this.records.insertOne(
          {
            _id: command.reservationId,
            playerId: command.playerId,
            lines: command.lines.map((line) => ({
              productId: line.productId,
              quantity: Long.fromNumber(line.quantity),
            })),
            state: record.state,
            ...(rejection === undefined ? {} : { rejection }),
            createdAt: at,
            updatedAt: at,
          },
          { session },
        )
        return { record, replayed: false }
      })
      // Throw only after the negative identity has committed successfully.
      return reservationResult(outcome.record, outcome.replayed)
    } catch (error: unknown) {
      // A concurrent transaction may have committed the same identity. Its
      // duplicate insert aborts this transaction, including every stock write.
      if (!(error instanceof MongoServerError) || error.code !== 11000) throw error
      const previous = await this.records.findOne({ _id: command.reservationId })
      if (previous === null) throw error
      const record = readRecord(previous)
      assertReservationMatches(record, command)
      return reservationResult(record, true)
    }
  }

  async transition(
    reservationId: string,
    playerId: string,
    state: 'CONFIRMED' | 'RELEASED',
    at: Date,
  ): Promise<StockReservationResult> {
    return this.transaction(async (session) => {
      const found = await this.records.findOne({ _id: reservationId }, { session })
      if (found === null) throw new StockReservationNotFoundError('No existe la reserva.')
      const record = readRecord(found)
      assertReservationTransition(record, playerId, state)
      if (record.state === state) return reservationResult(record, true)
      if (state === 'RELEASED') {
        for (const line of record.lines) {
          const product = await this.products.findOne(
            { _id: line.productId, type: { $exists: true } },
            { session },
          )
          if (product === null) throw new CanonicalProductNotFoundError(line.productId)
          // An administrator may have made the print run infinite since reserve.
          // It then has no counter to restore; finite->infinite is the supported conversion.
          if (product.printRunMode === 'INFINITE') continue
          const result = await this.products.updateOne(
            {
              _id: line.productId,
              printRunMode: { $ne: 'INFINITE' },
              $expr: {
                $lte: [{ $add: ['$availableUnits', Long.fromNumber(line.quantity)] }, '$printRun'],
              },
            },
            {
              $inc: { availableUnits: Long.fromNumber(line.quantity), version: Long.fromNumber(1) },
              $set: { updatedAt: at },
            },
            { session },
          )
          if (result.matchedCount !== 1)
            throw new StockReservationConflictError('La devolución no puede superar el tiraje.')
        }
      }
      await this.records.updateOne(
        { _id: reservationId, state: 'RESERVED' },
        { $set: { state, updatedAt: at } },
        { session },
      )
      return reservationResult({ ...record, state, updatedAt: at }, false)
    })
  }
}
