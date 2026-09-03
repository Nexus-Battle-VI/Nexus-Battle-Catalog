import type { ClockPort } from '../ports/ClockPort'
import type { ProductAssetRepositoryPort } from '../ports/ProductAssetRepositoryPort'
import type { ProductAssetStoragePort } from '../ports/ProductAssetStoragePort'

export interface ReconcileProductAssetsDependencies {
  readonly storage: ProductAssetStoragePort
  readonly repository: ProductAssetRepositoryPort
  readonly clock: ClockPort
}

export interface ReconciliationReport {
  readonly expiredIntentsMarked: number
  readonly orphanedStagingDeleted: number
}

export class ReconcileProductAssets {
  private static readonly STAGING_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 horas

  constructor(private readonly deps: ReconcileProductAssetsDependencies) {}

  async execute(): Promise<ReconciliationReport> {
    const now = this.deps.clock.now()
    const thresholdDate = new Date(
      now.getTime() - ReconcileProductAssets.STAGING_CLEANUP_THRESHOLD_MS,
    )

    // 1. Marcar intenciones pendientes vencidas
    const expiredAssets = await this.deps.repository.findExpiredPendingIntents(now)
    let expiredIntentsMarked = 0
    for (const asset of expiredAssets) {
      asset.markExpired()
      await this.deps.repository.update(asset)
      expiredIntentsMarked++
    }

    // 2. Listar objetos huérfanos en staging/ con más de 24h
    let orphanedStagingDeleted = 0
    const stagingObjects = await this.deps.storage.listObjectsWithPrefix('staging/')
    for (const obj of stagingObjects) {
      if (obj.lastModified.getTime() <= thresholdDate.getTime()) {
        // Verificar si existe alguna intención activa antes de borrar
        const asset = await this.deps.repository.findByStagingKey(obj.key)
        if (!asset || asset.isExpired(now)) {
          await this.deps.storage.deleteObject(obj.key)
          orphanedStagingDeleted++
        }
      }
    }

    return {
      expiredIntentsMarked,
      orphanedStagingDeleted,
    }
  }
}
