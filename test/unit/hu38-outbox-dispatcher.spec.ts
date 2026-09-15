import {
  MissingCorrelationIdError,
  ProductEventEnvelopeTooLargeError,
  UnsupportedOutboxEventTypeError,
} from '../../src/application/errors/ApplicationError'
import { buildProductEventEnvelope } from '../../src/application/services/ProductEventEnvelopeFactory'
import {
  DISPATCHABLE_EVENT_TYPES,
  resolveProductEventDestination,
} from '../../src/application/services/ProductEventRouting'
import { DispatchProductOutbox } from '../../src/application/use-cases/DispatchProductOutbox'
import { OutboxStatus, type OutboxEntry } from '../../src/application/ports/CanonicalProductPorts'
import {
  ProductEventDestination,
  type ProductEventEnvelope,
  type ProductEventPublisherPort,
} from '../../src/application/ports/ProductEventPublisherPort'
import type { LoggerPort } from '../../src/application/ports/LoggerPort'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { InMemoryProductEventPublisher } from '../../src/adapters/outbound/messaging/InMemoryProductEventPublisher'
import { SqsProductEventPublisher } from '../../src/adapters/outbound/messaging/SqsProductEventPublisher'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import { OutboxDispatcherWorker } from '../../src/infrastructure/messaging/OutboxDispatcherWorker'

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const buildEntry = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  eventId: 'ev-1111-1111-1111-111111111111',
  aggregateId: 'agg-1111-1111-1111-111111111111',
  aggregateType: 'CanonicalProduct',
  eventType: 'catalog.product.created',
  eventVersion: 1,
  status: OutboxStatus.Pending,
  payload: {
    productId: 'agg-1111-1111-1111-111111111111',
    name: 'Espada de Fuego',
    type: 'ARMA',
    lifecycleStatus: 'ACTIVE',
    imageUrl: 'https://api.example.test/api/v1/catalog/product-assets/x/content',
  },
  createdAt: new Date('2026-09-06T12:00:00.000Z'),
  updatedAt: new Date('2026-09-06T12:00:00.000Z'),
  leaseExpiresAt: null,
  attempts: 0,
  lastError: null,
  dispatchedAt: null,
  purgeAt: null,
  correlationId: 'req-abc123',
  ...overrides,
})

describe('HU-38: Routing de eventos de Producto (ADR-017/ADR-018)', () => {
  it('enruta catalog.product.created hacia CREATED', () => {
    expect(resolveProductEventDestination('catalog.product.created')).toBe(
      ProductEventDestination.Created,
    )
  })

  it.each([
    'catalog.product.suspended',
    'catalog.product.reactivated',
    'catalog.product.inventory.adjusted',
    'catalog.product.premium.configured',
  ])('enruta %s hacia LIFECYCLE', (eventType) => {
    expect(resolveProductEventDestination(eventType)).toBe(ProductEventDestination.Lifecycle)
  })

  it('rechaza un eventType sin destino aprobado (no usa prefijo, usa allowlist exacta)', () => {
    expect(() => resolveProductEventDestination('catalog.product.stock.depleted')).toThrow(
      UnsupportedOutboxEventTypeError,
    )
  })

  it('DISPATCHABLE_EVENT_TYPES contiene exactamente los cinco eventos aprobados', () => {
    expect([...DISPATCHABLE_EVENT_TYPES].sort()).toEqual(
      [
        'catalog.product.created',
        'catalog.product.suspended',
        'catalog.product.reactivated',
        'catalog.product.inventory.adjusted',
        'catalog.product.premium.configured',
      ].sort(),
    )
  })
})

describe('HU-38: Filtro del claim — eventos fuera de alcance', () => {
  it('no reclama catalog.product.stock.depleted; permanece PENDING intacto', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-created' }))
    await outbox.record(
      buildEntry({
        eventId: 'ev-depleted',
        eventType: 'catalog.product.stock.depleted',
        correlationId: null,
      }),
    )

    const claimed = await outbox.claim('worker-1', 10, 30_000, DISPATCHABLE_EVENT_TYPES)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.eventId).toBe('ev-created')

    const depleted = await outbox.findByEventId('ev-depleted')
    expect(depleted?.status).toBe(OutboxStatus.Pending)
    expect(depleted?.attempts).toBe(0)
  })
})

