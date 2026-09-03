import { AssetPurpose, ProductAsset } from '../../domain/entities/ProductAsset'
import { DomainError } from '../../domain/errors/DomainError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { ProductAssetRepositoryPort } from '../ports/ProductAssetRepositoryPort'
import type { ProductAssetStoragePort } from '../ports/ProductAssetStoragePort'
import type { CreateUploadIntentInput, UploadIntentResponseDto } from '../dto/ProductAssetDto'

export interface CreateProductAssetUploadIntentDependencies {
  readonly storage: ProductAssetStoragePort
  readonly repository: ProductAssetRepositoryPort
  readonly idGenerator: IdGeneratorPort
  readonly clock: ClockPort
  readonly apiBaseUrl: string
}

export class CreateProductAssetUploadIntent {
  private static readonly INTENT_EXPIRY_SECONDS = 600 // 10 minutos por contrato

  constructor(private readonly deps: CreateProductAssetUploadIntentDependencies) {}

  async execute(input: CreateUploadIntentInput): Promise<UploadIntentResponseDto> {
    if (input.purpose !== AssetPurpose.PrimaryImage) {
      throw new DomainError(
        `El proposito "${input.purpose}" no es admitido. Debe ser PRIMARY_IMAGE.`,
      )
    }

    const assetId = this.deps.idGenerator.generate()
    const now = this.deps.clock.now()
    const expiresAt = new Date(
      now.getTime() + CreateProductAssetUploadIntent.INTENT_EXPIRY_SECONDS * 1000,
    )
    const stagingKey = `staging/${assetId}`

    const baseUrl = this.deps.apiBaseUrl.replace(/\/+$/, '')
    const imageUrl = `${baseUrl}/api/v1/catalog/product-assets/${assetId}/content`

    const asset = ProductAsset.createPending({
      assetId,
      purpose: AssetPurpose.PrimaryImage,
      contentType: input.contentType,
      contentLength: input.contentLength,
      checksumSha256: input.checksumSha256,
      stagingKey,
      imageUrl,
      createdAt: now,
      expiresAt,
    })

    const uploadIntent = await this.deps.storage.createUploadIntent({
      assetId,
      purpose: input.purpose,
      contentType: input.contentType,
      contentLength: input.contentLength,
      checksumSha256: input.checksumSha256,
      expiresInSeconds: CreateProductAssetUploadIntent.INTENT_EXPIRY_SECONDS,
    })

    await this.deps.repository.save(asset)

    return {
      assetId,
      upload: {
        method: 'POST',
        url: uploadIntent.uploadUrl,
        fields: uploadIntent.fields,
        expiresAt: expiresAt.toISOString(),
      },
    }
  }
}
