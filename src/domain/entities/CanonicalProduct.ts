import type { ProductAttributes } from '../value-objects/product-attributes'
import {
  LifecycleStatus,
  type CreditsPrice,
  type PrintRun,
  type ProductDescription,
  type ProductId,
  type ProductImageUrl,
  type ProductPricing,
  type ProductType,
  type PrintRunMode,
} from '../value-objects/canonical-product-values'
import type { Money, ProductName, Sku } from '../value-objects/catalog-values'

export interface CanonicalProductSnapshot {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly normalizedName: string
  readonly imageUrl: string
  readonly description: string
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: number
  readonly printRunMode: PrintRunMode
  readonly lifecycleStatus: LifecycleStatus
  readonly creditsPrice: number
  readonly premium: boolean
  readonly realMoneyPrice: { readonly amount: number; readonly currency: string } | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

/** Agregado canónico aditivo; el agregado heredado continúa operando por SKU. */
export class CanonicalProduct {
  readonly productId: ProductId
  readonly sku: Sku
  readonly name: ProductName
  readonly normalizedName: string
  readonly imageUrl: ProductImageUrl
  readonly description: ProductDescription
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: PrintRun
  readonly lifecycleStatus: LifecycleStatus
  readonly creditsPrice: CreditsPrice
  readonly premium: boolean
  readonly realMoneyPrice: Money | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number

  private constructor(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    pricing: ProductPricing
    createdAt: Date
    lifecycleStatus: LifecycleStatus
    updatedAt: Date
    version?: number
  }) {
    this.productId = params.productId
    this.sku = params.sku
    this.name = params.name
    this.normalizedName = normalizeProductName(params.name.value)
    this.imageUrl = params.imageUrl
    this.description = params.description
    this.type = params.type
    this.attributes = params.attributes
    this.printRun = params.printRun
    this.creditsPrice = params.pricing.creditsPrice
    this.premium = params.pricing.premium
    this.realMoneyPrice = params.pricing.realMoneyPrice
    this.lifecycleStatus = params.lifecycleStatus
    this.createdAt = new Date(params.createdAt)
    this.updatedAt = new Date(params.updatedAt)
    this.version = params.version ?? 0
  }

  static create(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    pricing: ProductPricing
    createdAt: Date
  }): CanonicalProduct {
    return new CanonicalProduct({
      ...params,
      lifecycleStatus: LifecycleStatus.Active,
      updatedAt: params.createdAt,
      version: 0,
    })
  }

  static restore(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    pricing: ProductPricing
    lifecycleStatus: LifecycleStatus
    createdAt: Date
    updatedAt: Date
    version?: number
  }): CanonicalProduct {
    return new CanonicalProduct(params)
  }

  toSnapshot(): CanonicalProductSnapshot {
    return {
      productId: this.productId.value,
      sku: this.sku.value,
      name: this.name.value,
      normalizedName: this.normalizedName,
      imageUrl: this.imageUrl.value,
      description: this.description.value,
      type: this.type,
      attributes: this.attributes,
      printRun: this.printRun.value,
      printRunMode: this.printRun.mode,
      lifecycleStatus: this.lifecycleStatus,
      creditsPrice: this.creditsPrice.value,
      premium: this.premium,
      realMoneyPrice:
        this.realMoneyPrice === null
          ? null
          : { amount: this.realMoneyPrice.amount, currency: this.realMoneyPrice.currency },
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      version: this.version,
    }
  }
}

export const normalizeProductName = (name: string): string =>
  name.normalize('NFKC').toLocaleLowerCase('es')
