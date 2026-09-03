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

const MAX_GRAPHIC_RESOURCE_BYTES = 5 * 1024 * 1024

/**
 * Política inicial de HU-37.2. Conserva el límite ya usado por ProductAsset.
 * Ampliar formatos aprobados solo exige cambiar esta política, no el modelo ni
 * sus consumidores.
 */
export const DEFAULT_GRAPHIC_RESOURCE_POLICY: GraphicResourcePolicy = Object.freeze({
  [GraphicResourceType.PrimaryImage]: {
    allowedContentTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: MAX_GRAPHIC_RESOURCE_BYTES,
  },
  [GraphicResourceType.Icon]: {
    allowedContentTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp']),
    maxBytes: MAX_GRAPHIC_RESOURCE_BYTES,
  },
  [GraphicResourceType.Animation]: {
    // GIF queda listo para cuando HU-37.7 lo valide mediante el mismo contrato.
    allowedContentTypes: Object.freeze(['image/gif', 'image/png', 'image/webp']),
    maxBytes: MAX_GRAPHIC_RESOURCE_BYTES,
  },
})

export interface GraphicResourceSnapshot {
  readonly type: GraphicResourceType
  /** Identificador del asset READY emitido por HU-37.7. */
  readonly assetId: string
  /** URL estable de Catalog; nunca una URL firmada del proveedor. */
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
  readonly assetId: string
  readonly reference: string
  readonly contentType: string
  readonly contentLength: number

  private constructor(snapshot: GraphicResourceSnapshot) {
    this.type = snapshot.type
    this.assetId = snapshot.assetId
    this.reference = snapshot.reference
    this.contentType = snapshot.contentType
    this.contentLength = snapshot.contentLength
    Object.freeze(this)
  }

  static create(
    input: GraphicResourceSnapshot,
    policy: GraphicResourcePolicy = DEFAULT_GRAPHIC_RESOURCE_POLICY,
  ): GraphicResource {
    const rule = policy[input.type]

    if (rule === undefined) {
      throw new DomainError(`Tipo de recurso gráfico no soportado: "${String(input.type)}".`)
    }

    const assetId = normalizeUuid(input.assetId, 'assetId')
    const reference = normalizeCanonicalReference(input.reference, assetId)

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
      assetId,
      reference,
      contentType,
      contentLength: input.contentLength,
    })
  }

  toSnapshot(): GraphicResourceSnapshot {
    return {
      type: this.type,
      assetId: this.assetId,
      reference: this.reference,
      contentType: this.contentType,
      contentLength: this.contentLength,
    }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const normalizeUuid = (raw: string, field: string): string => {
  const value = raw.trim().toLowerCase()

  if (!UUID_PATTERN.test(value)) {
    throw new DomainError(`${field} debe ser un UUID válido.`)
  }

  return value
}

const normalizeCanonicalReference = (raw: string, assetId: string): string => {
  let url: URL

  try {
    url = new URL(raw.trim())
  } catch {
    throw new DomainError('La referencia del recurso gráfico debe ser una URL canónica válida.')
  }

  const expectedPath = `/api/v1/catalog/product-assets/${assetId}/content`
  if (url.pathname !== expectedPath || url.search !== '' || url.hash !== '') {
    throw new DomainError('La referencia debe ser la URL canónica del asset emitida por Catalog.')
  }

  return url.toString()
}
