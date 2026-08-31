import type { ProductId, ProductType } from '../../domain/value-objects/canonical-product-values'
import type { ProductName, Sku } from '../../domain/value-objects/catalog-values'

/** Referencia contractual; no comparte el agregado Product con otros contextos. */
export interface ProductRef {
  readonly productId: string
  readonly sku: string
  readonly name?: string
  readonly type?: ProductType
}

export const toProductRef = (source: {
  productId: ProductId
  sku: Sku
  name?: ProductName
  type?: ProductType
}): ProductRef => ({
  productId: source.productId.value,
  sku: source.sku.value,
  ...(source.name === undefined ? {} : { name: source.name.value }),
  ...(source.type === undefined ? {} : { type: source.type }),
})
