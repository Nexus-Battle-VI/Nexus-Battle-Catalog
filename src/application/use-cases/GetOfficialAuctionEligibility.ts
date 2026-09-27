import { LifecycleStatus, PrintRunMode } from '../../domain/value-objects/canonical-product-values'
import type { GetCanonicalProduct } from './GetCanonicalProduct'

export enum OfficialAuctionMark {
  Official = 'OFFICIAL',
  Premium = 'PREMIUM',
}

export interface OfficialAuctionEligibility {
  readonly productId: string
  readonly exclusive: boolean
  readonly officialMark: OfficialAuctionMark | null
  readonly publishable: boolean
}

/** Proyeccion minima cuya clasificacion pertenece exclusivamente a Catalog. */
export class GetOfficialAuctionEligibility {
  constructor(private readonly getCanonicalProduct: GetCanonicalProduct) {}

  async execute(productId: string): Promise<OfficialAuctionEligibility> {
    const product = await this.getCanonicalProduct.execute(productId)
    const exclusive = product.printRunMode === PrintRunMode.Unique || product.premium
    const officialMark = !exclusive
      ? null
      : product.premium
        ? OfficialAuctionMark.Premium
        : OfficialAuctionMark.Official

    return {
      productId: product.productId,
      exclusive,
      officialMark,
      publishable: exclusive && product.lifecycleStatus === LifecycleStatus.Active,
    }
  }
}
