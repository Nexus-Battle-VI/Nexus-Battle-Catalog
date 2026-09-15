import { ProductId } from '../../domain/value-objects/canonical-product-values'
import { CanonicalProductNotFoundError } from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { CanonicalProductWritePort } from '../ports/CanonicalProductPorts'

export interface RegisterProductRealMoneyPurchaseDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
}

/**
 * Registra que un producto tuvo una compra en moneda real (HU-36.6).
 *
 * Quien llama es el contrato interno `POST
 * /internal/v1/catalog/products/:id/premium-purchases` (ver
 * `InternalProductPremiumPurchaseController`): la peticion ya llego
 * autenticada por `InternalServiceGuard`, asi que este caso de uso no vuelve a
 * comprobar identidad.
 *
 * CATALOG NO GUARDA NINGUN DATO DE LA TRANSACCION -comprador, monto,
 * referencia-: eso es responsabilidad de Commerce. Esta operacion solo marca
 * `hasRealMoneyPurchase = true`, el unico dato que Catalog necesita para
 * sostener CA-03 (no se puede retirar premium con compras ya registradas).
 *
 * NO ES UN CONTADOR. Un reintento de la misma llamada dos veces produce el
 * mismo resultado, sin efecto adicional (mismo criterio que `UpdateProductRating`).
 */
export class RegisterProductRealMoneyPurchase {
  constructor(private readonly deps: RegisterProductRealMoneyPurchaseDependencies) {}

  async execute(rawProductId: string): Promise<void> {
    const productId = ProductId.create(rawProductId)

    const matched = await this.deps.products.markRealMoneyPurchase(productId, this.deps.clock.now())

    if (!matched) {
      throw new CanonicalProductNotFoundError(productId.value)
    }
  }
}
