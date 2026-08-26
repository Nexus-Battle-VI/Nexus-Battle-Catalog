import type { ProductSnapshot } from '../../domain/entities/Product'

export interface ProductDto {
  readonly sku: string
  readonly name: string
  readonly category: string
  readonly price: { readonly amount: number; readonly currency: string }
  readonly isPremium: boolean
  readonly realMoneyPrice: { readonly amount: number; readonly currency: string } | null
  readonly status: string
}

export const toProductDto = (snapshot: ProductSnapshot): ProductDto => ({
  sku: snapshot.sku,
  name: snapshot.name,
  category: snapshot.category,
  price: { amount: snapshot.priceAmount, currency: snapshot.priceCurrency },
  isPremium: snapshot.isPremium,
  realMoneyPrice:
    snapshot.realMoneyPriceAmount === null || snapshot.realMoneyPriceCurrency === null
      ? null
      : {
          amount: snapshot.realMoneyPriceAmount,
          currency: snapshot.realMoneyPriceCurrency,
        },
  status: snapshot.status,
})
