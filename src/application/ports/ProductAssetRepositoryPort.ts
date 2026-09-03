import type { ProductAsset } from '../../domain/entities/ProductAsset'

export interface ProductAssetRepositoryPort {
  save(asset: ProductAsset): Promise<void>
  findById(assetId: string): Promise<ProductAsset | null>
  findByStagingKey(stagingKey: string): Promise<ProductAsset | null>
  findByTargetKey(targetKey: string): Promise<ProductAsset | null>
  update(asset: ProductAsset): Promise<void>
  findExpiredPendingIntents(before: Date): Promise<ProductAsset[]>
  findUnassociatedReadyAssets(before: Date): Promise<ProductAsset[]>
  associateProduct(assetId: string, productId: string): Promise<void>
}
