import {
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import type { RegisterProductRealMoneyPurchase } from '../../../application/use-cases/RegisterProductRealMoneyPurchase'
import { REGISTER_PRODUCT_REAL_MONEY_PURCHASE } from './tokens'
import { InternalOnly, Public } from './auth/decorators'

/**
 * Contrato interno de registro de compra en moneda real (HU-36.6, CA-03).
 *
 * MISMO ESQUEMA QUE `InternalProductRatingController`: quien llama es otro
 * servicio -Commerce, dueño de las transacciones- y lo demuestra firmando con
 * HMAC (`@Public()` + `@InternalOnly()`), la ruta no se publica en el proxy y
 * queda fuera de la documentacion publica.
 *
 * SIN CUERPO A PROPOSITO. Catalog no necesita ningun dato de la transaccion
 * -comprador, monto, referencia-, solo el hecho de que ocurrio: el `id` de la
 * ruta ya identifica el producto. Guardar mas seria duplicar informacion
 * financiera que le pertenece a Commerce.
 *
 * SEPARADO de `InternalProductPremiumStatusController` a proposito: aquel es
 * un `GET` de solo lectura documentado explicitamente como "sin efecto
 * secundario"; mezclar aqui una mutacion habria contradicho esa garantia.
 */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalProductPremiumPurchaseController {
  constructor(
    @Inject(REGISTER_PRODUCT_REAL_MONEY_PURCHASE)
    private readonly registerProductRealMoneyPurchase: RegisterProductRealMoneyPurchase,
  ) {}

  @Public()
  @InternalOnly()
  @Post(':id/premium-purchases')
  @HttpCode(HttpStatus.OK)
  async registerPurchase(@Param('id') id: string): Promise<void> {
    try {
      await this.registerProductRealMoneyPurchase.execute(id)
    } catch (error: unknown) {
      throw InternalProductPremiumPurchaseController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof CanonicalProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
