import { ProductAsset, type ProductAssetSnapshot } from '../../../domain/entities/ProductAsset'
import type { ProductAssetRepositoryPort } from '../../../application/ports/ProductAssetRepositoryPort'

export class InMemoryProductAssetRepository implements ProductAssetRepositoryPort {
  private readonly assets = new Map<string, ProductAssetSnapshot>()

  save(asset: ProductAsset): Promise<void> {
    this.assets.set(asset.assetId, asset.toSnapshot())
    return Promise.resolve()
  }

  findById(assetId: string): Promise<ProductAsset | null> {
    const snap = this.assets.get(assetId)
    if (!snap) {
      return Promise.resolve(null)
    }
    return Promise.resolve(ProductAsset.fromSnapshot(snap))
  }

  findByStagingKey(stagingKey: string): Promise<ProductAsset | null> {
    for (const snap of this.assets.values()) {
      if (snap.stagingKey === stagingKey) {
        return Promise.resolve(ProductAsset.fromSnapshot(snap))
      }
    }
    return Promise.resolve(null)
  }

  findByTargetKey(targetKey: string): Promise<ProductAsset | null> {
    for (const snap of this.assets.values()) {
      if (snap.targetKey === targetKey) {
        return Promise.resolve(ProductAsset.fromSnapshot(snap))
      }
    }
    return Promise.resolve(null)
  }

  update(asset: ProductAsset): Promise<void> {
    this.assets.set(asset.assetId, asset.toSnapshot())
    return Promise.resolve()
  }

  findExpiredPendingIntents(before: Date): Promise<ProductAsset[]> {
    const results: ProductAsset[] = []
    for (const snap of this.assets.values()) {
      if (snap.status === 'PENDING' && snap.expiresAt.getTime() <= before.getTime()) {
        results.push(ProductAsset.fromSnapshot(snap))
      }
    }
    return Promise.resolve(results)
  }

  findUnassociatedReadyAssets(before: Date): Promise<ProductAsset[]> {
    const results: ProductAsset[] = []
    for (const snap of this.assets.values()) {
      if (
        snap.status === 'READY' &&
        !snap.productId &&
        snap.finalizedAt &&
        snap.finalizedAt.getTime() <= before.getTime()
      ) {
        results.push(ProductAsset.fromSnapshot(snap))
      }
    }
    return Promise.resolve(results)
  }

  associateProduct(assetId: string, productId: string): Promise<void> {
    const snap = this.assets.get(assetId)
    if (snap) {
      this.assets.set(assetId, {
        ...snap,
        productId,
      })
    }
    return Promise.resolve()
  }

  // Helper de pruebas
  clear(): void {
    this.assets.clear()
  }
}