describe('HU-38: Construccion del envelope V1', () => {
  it('proyecta exactamente los 5 campos de catalogProductCreatedDataV1 (additionalProperties:false)', () => {
    const envelope = buildProductEventEnvelope(
      buildEntry({
        payload: {
          productId: 'p-1',
          name: 'Espada',
          type: 'ARMA',
          lifecycleStatus: 'ACTIVE',
          imageUrl: 'https://x/y',
          sku: 'no-deberia-viajar',
          version: 7,
        },
      }),
    )

    expect(envelope.data).toEqual({
      productId: 'p-1',
      name: 'Espada',
      type: 'ARMA',
      lifecycleStatus: 'ACTIVE',
      imageUrl: 'https://x/y',
    })
  })

  it('para lifecycle envia el CanonicalProductDto completo tal como lo escribe el outbox', () => {
    const fullDto = {
      productId: 'p-1',
      sku: 'espada-de-fuego',
      name: 'Espada de Fuego',
      imageUrl: 'https://x/y',
      description: 'desc',
      type: 'ARMA',
      printRun: 150,
      printRunMode: 'LIMITED',
      availableUnits: 40,
      lifecycleStatus: 'SUSPENDED',
      creditsPrice: 40,
      premium: false,
      realMoneyPrice: null,
      averageRating: null,
      reviewCount: 0,
      createdAt: '2026-08-30T20:30:00.000Z',
      updatedAt: '2026-09-06T15:00:00.000Z',
      version: 2,
    }

    const envelope = buildProductEventEnvelope(
      buildEntry({ eventType: 'catalog.product.suspended', payload: fullDto }),
    )

    expect(envelope.data).toEqual(fullDto)
  })

  it('usa createdAt del OutboxEntry como occurredAt -instante del hecho, no del despacho-', () => {
    const entry = buildEntry({ createdAt: new Date('2026-01-02T03:04:05.000Z') })
    const envelope = buildProductEventEnvelope(entry)
    expect(envelope.occurredAt).toBe('2026-01-02T03:04:05.000Z')
  })

  it('preserva el MISMO eventId del OutboxEntry, nunca genera uno nuevo', () => {
    const envelope = buildProductEventEnvelope(buildEntry({ eventId: 'estable-123' }))
    expect(envelope.eventId).toBe('estable-123')
  })

  it('lanza MissingCorrelationIdError cuando el entry no trae correlationId (BLOCKER-CONTRACT)', () => {
    expect(() => buildProductEventEnvelope(buildEntry({ correlationId: null }))).toThrow(
      MissingCorrelationIdError,
    )
    expect(() => buildProductEventEnvelope(buildEntry({ correlationId: undefined }))).toThrow(
      MissingCorrelationIdError,
    )
  })

  it('acepta un envelope hasta 65536 bytes', () => {
    const entry = buildEntry({
      eventType: 'catalog.product.suspended',
      payload: { productId: 'p-1', filler: 'x'.repeat(1000) },
    })
    expect(() => buildProductEventEnvelope(entry)).not.toThrow()
  })

  it('rechaza un envelope que supera 65536 bytes sin truncarlo', () => {
    const entry = buildEntry({
      eventType: 'catalog.product.suspended',
      payload: { productId: 'p-1', filler: 'x'.repeat(70_000) },
    })
    expect(() => buildProductEventEnvelope(entry)).toThrow(ProductEventEnvelopeTooLargeError)
  })
})

