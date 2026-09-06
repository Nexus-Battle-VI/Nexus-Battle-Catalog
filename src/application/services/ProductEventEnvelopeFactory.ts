import {
  MissingCorrelationIdError,
  ProductEventEnvelopeTooLargeError,
} from '../errors/ApplicationError'
import type { OutboxEntry } from '../ports/CanonicalProductPorts'
import type { ProductEventEnvelope } from '../ports/ProductEventPublisherPort'

const MAX_ENVELOPE_BYTES = 65_536

const CREATED_EVENT_TYPE = 'catalog.product.created'

/**
 * `catalogProductCreatedDataV1` (AsyncAPI) es `additionalProperties: false`
 * con exactamente estos cinco campos: proyectar el DTO completo lo violaria.
 */
const buildCreatedData = (payload: Record<string, unknown>): Record<string, unknown> => ({
  productId: payload.productId,
  name: payload.name,
  type: payload.type,
  lifecycleStatus: payload.lifecycleStatus,
  imageUrl: payload.imageUrl,
})

/**
 * `catalogProductLifecycleDataV1` es, por contrato, "el mismo objeto que
 * CanonicalProductDto" -exactamente lo que `UpdateProductLifecycleStatus`,
 * `AdjustProductInventory` y `ConfigureProductPremium` ya escriben como
 * payload del outbox (auditado en codigo). No se recorta.
 */
const buildLifecycleData = (payload: Record<string, unknown>): Record<string, unknown> => payload

/**
 * Traduce un `OutboxEntry` ya reclamado al envelope externo V1
 * (`catalog-events-v1.asyncapi.yaml`). No decide destino ni publica.
 *
 * `occurredAt` se toma de `entry.createdAt`: los cinco casos de uso
 * productores construyen ese campo con el mismo `Clock` que usan para el
 * hecho de dominio (auditado en codigo), nunca en el momento del despacho.
 *
 * Lanza `MissingCorrelationIdError` si el entry no trae `correlationId` -hoy
 * siempre, ver BLOCKER-CONTRACT en `CanonicalProductPorts.OutboxEntry`- en
 * vez de fabricar uno: un envelope con un correlationId inventado no es un
 * envelope valido segun el contrato, y publicarlo asi seria peor que no
 * publicarlo.
 */
export const buildProductEventEnvelope = (entry: OutboxEntry): ProductEventEnvelope => {
  const correlationId = entry.correlationId

  if (correlationId === null || correlationId === undefined || correlationId === '') {
    throw new MissingCorrelationIdError(entry.eventId, entry.eventType)
  }

  const data =
    entry.eventType === CREATED_EVENT_TYPE
      ? buildCreatedData(entry.payload)
      : buildLifecycleData(entry.payload)

  const envelope: ProductEventEnvelope = {
    eventId: entry.eventId,
    eventType: entry.eventType,
    eventVersion: entry.eventVersion,
    aggregateId: entry.aggregateId,
    occurredAt: entry.createdAt.toISOString(),
    producer: 'catalog',
    correlationId,
    data,
  }

  const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8')
  if (bytes > MAX_ENVELOPE_BYTES) {
    throw new ProductEventEnvelopeTooLargeError(entry.eventId, bytes, MAX_ENVELOPE_BYTES)
  }

  return envelope
}
