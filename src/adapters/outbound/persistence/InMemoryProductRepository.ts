import { Product } from '../../../domain/entities/Product'
import type { ProductSnapshot } from '../../../domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../../domain/value-objects/catalog-values'
import type {
  ProductQuery,
  ProductRepositoryPort,
} from '../../../application/ports/ProductRepositoryPort'

/**
 * Repositorio en memoria del agregado Product.
 *
 * Almacena instantaneas, no referencias al agregado, de modo que una mutacion
 * no persistida nunca se filtra al almacen.
 *
 * El adaptador definitivo sobre MongoDB queda sujeto a ADR-005.
 */
export class InMemoryProductRepository implements ProductRepositoryPort {
  private readonly bySku = new Map<string, ProductSnapshot>()

  save(product: Product): Promise<void> {
    this.bySku.set(product.sku.value, product.toSnapshot())

    return Promise.resolve()
  }

  findBySku(sku: Sku): Promise<Product | null> {
    const snapshot = this.bySku.get(sku.value)

    return Promise.resolve(
      snapshot === undefined ? null : InMemoryProductRepository.hydrate(snapshot),
    )
  }

  exists(sku: Sku): Promise<boolean> {
    return Promise.resolve(this.bySku.has(sku.value))
  }

  search(query: ProductQuery): Promise<readonly Product[]> {
    const found = [...this.bySku.values()]
      .map((snapshot) => InMemoryProductRepository.hydrate(snapshot))
      .filter((product) => (query.includeHidden ?? false) || product.isVisible)
      .filter(
        (product) => query.category === undefined || product.currentCategory.equals(query.category),
      )
      .sort((a, b) => a.sku.value.localeCompare(b.sku.value))

    return Promise.resolve(found)
  }

  get size(): number {
    return this.bySku.size
  }

  clear(): void {
    this.bySku.clear()
  }

  private static hydrate(snapshot: ProductSnapshot): Product {
    return Product.restore({
      sku: Sku.create(snapshot.sku),
      name: ProductName.create(snapshot.name),
      category: Category.create(snapshot.category),
      price: Money.create(snapshot.priceAmount, snapshot.priceCurrency),
      status: snapshot.status,
    })
  }
}
