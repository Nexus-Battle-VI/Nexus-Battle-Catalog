import { DomainError } from '../errors/DomainError'

export const AssetPurpose = {
  PrimaryImage: 'PRIMARY_IMAGE',
} as const

export type AssetPurpose = (typeof AssetPurpose)[keyof typeof AssetPurpose]

export const AssetStatus = {
  Pending: 'PENDING',
  Ready: 'READY',
  Rejected: 'REJECTED',
  Expired: 'EXPIRED',
} as const

export type AssetStatus = (typeof AssetStatus)[keyof typeof AssetStatus]

export interface ProductAssetSnapshot {
  readonly assetId: string
  readonly purpose: AssetPurpose
  readonly status: AssetStatus
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

export class ProductAsset {
  readonly assetId: string
  readonly purpose: AssetPurpose
  private _status: AssetStatus
  readonly contentType: string
  readonly contentLength: number
  readonly checksumSha256: string
  readonly stagingKey: string
  private _targetKey?: string
  private _width?: number
  private _height?: number
  readonly imageUrl: string
  readonly createdAt: Date
  readonly expiresAt: Date
  private _finalizedAt?: Date
  private _productId?: string

  private constructor(params: ProductAssetSnapshot) {
    this.assetId = params.assetId
    this.purpose = params.purpose
    this._status = params.status
    this.contentType = params.contentType
    this.contentLength = params.contentLength
    this.checksumSha256 = params.checksumSha256
    this.stagingKey = params.stagingKey
    this._targetKey = params.targetKey
    this._width = params.width
    this._height = params.height
    this.imageUrl = params.imageUrl
    this.createdAt = params.createdAt
    this.expiresAt = params.expiresAt
    this._finalizedAt = params.finalizedAt
    this._productId = params.productId
  }

  static createPending(params: {
    assetId: string
    purpose: AssetPurpose
    contentType: string
    contentLength: number
    checksumSha256: string
    stagingKey: string
    imageUrl: string
    createdAt: Date
    expiresAt: Date
  }): ProductAsset {
    if (params.contentLength <= 0 || params.contentLength > 5 * 1024 * 1024) {
      throw new DomainError('El tamano del asset debe estar entre 1 byte y 5 MiB.')
    }

    const allowedMime = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedMime.includes(params.contentType)) {
      throw new DomainError(
        `Tipo MIME no permitido: "${params.contentType}". Se admiten: ${allowedMime.join(', ')}.`,
      )
    }

    return new ProductAsset({
      ...params,
      status: AssetStatus.Pending,
    })
  }

  static fromSnapshot(snapshot: ProductAssetSnapshot): ProductAsset {
    return new ProductAsset(snapshot)
  }

  get status(): AssetStatus {
    return this._status
  }

  get targetKey(): string | undefined {
    return this._targetKey
  }

  get width(): number | undefined {
    return this._width
  }

  get height(): number | undefined {
    return this._height
  }

  get finalizedAt(): Date | undefined {
    return this._finalizedAt
  }

  get productId(): string | undefined {
    return this._productId
  }

  isReady(): boolean {
    return this._status === AssetStatus.Ready
  }

  isExpired(now: Date): boolean {
    return (
      this._status === AssetStatus.Expired ||
      (this._status === AssetStatus.Pending && this.expiresAt.getTime() <= now.getTime())
    )
  }

  markFinalized(params: {
    targetKey: string
    width: number
    height: number
    finalizedAt: Date
  }): void {
    if (this._status === AssetStatus.Ready) {
      return
    }

    this._status = AssetStatus.Ready
    this._targetKey = params.targetKey
    this._width = params.width
    this._height = params.height
    this._finalizedAt = params.finalizedAt
  }

  markExpired(): void {
    if (this._status === AssetStatus.Pending) {
      this._status = AssetStatus.Expired
    }
  }

  associateProduct(productId: string): void {
    this._productId = productId
  }

  toSnapshot(): ProductAssetSnapshot {
    return {
      assetId: this.assetId,
      purpose: this.purpose,
      status: this._status,
      contentType: this.contentType,
      contentLength: this.contentLength,
      checksumSha256: this.checksumSha256,
      stagingKey: this.stagingKey,
      targetKey: this._targetKey,
      width: this._width,
      height: this._height,
      imageUrl: this.imageUrl,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      finalizedAt: this._finalizedAt,
      productId: this._productId,
    }
  }
}
