import {
  BadRequestException,
  Body,
  ConflictException,
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
import {
  CanonicalProductNotFoundError,
  ProductSoldOutError,
} from '../../../application/errors/ApplicationError'
import type {
  AcquireProductUnit,
  AcquisitionResult,
} from '../../../application/use-cases/AcquireProductUnit'
import { ACQUIRE_PRODUCT_UNIT } from './tokens'
import { InternalOnly, Public } from './auth/decorators'
import { AcquireUnitRequest } from './internal-product-acquisitions.dto'

/**
 * Contrato interno de adquisición (HU-34).
 *
 * QUIEN LLAMA ES OTRO SERVICIO -Commerce hoy, Subasta despues- y lo demuestra
 * firmando la peticion con HMAC-SHA256. No hay usuario que autenticar, de ahi
 * `@Public()`; la proteccion la pone `@InternalOnly()`.
 *
 * ESTA RUTA NO SE PUBLICA EN EL PROXY. El `Caddyfile` lleva una lista explicita
 * de prefijos bajo `/api` y `internal` no esta en ella, asi que no es
 * alcanzable desde internet. Eso es una segunda linea: la firma protege igual
 * si alguien anadiera la ruta sin darse cuenta.
 *
 * QUEDA FUERA DE LA DOCUMENTACION PUBLICA (`@ApiExcludeController`). Publicar
 * un endpoint que nadie de fuera puede usar solo invita a intentarlo.
 *
 * EL DECREMENTO ES EXCLUSIVO DE CATALOG. Ningun otro servicio escribe sobre la
 * disponibilidad; la piden por aqui.
 */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalProductAcquisitionsController {
  constructor(
    @Inject(ACQUIRE_PRODUCT_UNIT) private readonly acquireProductUnit: AcquireProductUnit,
  ) {}

  @Public()
  @InternalOnly()
  @Post(':id/acquisitions')
  @HttpCode(HttpStatus.OK)
  async acquire(
    @Param('id') id: string,
    @Body() body: AcquireUnitRequest,
  ): Promise<AcquisitionResult> {
    try {
      return await this.acquireProductUnit.execute(id, body)
    } catch (error: unknown) {
      throw InternalProductAcquisitionsController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof CanonicalProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    // Agotado es 409 y no 422: la peticion es correcta y lo que falla es el
    // ESTADO del producto. La misma peticion habria funcionado un segundo antes
    // y volvera a funcionar si el administrador amplia el tiraje.
    if (error instanceof ProductSoldOutError) {
      return new ConflictException(error.message)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
