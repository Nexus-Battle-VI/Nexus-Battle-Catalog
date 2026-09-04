import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import type { GetCanonicalProduct } from '../../../application/use-cases/GetCanonicalProduct'
import { GET_CANONICAL_PRODUCT } from './tokens'
import { InternalOnly, Public } from './auth/decorators'

export interface ProductPremiumStatusResponse {
  readonly productId: string
  readonly premium: boolean
}

/**
 * Contrato interno de solo lectura del estado premium (HU-36.5).
 *
 * QUIEN LLAMA ES OTRO SERVICIO -Subasta, cuando exista- y lo demuestra
 * firmando la peticion con HMAC-SHA256, igual que
 * `InternalProductAcquisitionsController`. Es un `GET` sin efecto secundario
 * a proposito: HU-36.5 exige poder CONSULTAR la condicion premium antes de
 * permitir una reventa, no reservar ni mutar nada.
 *
 * ESTA RUTA NO SE PUBLICA EN EL PROXY, igual que el resto de `internal/*`.
 *
 * TODAVIA NO HAY NINGUN SERVICIO AUTORIZADO A LLAMARLA: `allowedServices` en
 * `AppModule` no incluye `auction` porque ese servicio no existe todavia.
 * Anadirlo es una decision explicita para cuando se coordine, igual que la
 * lista ya documenta para `commerce`.
 */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalProductPremiumStatusController {
  constructor(
    @Inject(GET_CANONICAL_PRODUCT) private readonly getCanonicalProduct: GetCanonicalProduct,
  ) {}

  @Public()
  @InternalOnly()
  @Get(':id/premium-status')
  async getPremiumStatus(@Param('id') id: string): Promise<ProductPremiumStatusResponse> {
    try {
      const producto = await this.getCanonicalProduct.execute(id)

      return { productId: producto.productId, premium: producto.premium }
    } catch (error: unknown) {
      if (error instanceof CanonicalProductNotFoundError) {
        throw new NotFoundException(error.message)
      }

      throw error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
    }
  }
}