describe('HU-38: DispatchProductOutbox', () => {
  const buildDispatcher = (
    outbox: InMemoryProductOutboxRepository,
    publisher: ProductEventPublisherPort,
  ): DispatchProductOutbox =>
    new DispatchProductOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      workerId: 'worker-test',
      batchSize: 10,
    })

  it('publica y marca DISPATCHED cuando el envio tiene exito', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-ok' }))
    const publisher = new InMemoryProductEventPublisher()

    const result = await buildDispatcher(outbox, publisher).dispatchBatch()

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 })
    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]?.destination).toBe(ProductEventDestination.Created)
    const entry = await outbox.findByEventId('ev-ok')
    expect(entry?.status).toBe(OutboxStatus.Dispatched)
  })

  it('created va SOLO a CREATED y los cuatro lifecycle van SOLO a LIFECYCLE', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-created' }))
    await outbox.record(
      buildEntry({ eventId: 'ev-suspended', eventType: 'catalog.product.suspended' }),
    )
    await outbox.record(
      buildEntry({ eventId: 'ev-reactivated', eventType: 'catalog.product.reactivated' }),
    )
    await outbox.record(
      buildEntry({
        eventId: 'ev-inventory',
        eventType: 'catalog.product.inventory.adjusted',
      }),
    )
    await outbox.record(
      buildEntry({ eventId: 'ev-premium', eventType: 'catalog.product.premium.configured' }),
    )
    const publisher = new InMemoryProductEventPublisher()

    await buildDispatcher(outbox, publisher).dispatchBatch()

    const byId = new Map(publisher.published.map((p) => [p.envelope.eventId, p.destination]))
    expect(byId.get('ev-created')).toBe(ProductEventDestination.Created)
    expect(byId.get('ev-suspended')).toBe(ProductEventDestination.Lifecycle)
    expect(byId.get('ev-reactivated')).toBe(ProductEventDestination.Lifecycle)
    expect(byId.get('ev-inventory')).toBe(ProductEventDestination.Lifecycle)
    expect(byId.get('ev-premium')).toBe(ProductEventDestination.Lifecycle)
  })

  it('cuando el envio falla: NO llama complete, SI llama fail, y el evento vuelve a PENDING', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-fail' }))
    const publisher: ProductEventPublisherPort = {
      publish: () => Promise.reject(new Error('SQS no disponible')),
    }

    const result = await buildDispatcher(outbox, publisher).dispatchBatch()

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 })
    const entry = await outbox.findByEventId('ev-fail')
    expect(entry?.status).toBe(OutboxStatus.Pending)
    expect(entry?.attempts).toBe(1)
    expect(entry?.dispatchedAt).toBeNull()
  })

  it('un envelope invalido (sin correlationId) tambien usa fail(), no complete()', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-sin-correlacion', correlationId: null }))
    const publisher = new InMemoryProductEventPublisher()

    const result = await buildDispatcher(outbox, publisher).dispatchBatch()

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 })
    expect(publisher.published).toHaveLength(0)
    const entry = await outbox.findByEventId('ev-sin-correlacion')
    expect(entry?.status).toBe(OutboxStatus.Pending)
    expect(entry?.attempts).toBe(1)
  })

  it('at-least-once: SendMessage exitoso + complete() fallido -> NO fail(), reintento reclama y publica el MISMO eventId', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-dup' }))
    const publisher = new InMemoryProductEventPublisher()
    const originalComplete = outbox.complete.bind(outbox)
    outbox.complete = () => Promise.reject(new Error('timeout de red al confirmar'))

    const firstResult = await buildDispatcher(outbox, publisher).dispatchBatch()
    expect(firstResult).toEqual({ claimed: 1, succeeded: 1, failed: 0 })

    // complete() fallo: el evento sigue IN_FLIGHT, no PENDING ni DEAD.
    const midway = await outbox.findByEventId('ev-dup')
    expect(midway?.status).toBe(OutboxStatus.InFlight)
    expect(midway?.attempts).toBe(0)

    // El lease expira (simulado) y el mismo evento se reclama otra vez.
    outbox.complete = originalComplete
    const entries = outbox.entries as unknown as { leaseExpiresAt: Date }[]
    entries[0]!.leaseExpiresAt = new Date(Date.now() - 1)

    const secondResult = await buildDispatcher(outbox, publisher).dispatchBatch()
    expect(secondResult).toEqual({ claimed: 1, succeeded: 1, failed: 0 })

    expect(publisher.published).toHaveLength(2)
    expect(publisher.published[0]?.envelope.eventId).toBe('ev-dup')
    expect(publisher.published[1]?.envelope.eventId).toBe('ev-dup')

    const final = await outbox.findByEventId('ev-dup')
    expect(final?.status).toBe(OutboxStatus.Dispatched)
  })

  it('continua procesando el resto del lote aunque un evento falle', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildEntry({ eventId: 'ev-bad', correlationId: null }))
    await outbox.record(buildEntry({ eventId: 'ev-good' }))
    const publisher = new InMemoryProductEventPublisher()

    const result = await buildDispatcher(outbox, publisher).dispatchBatch()

    expect(result).toEqual({ claimed: 2, succeeded: 1, failed: 1 })
    expect(publisher.published.map((p) => p.envelope.eventId)).toEqual(['ev-good'])
  })

  it('sin eventos pendientes no reclama nada y no publica', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    const publisher = new InMemoryProductEventPublisher()

    const result = await buildDispatcher(outbox, publisher).dispatchBatch()

    expect(result).toEqual({ claimed: 0, succeeded: 0, failed: 0 })
    expect(publisher.published).toHaveLength(0)
  })
})

