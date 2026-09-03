import type { DesignVersion } from '../../domain/entities/DesignVersion'
import type { ProductType } from '../../domain/value-objects/canonical-product-values'
import type { GraphicResourceSnapshot } from '../../domain/value-objects/GraphicResource'

export interface ApplyProductDesignChangeDto {
  readonly productId: string
  /** Dato de trazabilidad; la autorización se resuelve en la capa HTTP. */
  readonly actorId: string
  readonly resources: readonly GraphicResourceSnapshot[]
  readonly visualReference?: string
}

export interface DesignVersionDto {
  readonly designVersionId: string
  readonly productId: string
  readonly status: 'DRAFT' | 'APPLIED'
  readonly resources: readonly GraphicResourceSnapshot[]
  readonly authorId: string
  readonly createdAt: string
  readonly visualReference?: string
  readonly versionNumber?: number
  readonly appliedAt?: string
  readonly restoredFromVersionId?: string
}

/**
 * Plantilla portable: conserva el tipo para validación futura pero nunca el
 * identificador del Producto desde el que fue exportada.
 */
export interface ExportableDesignTemplateDto {
  readonly schemaVersion: '1'
  readonly applicableProductType: ProductType
  readonly resources: readonly GraphicResourceSnapshot[]
  readonly visualReference?: string
}

export const toDesignVersionDto = (version: DesignVersion): DesignVersionDto => {
  const snapshot = version.toSnapshot()

  return {
    designVersionId: snapshot.designVersionId,
    productId: snapshot.productId,
    status: snapshot.status,
    resources: snapshot.resources,
    authorId: snapshot.authorId,
    createdAt: snapshot.createdAt.toISOString(),
    visualReference: snapshot.visualReference,
    versionNumber: snapshot.versionNumber,
    appliedAt: snapshot.appliedAt?.toISOString(),
    restoredFromVersionId: snapshot.restoredFromVersionId,
  }
}

export const toExportableDesignTemplateDto = (
  version: DesignVersion,
  applicableProductType: ProductType,
): ExportableDesignTemplateDto => {
  const snapshot = version.toSnapshot()

  return {
    schemaVersion: '1',
    applicableProductType,
    resources: snapshot.resources,
    visualReference: snapshot.visualReference,
  }
}
