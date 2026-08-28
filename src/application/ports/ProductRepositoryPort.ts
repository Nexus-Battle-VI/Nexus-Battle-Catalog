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
 * Hay dos adaptadores, y `PERSISTENCE_DRIVER` elige cual opera:
 * `MongoProductRepository` sobre MongoDB (ADR-012) y el de memoria.
 *
 * El de memoria NO es un resto del andamiaje: es el que permite que las pruebas
 * del dominio y de los casos de uso corran sin Docker. Ambos cumplen el mismo
 * contrato, incluido el de no filtrar al almacen una mutacion sin guardar.
 */
export interface ProductRepositoryPort {
  /** Crea el producto solo si el SKU no existe. Devuelve `false` ante conflicto. */
  create(product: Product): Promise<boolean>
  save(product: Product): Promise<void>
  findBySku(sku: Sku): Promise<Product | null>
  exists(sku: Sku): Promise<boolean>
  search(query: ProductQuery): Promise<readonly Product[]>
  /** Comprueba que el almacenamiento puede atender operaciones reales. */
  isAvailable(): Promise<boolean>
}

export const PRODUCT_REPOSITORY = Symbol('ProductRepositoryPort')
