export interface CreateUploadIntentInput {
  readonly purpose: string
  readonly contentType: string
  readonly contentLength: number
  readonly checksumSha256: string
}

export interface UploadIntentResponseDto {
  readonly assetId: string
  readonly upload: {
    readonly method: 'POST'
    readonly url: string
    readonly fields: Record<string, string>
    readonly expiresAt: string
  }
}

export interface FinalizedAssetDto {
  readonly assetId: string
  readonly purpose: string
  readonly status: string
  readonly contentType: string
  readonly contentLength: number
  readonly width: number
  readonly height: number
  readonly checksumSha256: string
  readonly imageUrl: string
}
