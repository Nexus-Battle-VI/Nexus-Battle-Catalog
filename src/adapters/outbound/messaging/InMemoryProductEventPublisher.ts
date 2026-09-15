import type {
  ProductEventDestination,
  ProductEventEnvelope,
  ProductEventPublisherPort,
} from '../../../application/ports/ProductEventPublisherPort'

export interface PublishedProductEvent {
  readonly destination: ProductEventDestination
  readonly envelope: ProductEventEnvelope
}

/**
 * Doble de prueba en memoria. Tambien es el publisher real cuando
 * `CATALOG_EVENT_DISPATCH_ENABLED=false`: en ese estado el worker nunca llama
 * a `publish`, asi que no hace falta un SQSClient real para arrancar el
 * servicio (HU-38, seccion 35).
 */
export class InMemoryProductEventPublisher implements ProductEventPublisherPort {
  readonly published: PublishedProductEvent[] = []

  publish(destination: ProductEventDestination, envelope: ProductEventEnvelope): Promise<void> {
    this.published.push({ destination, envelope })
    return Promise.resolve()
  }
}
