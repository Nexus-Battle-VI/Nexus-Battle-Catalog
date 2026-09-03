import { DomainError } from '../errors/DomainError'
import { GraphicResource, type GraphicResourceSnapshot } from '../value-objects/GraphicResource'

export const DesignVersionStatus = {
  Draft: 'DRAFT',
  Applied: 'APPLIED',
} as const

export type DesignVersionStatus = (typeof DesignVersionStatus)[keyof typeof DesignVersionStatus]

export interface DesignVersionSnapshot {
  readonly designVersionId: string
  /** Relación por identificador; la entidad Producto no participa en este modelo. */
  readonly productId: string
  readonly status: DesignVersionStatus
  readonly resources: readonly GraphicResourceSnapshot[]
  readonly authorId: string
  readonly createdAt: Date
  readonly visualReference?: string
  /** Solo existe una vez que la versión entra al historial. */
  readonly versionNumber?: number
  readonly appliedAt?: Date
  /** Se informa cuando la versión aplicada procede de un rollback. */
  readonly restoredFromVersionId?: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const normalizeUuid = (raw: string, field: string): string => {
  const value = raw.trim().toLowerCase()

  if (!UUID_PATTERN.test(value)) {
    throw new DomainError(`${field} debe ser un UUID válido.`)
  }

  return value
}

const validDate = (value: Date, field: string): void => {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError(`${field} debe ser una fecha válida.`)
  }
}

/**
 * Estado inmutable de un diseño. Un borrador no tiene número de versión ni
 * fecha de aplicación; una entrada aplicada los requiere. Esta diferencia hace
 * imposible confundir un cambio pendiente con una versión del historial.
 */
export class DesignVersion {
  readonly designVersionId: string
  readonly productId: string
  readonly status: DesignVersionStatus
  readonly resources: readonly GraphicResource[]
  readonly authorId: string
  readonly visualReference?: string
  readonly versionNumber?: number
  readonly restoredFromVersionId?: string
  private readonly createdAtMillis: number
  private readonly appliedAtMillis?: number

  private constructor(snapshot: DesignVersionSnapshot) {
    this.designVersionId = normalizeUuid(snapshot.designVersionId, 'designVersionId')
    this.productId = normalizeUuid(snapshot.productId, 'productId')
    this.status = snapshot.status
    this.resources = Object.freeze(
      snapshot.resources.map((resource) => GraphicResource.create(resource)),
    )
    this.authorId = snapshot.authorId.trim()
    this.createdAtMillis = snapshot.createdAt.getTime()
    this.visualReference = snapshot.visualReference?.trim()
    this.versionNumber = snapshot.versionNumber
    this.appliedAtMillis = snapshot.appliedAt?.getTime()
    this.restoredFromVersionId =
      snapshot.restoredFromVersionId === undefined
        ? undefined
        : normalizeUuid(snapshot.restoredFromVersionId, 'restoredFromVersionId')
    Object.freeze(this)
  }

  static createDraft(
    params: Omit<
      DesignVersionSnapshot,
      'status' | 'versionNumber' | 'appliedAt' | 'restoredFromVersionId'
    >,
  ): DesignVersion {
    return DesignVersion.fromSnapshot({ ...params, status: DesignVersionStatus.Draft })
  }

  static createApplied(
    params: Omit<DesignVersionSnapshot, 'status'> & {
      readonly versionNumber: number
      readonly appliedAt: Date
    },
  ): DesignVersion {
    return DesignVersion.fromSnapshot({ ...params, status: DesignVersionStatus.Applied })
  }

  static fromSnapshot(snapshot: DesignVersionSnapshot): DesignVersion {
    if (!Object.values(DesignVersionStatus).includes(snapshot.status)) {
      throw new DomainError(
        `Estado de versión de diseño no soportado: "${String(snapshot.status)}".`,
      )
    }

    if (snapshot.resources.length === 0) {
      throw new DomainError('Una versión de diseño debe tener al menos un recurso gráfico.')
    }

    if (snapshot.authorId.trim() === '') {
      throw new DomainError('El autor de la versión de diseño es obligatorio.')
    }

    validDate(snapshot.createdAt, 'createdAt')

    if (snapshot.visualReference !== undefined && snapshot.visualReference.trim() === '') {
      throw new DomainError('La referencia visual no puede estar vacía.')
    }

    if (snapshot.status === DesignVersionStatus.Draft) {
      if (
        snapshot.versionNumber !== undefined ||
        snapshot.appliedAt !== undefined ||
        snapshot.restoredFromVersionId !== undefined
      ) {
        throw new DomainError('Un borrador no puede tener datos de una versión aplicada.')
      }
    } else {
      if (!Number.isInteger(snapshot.versionNumber) || (snapshot.versionNumber ?? 0) < 1) {
        throw new DomainError('Una versión aplicada debe tener un número de versión positivo.')
      }

      if (snapshot.appliedAt === undefined) {
        throw new DomainError('Una versión aplicada debe registrar appliedAt.')
      }

      validDate(snapshot.appliedAt, 'appliedAt')

      if (snapshot.appliedAt.getTime() < snapshot.createdAt.getTime()) {
        throw new DomainError('appliedAt no puede ser anterior a createdAt.')
      }

      if (
        snapshot.restoredFromVersionId !== undefined &&
        normalizeUuid(snapshot.restoredFromVersionId, 'restoredFromVersionId') ===
          normalizeUuid(snapshot.designVersionId, 'designVersionId')
      ) {
        throw new DomainError('Una versión no puede restaurarse desde sí misma.')
      }
    }

    return new DesignVersion(snapshot)
  }

  isDraft(): boolean {
    return this.status === DesignVersionStatus.Draft
  }

  isApplied(): boolean {
    return this.status === DesignVersionStatus.Applied
  }

  /** Devuelve una copia para impedir que se muten fechas de una versión aplicada. */
  get createdAt(): Date {
    return new Date(this.createdAtMillis)
  }

  /** Devuelve una copia para impedir que se muten fechas de una versión aplicada. */
  get appliedAt(): Date | undefined {
    return this.appliedAtMillis === undefined ? undefined : new Date(this.appliedAtMillis)
  }

  toSnapshot(): DesignVersionSnapshot {
    return {
      designVersionId: this.designVersionId,
      productId: this.productId,
      status: this.status,
      resources: this.resources.map((resource) => resource.toSnapshot()),
      authorId: this.authorId,
      createdAt: this.createdAt,
      visualReference: this.visualReference,
      versionNumber: this.versionNumber,
      appliedAt: this.appliedAt,
      restoredFromVersionId: this.restoredFromVersionId,
    }
  }
}