describe('HU-38: SqsProductEventPublisher — colas realmente distintas', () => {
  it('created usa la QueueUrl de created; lifecycle usa la de lifecycle', () => {
    const sentTo: string[] = []
    const publisher = new SqsProductEventPublisher({
      region: 'us-east-1',
      eventsQueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications',
      lifecycleQueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/catalog-lifecycle-notifications',
    })

    // Se reemplaza el cliente interno por un doble minimo: esta prueba
    // verifica el MAPEO destino->QueueUrl, no el SDK de AWS en si.
    ;(publisher as unknown as { client: { send: (cmd: unknown) => Promise<unknown> } }).client = {
      send: (cmd: unknown) => {
        sentTo.push((cmd as { input: { QueueUrl: string } }).input.QueueUrl)
        return Promise.resolve({})
      },
    }

    const envelope: ProductEventEnvelope = {
      eventId: 'e1',
      eventType: 'catalog.product.created',
      eventVersion: 1,
      aggregateId: 'a1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      producer: 'catalog',
      correlationId: 'c1',
      data: {},
    }

    return Promise.all([
      publisher.publish(ProductEventDestination.Created, envelope),
      publisher.publish(ProductEventDestination.Lifecycle, envelope),
    ]).then(() => {
      expect(sentTo).toEqual([
        'https://sqs.us-east-1.amazonaws.com/1/catalog-product-created-notifications',
        'https://sqs.us-east-1.amazonaws.com/1/catalog-lifecycle-notifications',
      ])
    })
  })
})

