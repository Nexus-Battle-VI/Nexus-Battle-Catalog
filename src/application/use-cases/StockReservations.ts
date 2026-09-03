import { DomainError } from '../../domain/errors/DomainError'
import { ProductId } from '../../domain/value-objects/canonical-product-values'
import {
  asStrictObject,
  parseInteger,
  parseString,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import type { ClockPort } from '../ports/ClockPort'
import type {
  ReserveStockCommand,
  StockReservation,
  StockReservationPort,
  StockReservationResult,
} from '../ports/StockReservationPort'

export class StockReservationConflictError extends Error {}
export class StockReservationRejectedError extends Error {}
export class StockReservationNotFoundError extends Error {}

export const reservationResult = (
  record: StockReservation,
  replayed: boolean,
): StockReservationResult => {
  if (record.state === 'REJECTED') {
    const message = record.rejection?.message ?? 'Reserva rechazada.'
    if (record.rejection?.kind === 'MISSING_PRODUCT')
      throw new StockReservationNotFoundError(message)
    throw new StockReservationRejectedError(message)
  }
  return {
    reservationId: record.reservationId,
    playerId: record.playerId,
    lines: record.lines.map((line) => ({ ...line })),
    state: record.state,
    replayed,
  }
}

export const assertReservationMatches = (
  record: StockReservation,
  command: ReserveStockCommand,
): void => {
  if (
    record.playerId !== command.playerId ||
    JSON.stringify(record.lines) !== JSON.stringify(command.lines)
  ) {
    throw new StockReservationConflictError(
      'reservationId ya identifica otra operación, jugador o conjunto de productos.',
    )
  }
}

export const assertReservationTransition = (
  record: StockReservation,
  playerId: string,
  state: 'CONFIRMED' | 'RELEASED',
): void => {
  if (record.playerId !== playerId)
    throw new StockReservationConflictError('La reserva pertenece a otro jugador.')
  if (record.state !== 'RESERVED' && record.state !== state) {
    throw new StockReservationConflictError(
      `No se puede pasar una reserva ${record.state} a ${state}.`,
    )
  }
}

const player = (raw: unknown): string => {
  const value = parseString(raw, 'playerId').trim()
  if (value === '') throw new DomainError('playerId es obligatorio.')
  return value
}

export class StockReservations {
  constructor(
    private readonly reservations: StockReservationPort,
    private readonly clock: ClockPort,
  ) {}

  reserve(raw: unknown): Promise<StockReservationResult> {
    const command = asStrictObject(raw, 'command', ['reservationId', 'playerId', 'lines'])
    const reservationId = ProductId.create(
      parseString(requiredValue(command, 'reservationId', 'command'), 'reservationId'),
    ).value
    const playerId = player(requiredValue(command, 'playerId', 'command'))
    const rawLines = requiredValue(command, 'lines', 'command')
    if (!Array.isArray(rawLines) || rawLines.length === 0)
      throw new DomainError('lines debe ser una lista no vacía.')
    const seen = new Set<string>()
    const lines = rawLines
      .map((rawLine: unknown) => {
        const line = asStrictObject(rawLine, 'line', ['productId', 'quantity'])
        const productId = ProductId.create(
          parseString(requiredValue(line, 'productId', 'line'), 'productId'),
        ).value
        const quantity = parseInteger(requiredValue(line, 'quantity', 'line'), 'quantity')
        if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 9999)
          throw new DomainError('quantity debe estar entre 1 y 9999, igual que el inventario.')
        if (seen.has(productId))
          throw new DomainError('Cada productId debe aparecer una sola vez en lines.')
        seen.add(productId)
        return { productId, quantity }
      })
      .sort((a, b) => a.productId.localeCompare(b.productId))
    return this.reservations.reserve({ reservationId, playerId, lines }, this.clock.now())
  }

  transition(
    rawId: string,
    raw: unknown,
    state: 'CONFIRMED' | 'RELEASED',
  ): Promise<StockReservationResult> {
    const reservationId = ProductId.create(rawId).value
    const command = asStrictObject(raw, 'command', ['playerId'])
    return this.reservations.transition(
      reservationId,
      player(requiredValue(command, 'playerId', 'command')),
      state,
      this.clock.now(),
    )
  }
}
