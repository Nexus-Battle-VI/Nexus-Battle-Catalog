import { DomainError } from '../errors/DomainError'

export const GraphicResourceType = {
  PrimaryImage: 'PRIMARY_IMAGE',
  Icon: 'ICON',
  Animation: 'ANIMATION',
} as const

export type GraphicResourceType = (typeof GraphicResourceType)[keyof typeof GraphicResourceType]

export interface GraphicResourcePolicyRule {
  readonly allowedContentTypes: readonly string[]
  readonly maxBytes: number
}

export type GraphicResourcePolicy = Readonly<Record<GraphicResourceType, GraphicResourcePolicyRule>>

/**
 * Política inicial de HU-37.2. Conserva el límite ya usado por ProductAsset.
 * Ampliar formatos aprobados solo exige cambiar esta política, no el modelo ni
 * sus consumidores.
 */
export const DEFAULT_GRAPHIC_RESOURCE_POLICY: GraphicResourcePolicy = {
  [GraphicResourceType.PrimaryImage]: {
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
  },
  [GraphicResourceType.Icon]: {
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
  },
  [GraphicResourceType.Animation]: {
    allowedContentTypes: ['image/gif', 'image/png', 'image/webp'],
    maxBytes: 5 * 1024 * 1024,
  },
}

export interface GraphicResourceSnapshot {
  readonly type: GraphicResourceType
  /** Referencia opaca emitida por el almacenamiento; no contiene binario. */
  readonly reference: string
  readonly contentType: string
  readonly contentLength: number
}

/**
 * Recurso visual declarado por una versión de diseño. La autenticidad de la
 * referencia y de sus metadatos se resuelve por el puerto de HU-37.7; este VO
 * aplica la política de tipos y tamaños al contrato de dominio.
 */
export class GraphicResource {
  readonly type: GraphicResourceType
  readonly reference: string
  readonly contentType: string
  readonly contentLength: number

  private constructor(snapshot: GraphicResourceSnapshot) {
    this.type = snapshot.type
    this.reference = snapshot.reference
    this.contentType = snapshot.contentType
    this.contentLength = snapshot.contentLength
  }

  static create(
    input: GraphicResourceSnapshot,
    policy: GraphicResourcePolicy = DEFAULT_GRAPHIC_RESOURCE_POLICY,
  ): GraphicResource {
    const rule = policy[input.type]

    if (rule === undefined) {
      throw new DomainError(`Tipo de recurso gráfico no soportado: "${String(input.type)}".`)
    }

    const reference = input.reference.trim()
    if (reference === '') {
      throw new DomainError('La referencia del recurso gráfico es obligatoria.')
    }

    const contentType = input.contentType.trim().toLowerCase()
    if (!rule.allowedContentTypes.includes(contentType)) {
      throw new DomainError(
        `Formato no permitido para ${input.type}: "${input.contentType}". Se admiten: ${rule.allowedContentTypes.join(', ')}.`,
      )
    }

    if (!Number.isInteger(input.contentLength) || input.contentLength < 1) {
      throw new DomainError('El tamaño del recurso gráfico debe ser un entero positivo.')
    }

    if (input.contentLength > rule.maxBytes) {
      throw new DomainError(
        `El recurso ${input.type} supera el máximo de ${String(rule.maxBytes)} bytes.`,
      )
    }

    return new GraphicResource({
      type: input.type,
      reference,
      contentType,
      contentLength: input.contentLength,
    })
  }

  toSnapshot(): GraphicResourceSnapshot {
    return {
      type: this.type,
      reference: this.reference,
      contentType: this.contentType,
      contentLength: this.contentLength,
    }
  }
}
