import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'
import type { ProductType } from '../../domain/value-objects/canonical-product-values'

export const STOREFRONT_PAGE_SIZE = 16

export interface CatalogStorefrontQuery {
  readonly query?: string
  readonly type?: ProductType
  readonly minPrice?: number
  readonly maxPrice?: number
  readonly currency?: string
  /**
   * Filtra por la condición premium. Sin esto, la vitrina pagina sobre TODOS
   * los productos ACTIVE (incluidas habilidades/ítems no comercializables),
   * y el filtrado posterior en Web rompe la paginación: una página puede
   * llegar casi vacía si la mayoría de sus 16 productos no son premium.
   */
  readonly premium?: boolean
  readonly page: number
}

export interface CatalogStorefrontPort {
  listStorefront(query: CatalogStorefrontQuery): Promise<{
    readonly items: readonly CanonicalProduct[]
    readonly total: number
  }>
}
