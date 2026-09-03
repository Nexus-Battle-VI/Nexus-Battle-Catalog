import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
} from '../../../application/errors/ApplicationError'
import type {
  AvailabilityDecrement,
  CanonicalProductRepositoryPort,
} from '../../../application/ports/CanonicalProductPorts'
import type { CanonicalProduct } from '../../../domain/entities/CanonicalProduct'
import type { ProductId, ProductType } from '../../../domain/value-objects/canonical-product-values'

/**
 * Almacén canónico en proceso para desarrollo y pruebas HTTP.
 *
 * Mantiene los mismos conflictos que Mongo para que la ruta canónica no tenga
 * un comportamiento distinto al cambiar de driver.
 */
export class InMemoryCanonicalProductRepository implements CanonicalProductRepositoryPort {
  private readonly byId = new Map<string, CanonicalProduct>()
  private readonly bySku = new Map<string, string>()

  existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean> {
    return Promise.resolve(
      [...this.byId.values()].some(
        (product) =>
          product.normalizedName === normalizedName &&
          product.type === type &&
          product.lifecycleStatus === 'ACTIVE',
      ),
    )
  }

  create(product: CanonicalProduct): Promise<void> {
    if (this.byId.has(product.productId.value)) {
      return Promise.reject(new CanonicalProductIdentityAlreadyExistsError(product.productId.value))
    }

    if (this.bySku.has(product.sku.value)) {
      return Promise.reject(new CanonicalProductSkuAlreadyExistsError(product.sku.value))
    }

    if (
      [...this.byId.values()].some(
        (current) =>
          current.normalizedName === product.normalizedName &&
          current.type === product.type &&
          current.lifecycleStatus === 'ACTIVE',
      )
    ) {
      return Promise.reject(
        new CanonicalProductAlreadyExistsError(product.name.value, product.type),
      )
    }

    this.byId.set(product.productId.value, product)
    this.bySku.set(product.sku.value, product.productId.value)

    return Promise.resolve()
  }

  update(product: CanonicalProduct, expectedVersion: number): Promise<void> {
    const existing = this.byId.get(product.productId.value)
    if (existing?.version !== expectedVersion) {
      return Promise.reject(
        new CanonicalProductConcurrencyConflictError(product.productId.value, expectedVersion),
      )
    }

    this.byId.set(product.productId.value, product)
    return Promise.resolve()
  }

  findTypeById(productId: ProductId): Promise<ProductType | null> {
    return Promise.resolve(this.byId.get(productId.value)?.type ?? null)
  }

  findById(productId: ProductId): Promise<CanonicalProduct | null> {
    return Promise.resolve(this.byId.get(productId.value) ?? null)
  }

  findBySku(sku: string): Promise<CanonicalProduct | null> {
    const id = this.bySku.get(sku)

    return Promise.resolve(id === undefined ? null : (this.byId.get(id) ?? null))
  }

  /**
   * Decremento sin condicion real: este almacen es de un solo proceso.
   *
   * NO reproduce la garantia de MongoDB y no debe usarse para razonar sobre
   * concurrencia. La prueba que responde a CA-01 corre contra un MongoDB de
   * verdad, no contra esto.
   */
  decrementAvailability(productId: ProductId): Promise<AvailabilityDecrement | null> {
    const current = this.byId.get(productId.value)

    if (current === undefined || current.isSoldOut) {
      return Promise.resolve(null)
    }

    const consumido = current.consumeUnit(new Date())
    this.byId.set(productId.value, consumido)

    return Promise.resolve({
      availableUnits: consumido.availableUnits,
      depleted: consumido.isSoldOut,
    })
  }
}
