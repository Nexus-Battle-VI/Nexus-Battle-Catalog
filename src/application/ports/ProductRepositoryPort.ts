import type { Product } from '../../domain/entities/Product'
import type { Category, Sku } from '../../domain/value-objects/catalog-values'

export interface ProductQuery {
  readonly category?: Category
  /** Cuando es `true` devuelve tambien borradores y archivados. */
  readonly includeHidden?: boolean
}

/**
 * Puerto de persistencia del agregado Product.
 *
 * Catalog es propietario exclusivo de sus datos. Ningun otro servicio accede a
 * este almacen, ni directamente ni mediante claves foraneas: Commerce y
 * Player/Inventory referencian productos por SKU a traves de la API.
 *
 * El adaptador definitivo sobre MongoDB queda sujeto a ADR-005.
 */
export interface ProductRepositoryPort {
  save(product: Product): Promise<void>
  findBySku(sku: Sku): Promise<Product | null>
  exists(sku: Sku): Promise<boolean>
  search(query: ProductQuery): Promise<readonly Product[]>
}

export const PRODUCT_REPOSITORY = Symbol('ProductRepositoryPort')
