import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
  CanonicalProductNotFoundError,
} from '../../../application/errors/ApplicationError'
import type {
  AvailabilityDecrement,
  CanonicalProductLookupQuery,
  CanonicalProductRepositoryPort,
} from '../../../application/ports/CanonicalProductPorts'
import { normalizeProductName } from '../../../domain/entities/CanonicalProduct'
import type { CanonicalProduct } from '../../../domain/entities/CanonicalProduct'
import type { ProductId, ProductType } from '../../../domain/value-objects/canonical-product-values'
import {
  STOREFRONT_PAGE_SIZE,
  type CatalogStorefrontPort,
  type CatalogStorefrontQuery,
} from '../../../application/ports/CatalogStorefrontPort'
import { storefrontMatches } from '../../../domain/services/storefront-search'
import type { StockReservationLine } from '../../../application/ports/StockReservationPort'
import { StockReservationRejectedError } from '../../../application/use-cases/StockReservations'

/**
 * Almacén canónico en proceso para desarrollo y pruebas HTTP.
 *
 * Mantiene los mismos conflictos que Mongo para que la ruta canónica no tenga
 * un comportamiento distinto al cambiar de driver.
 */
export class InMemoryCanonicalProductRepository
  implements CanonicalProductRepositoryPort, CatalogStorefrontPort
{
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

  findByReference(reference: string): Promise<CanonicalProduct | null> {
    const direct = this.byId.get(reference)
    if (direct !== undefined) {
      return Promise.resolve(direct)
    }

    const idFromSku = this.bySku.get(reference)
    return Promise.resolve(idFromSku === undefined ? null : (this.byId.get(idFromSku) ?? null))
  }

  findByReferences(query: CanonicalProductLookupQuery): Promise<readonly CanonicalProduct[]> {
    const wanted = new Set(query.references)
    const normalizedQuery =
      query.nameQuery === undefined ? undefined : normalizeProductName(query.nameQuery)

    const items = [...this.byId.values()]
      .filter((product) => {
        if (!wanted.has(product.productId.value) && !wanted.has(product.sku.value)) {
          return false
        }
        if (query.type !== undefined && product.type !== query.type) {
          return false
        }
        if (normalizedQuery !== undefined && !product.normalizedName.includes(normalizedQuery)) {
          return false
        }
        return true
      })
      .sort((left, right) => left.name.value.localeCompare(right.name.value))

    return Promise.resolve(items)
  }

  findById(productId: ProductId): Promise<CanonicalProduct | null> {
    return Promise.resolve(this.byId.get(productId.value) ?? null)
  }

  listStorefront(
    query: CatalogStorefrontQuery,
  ): Promise<{ items: readonly CanonicalProduct[]; total: number }> {
    const matching = [...this.byId.values()]
      .filter((product) => {
        if (product.lifecycleStatus !== 'ACTIVE') return false
        if (query.type !== undefined && product.type !== query.type) return false
        const price = product.realMoneyPrice
        if (query.currency !== undefined && price?.currency !== query.currency) return false
        if (query.minPrice !== undefined && (price === null || price.amount < query.minPrice))
          return false
        if (query.maxPrice !== undefined && (price === null || price.amount > query.maxPrice))
          return false
        return storefrontMatches(product.toSnapshot(), query.query)
      })
      .sort((a, b) =>
        a.normalizedName < b.normalizedName
          ? -1
          : a.normalizedName > b.normalizedName
            ? 1
            : a.productId.value.localeCompare(b.productId.value),
      )
    const offset = (query.page - 1) * STOREFRONT_PAGE_SIZE
    return Promise.resolve({
      items: matching.slice(offset, offset + STOREFRONT_PAGE_SIZE),
      total: matching.length,
    })
  }

  changeReservedStock(
    lines: readonly StockReservationLine[],
    action: 'RESERVE' | 'RELEASE',
    at: Date,
  ): void {
    const changes = lines.map((line) => {
      const current = this.byId.get(line.productId)
      if (current === undefined) throw new CanonicalProductNotFoundError(line.productId)
      if (
        action === 'RESERVE' &&
        (current.lifecycleStatus !== 'ACTIVE' ||
          (current.availableUnits !== null && current.availableUnits < line.quantity))
      ) {
        throw new StockReservationRejectedError(
          `Producto suspendido o sin unidades suficientes: ${line.productId}.`,
        )
      }
      return action === 'RESERVE'
        ? current.reserveUnits(line.quantity, at)
        : current.releaseUnits(line.quantity, at)
    })
    // Commit only after every line has been validated; never expose a partial batch.
    for (const product of changes) this.byId.set(product.productId.value, product)
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

    if (current === undefined || current.isSoldOut || current.lifecycleStatus !== 'ACTIVE') {
      return Promise.resolve(null)
    }

    const consumido = current.consumeUnit(new Date())
    this.byId.set(productId.value, consumido)

    return Promise.resolve({
      availableUnits: consumido.availableUnits,
      depleted: consumido.isSoldOut,
    })
  }

  /** Mismo comportamiento que la version de Mongo, sin condicion real: un solo proceso. */
  updateRating(
    productId: ProductId,
    rating: { averageRating: number | null; reviewCount: number },
    at: Date,
  ): Promise<boolean> {
    const current = this.byId.get(productId.value)

    if (current === undefined) {
      return Promise.resolve(false)
    }

    this.byId.set(productId.value, current.withRating(rating, at))
    return Promise.resolve(true)
  }
}
