import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import type { UpdateProductRating } from '../../../application/use-cases/UpdateProductRating'
import { UPDATE_PRODUCT_RATING } from './tokens'
import { InternalOnly, Public } from './auth/decorators'
import { UpdateProductRatingRequest } from './internal-product-rating.dto'

/**
 * Contrato interno de calificación (HU-40, CA-03).
 *
 * MISMO ESQUEMA QUE `InternalProductAcquisitionsController`: quien llama es
 * otro servicio -Community, dueño de las calificaciones- y lo demuestra
 * firmando con HMAC (`@Public()` + `@InternalOnly()`), la ruta no se publica
 * en el proxy y queda fuera de la documentación pública.
 *
 * CATALOG NO CALCULA NADA AQUÍ. El promedio y el conteo ya vienen calculados
 * por Community sobre sus propias calificaciones; este endpoint solo los
 * conserva junto al producto canónico para que el catálogo pueda mostrarlos
 * sin una llamada a Community por cada lectura.
 */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalProductRatingController {
  constructor(
    @Inject(UPDATE_PRODUCT_RATING) private readonly updateProductRating: UpdateProductRating,
  ) {}

  @Public()
  @InternalOnly()
  @Post(':id/rating')
  @HttpCode(HttpStatus.OK)
  async updateRating(
    @Param('id') id: string,
    @Body() body: UpdateProductRatingRequest,
  ): Promise<void> {
    try {
      await this.updateProductRating.execute(id, body)
    } catch (error: unknown) {
      throw InternalProductRatingController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof CanonicalProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
