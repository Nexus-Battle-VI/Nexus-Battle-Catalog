import { UnsupportedOutboxEventTypeError } from '../errors/ApplicationError'
import { ProductEventDestination } from '../ports/ProductEventPublisherPort'

/**
 * Allowlist EXACTA de routing (HU-38, seccion 9). Deliberadamente no es un
 * `startsWith('catalog.product.')`: un evento futuro -por ejemplo
 * `catalog.product.stock.depleted`- no debe empezar a publicarse solo por
 * coincidir con el prefijo.
 */
const DESTINATION_BY_EVENT_TYPE: Readonly<Record<string, ProductEventDestination>> = {
  'catalog.product.created': ProductEventDestination.Created,
  'catalog.product.suspended': ProductEventDestination.Lifecycle,
  'catalog.product.reactivated': ProductEventDestination.Lifecycle,
  'catalog.product.inventory.adjusted': ProductEventDestination.Lifecycle,
  'catalog.product.premium.configured': ProductEventDestination.Lifecycle,
}

/** Los unicos `eventType` que este dispatcher puede reclamar del outbox. */
export const DISPATCHABLE_EVENT_TYPES: readonly string[] = Object.keys(DESTINATION_BY_EVENT_TYPE)

export const resolveProductEventDestination = (eventType: string): ProductEventDestination => {
  const destination = DESTINATION_BY_EVENT_TYPE[eventType]

  if (destination === undefined) {
    throw new UnsupportedOutboxEventTypeError(eventType)
  }

  return destination
}
