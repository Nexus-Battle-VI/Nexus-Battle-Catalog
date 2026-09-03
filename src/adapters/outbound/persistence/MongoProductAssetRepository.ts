import type { Collection, Db } from 'mongodb'
import {
  ProductAsset,
  type AssetPurpose,
  type AssetStatus,
  type ProductAssetSnapshot,
} from '../../../domain/entities/ProductAsset'
import type { ProductAssetRepositoryPort } from '../../../application/ports/ProductAssetRepositoryPort'

export interface ProductAssetDocument {
  readonly _id: string
  readonly assetId: string
  readonly purpose: string
  readonly status: string
  readonly contentType: string
  readonly contentLength: number
  readonly checksumSha256: string
  readonly stagingKey: string
  readonly targetKey?: string
  readonly width?: number
  readonly height?: number
  readonly imageUrl: string
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly finalizedAt?: Date
  readonly productId?: string
}

export class MongoProductAssetRepository implements ProductAssetRepositoryPort {
  private readonly collection: Collection<ProductAssetDocument>

  constructor(db: Db) {
    this.collection = db.collection<ProductAssetDocument>('product_assets')
  }

  async save(asset: ProductAsset): Promise<void> {
    const doc = this.toDocument(asset.toSnapshot())
    await this.collection.insertOne(doc)
  }

  async findById(assetId: string): Promise<ProductAsset | null> {
    const doc = await this.collection.findOne({ _id: assetId })
    if (!doc) {
      return null
    }
    return this.toEntity(doc)
  }

  async findByStagingKey(stagingKey: string): Promise<ProductAsset | null> {
    const doc = await this.collection.findOne({ stagingKey })
    if (!doc) {
      return null
    }
    return this.toEntity(doc)
  }

  async findByTargetKey(targetKey: string): Promise<ProductAsset | null> {
    const doc = await this.collection.findOne({ targetKey })
    if (!doc) {
      return null
    }
    return this.toEntity(doc)
  }

  async update(asset: ProductAsset): Promise<void> {
    const doc = this.toDocument(asset.toSnapshot())
    await this.collection.replaceOne({ _id: asset.assetId }, doc)
  }

  async findExpiredPendingIntents(before: Date): Promise<ProductAsset[]> {
    const docs = await this.collection
      .find({
        status: 'PENDING',
        expiresAt: { $lte: before },
      })
      .toArray()

    return docs.map((doc) => this.toEntity(doc))
  }

  async findUnassociatedReadyAssets(before: Date): Promise<ProductAsset[]> {
    const docs = await this.collection
      .find({
        status: 'READY',
        productId: { $exists: false },
        finalizedAt: { $lte: before },
      })
      .toArray()

    return docs.map((doc) => this.toEntity(doc))
  }

  async associateProduct(assetId: string, productId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: assetId },
      {
        $set: { productId },
      },
    )
  }

  private toDocument(snap: ProductAssetSnapshot): ProductAssetDocument {
    return {
      _id: snap.assetId,
      assetId: snap.assetId,
      purpose: snap.purpose,
      status: snap.status,
      contentType: snap.contentType,
      contentLength: snap.contentLength,
      checksumSha256: snap.checksumSha256,
      stagingKey: snap.stagingKey,
      targetKey: snap.targetKey,
      width: snap.width,
      height: snap.height,
      imageUrl: snap.imageUrl,
      createdAt: snap.createdAt,
      expiresAt: snap.expiresAt,
      finalizedAt: snap.finalizedAt,
      productId: snap.productId,
    }
  }

  private toEntity(doc: ProductAssetDocument): ProductAsset {
    return ProductAsset.fromSnapshot({
      assetId: doc.assetId,
      purpose: doc.purpose as AssetPurpose,
      status: doc.status as AssetStatus,
      contentType: doc.contentType,
      contentLength: doc.contentLength,
      checksumSha256: doc.checksumSha256,
      stagingKey: doc.stagingKey,
      targetKey: doc.targetKey,
      width: doc.width,
      height: doc.height,
      imageUrl: doc.imageUrl,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
      finalizedAt: doc.finalizedAt,
      productId: doc.productId,
    })
  }
}
