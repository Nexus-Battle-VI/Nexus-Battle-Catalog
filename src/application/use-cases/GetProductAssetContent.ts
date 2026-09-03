import { ProductAssetNotFoundError } from '../errors/ApplicationError'
import type { ProductAssetRepositoryPort } from '../ports/ProductAssetRepositoryPort'
import type { ProductAssetStoragePort } from '../ports/ProductAssetStoragePort'

export interface GetProductAssetContentDependencies {
  readonly storage: ProductAssetStoragePort
  readonly repository: ProductAssetRepositoryPort
}

export class GetProductAssetContent {
  private static readonly DOWNLOAD_EXPIRY_SECONDS = 300 // 5 minutos por contrato

  constructor(private readonly deps: GetProductAssetContentDependencies) {}

  async execute(assetId: string): Promise<string> {
    const asset = await this.deps.repository.findById(assetId)
    if (!asset || !asset.isReady() || !asset.targetKey) {
      throw new ProductAssetNotFoundError(assetId)
    }

    return await this.deps.storage.getPresignedDownloadUrl(
      asset.targetKey,
      GetProductAssetContent.DOWNLOAD_EXPIRY_SECONDS,
    )
  }
}
