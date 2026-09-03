import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'
import type { ProductType } from '../../domain/value-objects/canonical-product-values'

export const STOREFRONT_PAGE_SIZE = 16

export interface CatalogStorefrontQuery {
  readonly query?: string
  readonly type?: ProductType
  readonly minPrice?: number
  readonly maxPrice?: number
  readonly currency?: string
  readonly page: number
}

export interface CatalogStorefrontPort {
  listStorefront(query: CatalogStorefrontQuery): Promise<{
    readonly items: readonly CanonicalProduct[]
    readonly total: number
  }>
}
