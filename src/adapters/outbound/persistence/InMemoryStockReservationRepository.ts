import type { InMemoryCanonicalProductRepository } from './InMemoryCanonicalProductRepository'
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
  StockReservationNotFoundError,
  StockReservationRejectedError,
} from '../../../application/use-cases/StockReservations'
import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'

/** Synchronous batch validation + commit, without await between stock and record. */
export class InMemoryStockReservationRepository implements StockReservationPort {
  private readonly records = new Map<string, StockReservation>()
  constructor(private readonly products: InMemoryCanonicalProductRepository) {}

  reserve(command: ReserveStockCommand, at: Date): Promise<StockReservationResult> {
    return Promise.resolve().then(() => this.reserveSynchronously(command, at))
  }

  private reserveSynchronously(command: ReserveStockCommand, at: Date): StockReservationResult {
    const previous = this.records.get(command.reservationId)
    if (previous !== undefined) {
      assertReservationMatches(previous, command)
      return reservationResult(previous, true)
    }
    let rejection: StockReservation['rejection']
    try {
      this.products.changeReservedStock(command.lines, 'RESERVE', at)
    } catch (error: unknown) {
      if (
        !(error instanceof StockReservationRejectedError) &&
        !(error instanceof CanonicalProductNotFoundError)
      )
        throw error
      rejection = {
        kind: error instanceof CanonicalProductNotFoundError ? 'MISSING_PRODUCT' : 'UNAVAILABLE',
        message: error.message,
      }
    }
    const record: StockReservation = {
      ...command,
      lines: command.lines.map((line) => ({ ...line })),
      state: rejection === undefined ? 'RESERVED' : 'REJECTED',
      ...(rejection === undefined ? {} : { rejection }),
      createdAt: at,
      updatedAt: at,
    }
    this.records.set(command.reservationId, record)
    return reservationResult(record, false)
  }

  transition(
    reservationId: string,
    playerId: string,
    state: 'CONFIRMED' | 'RELEASED',
    at: Date,
  ): Promise<StockReservationResult> {
    return Promise.resolve().then(() =>
      this.transitionSynchronously(reservationId, playerId, state, at),
    )
  }

  private transitionSynchronously(
    reservationId: string,
    playerId: string,
    state: 'CONFIRMED' | 'RELEASED',
    at: Date,
  ): StockReservationResult {
    const record = this.records.get(reservationId)
    if (record === undefined) throw new StockReservationNotFoundError('No existe la reserva.')
    assertReservationTransition(record, playerId, state)
    if (record.state === state) return reservationResult(record, true)
    if (state === 'RELEASED') this.products.changeReservedStock(record.lines, 'RELEASE', at)
    const updated = { ...record, state, updatedAt: at }
    this.records.set(reservationId, updated)
    return reservationResult(updated, false)
  }
}