describe('HU-38: Configuracion fail-closed del despachador', () => {
  it('por defecto el despacho esta deshabilitado y no exige ninguna URL', () => {
    const config = loadConfig({})
    expect(config.eventDispatch.enabled).toBe(false)
    expect(config.eventDispatch.eventsQueueUrl).toBeNull()
    expect(config.eventDispatch.lifecycleQueueUrl).toBeNull()
  })

  it('enabled=true sin AWS_REGION falla al arrancar', () => {
    expect(() =>
      loadConfig({
        CATALOG_EVENT_DISPATCH_ENABLED: 'true',
        AWS_REGION: '',
        CATALOG_EVENTS_QUEUE_URL: 'https://x/created',
        CATALOG_LIFECYCLE_QUEUE_URL: 'https://x/lifecycle',
      }),
    ).toThrow(ConfigurationError)
  })

  it('enabled=true sin CATALOG_EVENTS_QUEUE_URL falla al arrancar', () => {
    expect(() =>
      loadConfig({
        CATALOG_EVENT_DISPATCH_ENABLED: 'true',
        AWS_REGION: 'us-east-1',
        CATALOG_LIFECYCLE_QUEUE_URL: 'https://x/lifecycle',
      }),
    ).toThrow(ConfigurationError)
  })

  it('enabled=true sin CATALOG_LIFECYCLE_QUEUE_URL falla al arrancar', () => {
    expect(() =>
      loadConfig({
        CATALOG_EVENT_DISPATCH_ENABLED: 'true',
        AWS_REGION: 'us-east-1',
        CATALOG_EVENTS_QUEUE_URL: 'https://x/created',
      }),
    ).toThrow(ConfigurationError)
  })

  it('enabled=true con las tres variables arranca y las expone', () => {
    const config = loadConfig({
      CATALOG_EVENT_DISPATCH_ENABLED: 'true',
      AWS_REGION: 'us-east-1',
      CATALOG_EVENTS_QUEUE_URL: 'https://x/created',
      CATALOG_LIFECYCLE_QUEUE_URL: 'https://x/lifecycle',
    })

    expect(config.eventDispatch).toEqual({
      enabled: true,
      awsRegion: 'us-east-1',
      eventsQueueUrl: 'https://x/created',
      lifecycleQueueUrl: 'https://x/lifecycle',
      batchSize: 10,
    })
  })

  it('el tamano de lote se limita a 1..10', () => {
    expect(() => loadConfig({ CATALOG_EVENT_DISPATCH_BATCH_SIZE: '0' })).toThrow(ConfigurationError)
    expect(() => loadConfig({ CATALOG_EVENT_DISPATCH_BATCH_SIZE: '11' })).toThrow(
      ConfigurationError,
    )
    expect(loadConfig({ CATALOG_EVENT_DISPATCH_BATCH_SIZE: '5' }).eventDispatch.batchSize).toBe(5)
  })
})

describe('HU-38: OutboxDispatcherWorker', () => {
  it('deshabilitado no consume el outbox: dispatchBatch nunca se llama', async () => {
    let calls = 0
    const dispatcher = {
      dispatchBatch: () => {
        calls += 1
        return Promise.resolve({ claimed: 0, succeeded: 0, failed: 0 })
      },
    } as unknown as DispatchProductOutbox

    const worker = new OutboxDispatcherWorker({
      enabled: false,
      dispatcher,
      logger: silentLogger,
    })

    worker.onApplicationBootstrap()
    await new Promise((resolve) => setTimeout(resolve, 20))
    worker.onApplicationShutdown()

    expect(calls).toBe(0)
  })

  it('habilitado evita ciclos solapados: nunca hay dos dispatchBatch concurrentes', async () => {
    let inFlight = 0
    let maxConcurrent = 0
    let calls = 0

    const dispatcher = {
      dispatchBatch: async () => {
        inFlight += 1
        calls += 1
        maxConcurrent = Math.max(maxConcurrent, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 15))
        inFlight -= 1
        return { claimed: 0, succeeded: 0, failed: 0 }
      },
    } as unknown as DispatchProductOutbox

    const worker = new OutboxDispatcherWorker({
      enabled: true,
      dispatcher,
      logger: silentLogger,
      pollIntervalMs: 5,
    })

    worker.onApplicationBootstrap()
    await new Promise((resolve) => setTimeout(resolve, 70))
    worker.onApplicationShutdown()

    expect(maxConcurrent).toBe(1)
    expect(calls).toBeGreaterThan(1)
  })

  it('onApplicationShutdown detiene el ciclo (apagado limpio)', async () => {
    let calls = 0
    const dispatcher = {
      dispatchBatch: () => {
        calls += 1
        return Promise.resolve({ claimed: 0, succeeded: 0, failed: 0 })
      },
    } as unknown as DispatchProductOutbox

    const worker = new OutboxDispatcherWorker({
      enabled: true,
      dispatcher,
      logger: silentLogger,
      pollIntervalMs: 5,
    })

    worker.onApplicationBootstrap()
    await new Promise((resolve) => setTimeout(resolve, 12))
    worker.onApplicationShutdown()
    const callsAtShutdown = calls
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(calls).toBe(callsAtShutdown)
  })
})
