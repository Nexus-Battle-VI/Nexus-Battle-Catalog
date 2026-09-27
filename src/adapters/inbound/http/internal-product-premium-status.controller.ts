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
 * QUIEN LLAMA es otro servicio -Commerce, Community o Auction (HU-62, desde
 * que ese servicio existe)- y lo demuestra firmando la peticion con
 * HMAC-SHA256, igual que `InternalProductAcquisitionsController`. Es un
 * `GET` sin efecto secundario a proposito: HU-36.5 exige poder CONSULTAR la
 * condicion premium antes de permitir una reventa, no reservar ni mutar
 * nada; `CatalogProductPolicyClient` de Auction la usa para decidir si un
 * producto es comerciable en subasta (HU-62).
 *
 * ESTA RUTA NO SE PUBLICA EN EL PROXY, igual que el resto de `internal/*`.
 *
 * Lista de llamadores EXPLICITA en la propia ruta -no la global de
 * `AppModule`- porque incluye `auction` sin abrirle el resto de rutas
 * `internal/*` que si comparten esa lista global (adquisiciones, compra
 * premium, valoraciones, reservas de stock).
 *
 * La MUTACION relacionada -registrar una compra en moneda real, HU-36.6- vive
 * en `InternalProductPremiumPurchaseController`, deliberadamente separada de
 * este controlador de solo lectura.
 */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalProductPremiumStatusController {
  constructor(
    @Inject(GET_CANONICAL_PRODUCT) private readonly getCanonicalProduct: GetCanonicalProduct,
  ) {}

  @Public()
  @InternalOnly('commerce', 'community', 'auction')
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
