import { ImageContentValidator } from '../../domain/services/ImageContentValidator'
import {
  ProductAssetConflictError,
  ProductAssetExpiredError,
  ProductAssetNotFoundError,
} from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { ProductAssetRepositoryPort } from '../ports/ProductAssetRepositoryPort'
import type { ProductAssetStoragePort } from '../ports/ProductAssetStoragePort'
import type { FinalizedAssetDto } from '../dto/ProductAssetDto'

export interface FinalizeProductAssetDependencies {
  readonly storage: ProductAssetStoragePort
  readonly repository: ProductAssetRepositoryPort
  readonly clock: ClockPort
}

export class FinalizeProductAsset {
  constructor(private readonly deps: FinalizeProductAssetDependencies) {}

  async execute(assetId: string): Promise<FinalizedAssetDto> {
    const asset = await this.deps.repository.findById(assetId)
    if (!asset) {
      throw new ProductAssetNotFoundError(assetId)
    }

    // Idempotencia: si ya está finalizado en estado READY, devolverlo directamente
    if (asset.isReady()) {
      return {
        assetId: asset.assetId,
        purpose: asset.purpose,
        status: asset.status,
        contentType: asset.contentType,
        contentLength: asset.contentLength,
        width: asset.width ?? 0,
        height: asset.height ?? 0,
        checksumSha256: asset.checksumSha256,
        imageUrl: asset.imageUrl,
      }
    }

    const now = this.deps.clock.now()

    // Comprobar expiración
    if (asset.isExpired(now)) {
      asset.markExpired()
      await this.deps.repository.update(asset)
      throw new ProductAssetExpiredError(assetId)
    }

    if (asset.status !== 'PENDING') {
      throw new ProductAssetConflictError(
        `El asset "${assetId}" se encuentra en estado "${asset.status}".`,
      )
    }

    // Descargar buffer del objeto en staging
    const buffer = await this.deps.storage.getObject(asset.stagingKey)
    if (buffer.length === 0) {
      throw new ProductAssetNotFoundError(
        `No se encontro el archivo cargado en "${asset.stagingKey}".`,
      )
    }

    // Validar contenido real: magic bytes, dimensiones, checksum y rechazo estricto de animación
    const validated = ImageContentValidator.validate({
      buffer,
      declaredContentType: asset.contentType,
      declaredContentLength: asset.contentLength,
      declaredChecksumSha256: asset.checksumSha256,
    })

    // Clave inmutable en assets/: assets/{assetId}/{hash}.{ext}
    const ext = validated.format === 'jpeg' ? 'jpg' : validated.format
    const targetKey = `assets/${asset.assetId}/${validated.sha256Hex}.${ext}`

    // Promocionar en almacenamiento
    await this.deps.storage.promoteObject(asset.stagingKey, targetKey)

    // Actualizar entidad
    asset.markFinalized({
      targetKey,
      width: validated.width,
      height: validated.height,
      finalizedAt: now,
    })

    await this.deps.repository.update(asset)

    return {
      assetId: asset.assetId,
      purpose: asset.purpose,
      status: asset.status,
      contentType: asset.contentType,
      contentLength: asset.contentLength,
      width: validated.width,
      height: validated.height,
      checksumSha256: asset.checksumSha256,
      imageUrl: asset.imageUrl,
    }
  }
}
