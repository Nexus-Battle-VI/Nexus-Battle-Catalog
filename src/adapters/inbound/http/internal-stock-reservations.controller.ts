import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import { DomainError } from '../../../domain/errors/DomainError'
import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import {
  StockReservations,
  StockReservationConflictError,
  StockReservationNotFoundError,
  StockReservationRejectedError,
} from '../../../application/use-cases/StockReservations'
import type { StockReservationResult } from '../../../application/ports/StockReservationPort'
import { InternalOnly, Public } from './auth/decorators'

@ApiExcludeController()
@Public()
@InternalOnly()
@Controller('internal/v1/catalog/reservations')
export class InternalStockReservationsController {
  constructor(@Inject(StockReservations) private readonly reservations: StockReservations) {}

  @Post()
  @HttpCode(200)
  reserve(@Body() body: unknown): Promise<StockReservationResult> {
    return this.execute(() => this.reservations.reserve(body))
  }

  @Post(':reservationId/confirmation')
  @HttpCode(200)
  confirm(
    @Param('reservationId') id: string,
    @Body() body: unknown,
  ): Promise<StockReservationResult> {
    return this.execute(() => this.reservations.transition(id, body, 'CONFIRMED'))
  }

  @Post(':reservationId/release')
  @HttpCode(200)
  release(
    @Param('reservationId') id: string,
    @Body() body: unknown,
  ): Promise<StockReservationResult> {
    return this.execute(() => this.reservations.transition(id, body, 'RELEASED'))
  }

  private async execute(
    work: () => Promise<StockReservationResult>,
  ): Promise<StockReservationResult> {
    try {
      return await work()
    } catch (error: unknown) {
      if (error instanceof DomainError) throw new BadRequestException(error.message)
      if (error instanceof StockReservationRejectedError)
        throw new ConflictException({ code: 'RESERVATION_REJECTED', message: error.message })
      if (error instanceof StockReservationConflictError)
        throw new ConflictException({ code: 'RESERVATION_CONFLICT', message: error.message })
      if (
        error instanceof StockReservationNotFoundError ||
        error instanceof CanonicalProductNotFoundError
      )
        throw new NotFoundException(error.message)
      throw new ServiceUnavailableException(
        'El almacén de reservas no está disponible. Reintente con la misma identidad de operación.',
      )
    }
  }
}
