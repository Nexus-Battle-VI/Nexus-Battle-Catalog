import type { CanonicalProductSnapshot } from '../../domain/entities/CanonicalProduct'
import type { ProductAttributes } from '../../domain/value-objects/product-attributes'
import type {
  LifecycleStatus,
  PrintRunMode,
  ProductType,
} from '../../domain/value-objects/canonical-product-values'

export interface CanonicalProductDto {
  readonly productId: string
  readonly sku: string
  readonly name: string
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
}

export const toCanonicalProductDto = (snapshot: CanonicalProductSnapshot): CanonicalProductDto => ({
  productId: snapshot.productId,
  sku: snapshot.sku,
  name: snapshot.name,
  imageUrl: snapshot.imageUrl,
  description: snapshot.description,
  type: snapshot.type,
  attributes: snapshot.attributes,
  printRun: snapshot.printRun,
  printRunMode: snapshot.printRunMode,
  lifecycleStatus: snapshot.lifecycleStatus,
  creditsPrice: snapshot.creditsPrice,
  premium: snapshot.premium,
  realMoneyPrice: snapshot.realMoneyPrice,
  createdAt: snapshot.createdAt,
  updatedAt: snapshot.updatedAt,
})
