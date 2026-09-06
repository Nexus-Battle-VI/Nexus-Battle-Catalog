/** Colas destino aprobadas para el transporte de eventos de Producto (HU-38). */
export const ProductEventDestination = {
  /** `catalog.product.created`, ADR-017. */
  Created: 'CREATED',
  /** Los cuatro eventos de ciclo de vida, ADR-018 (cola compartida). */
  Lifecycle: 'LIFECYCLE',
} as const

export type ProductEventDestination =
  (typeof ProductEventDestination)[keyof typeof ProductEventDestination]

/** Envelope V1 tal como lo define `catalog-events-v1.asyncapi.yaml`. */
export interface ProductEventEnvelope {
  readonly eventId: string
  readonly eventType: string
  readonly eventVersion: number
  readonly aggregateId: string
  readonly occurredAt: string
  readonly producer: 'catalog'
  readonly correlationId: string
  readonly data: Record<string, unknown>
}

/**
 * Puerto de publicacion. La aplicacion solo conoce este contrato; el SDK de
 * AWS vive exclusivamente en el adaptador de infraestructura que lo
 * implemente (HU-38, seccion 10).
 */
export interface ProductEventPublisherPort {
  publish(destination: ProductEventDestination, envelope: ProductEventEnvelope): Promise<void>
}

export const PRODUCT_EVENT_PUBLISHER_PORT = Symbol('ProductEventPublisherPort')
