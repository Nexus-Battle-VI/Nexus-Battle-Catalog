import type { ProductSnapshot } from '../../domain/entities/Product'

export interface ProductDto {
  readonly sku: string
  readonly name: string
  readonly category: string
  readonly price: { readonly amount: number; readonly currency: string }
  readonly status: string
}

export const toProductDto = (snapshot: ProductSnapshot): ProductDto => ({
  sku: snapshot.sku,
  name: snapshot.name,
  category: snapshot.category,
  price: { amount: snapshot.priceAmount, currency: snapshot.priceCurrency },
  status: snapshot.status,
})
