import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
} from '../../../application/errors/ApplicationError'
import type { CanonicalProductRepositoryPort } from '../../../application/ports/CanonicalProductPorts'
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
}
