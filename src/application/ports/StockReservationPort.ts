export type StockReservationState = 'RESERVED' | 'CONFIRMED' | 'RELEASED'

export interface StockReservationLine {
  readonly productId: string
  readonly quantity: number
}

export interface ReserveStockCommand {
  readonly reservationId: string
  readonly playerId: string
  readonly lines: readonly StockReservationLine[]
}

export interface StockReservation extends ReserveStockCommand {
  readonly state: StockReservationState | 'REJECTED'
  readonly rejection?: {
    readonly kind: 'MISSING_PRODUCT' | 'UNAVAILABLE'
    readonly message: string
  }
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface StockReservationResult extends ReserveStockCommand {
  readonly state: StockReservationState
  readonly replayed: boolean
}

/** Each operation is atomic across the reservation and every affected product. */
export interface StockReservationPort {
  reserve(command: ReserveStockCommand, at: Date): Promise<StockReservationResult>
  transition(
    reservationId: string,
    playerId: string,
    state: 'CONFIRMED' | 'RELEASED',
    at: Date,
  ): Promise<StockReservationResult>
}

export const STOCK_RESERVATIONS = Symbol('StockReservations')
