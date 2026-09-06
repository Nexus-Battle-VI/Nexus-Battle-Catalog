import 'reflect-metadata'

import { CreateCanonicalProduct } from '../../src/application/use-cases/CreateCanonicalProduct'
import { UpdateProductLifecycleStatus } from '../../src/application/use-cases/UpdateProductLifecycleStatus'
import { AdjustProductInventory } from '../../src/application/use-cases/AdjustProductInventory'
import { ConfigureProductPremium } from '../../src/application/use-cases/ConfigureProductPremium'
import { DispatchProductOutbox } from '../../src/application/use-cases/DispatchProductOutbox'
import { OutboxStatus } from '../../src/application/ports/CanonicalProductPorts'
import { ProductEventDestination } from '../../src/application/ports/ProductEventPublisherPort'
import type { LoggerPort } from '../../src/application/ports/LoggerPort'
import type { RequestTraceContext } from '../../src/application/ports/RequestTraceContext'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { InMemoryCanonicalProductUnitOfWork } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductUnitOfWork'
import { InMemoryProductEventPublisher } from '../../src/adapters/outbound/messaging/InMemoryProductEventPublisher'
import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../src/adapters/outbound/system/UuidGenerator'
import { HeroSubtypeRegistryV1 } from '../../src/adapters/outbound/registry/HeroSubtypeRegistryV1'

const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const CREATE_COMMAND = {
  name: 'Espada de Fuego HU-38',
  imageUrl: 'https://assets.example.test/espada.png',
  description: 'Espada de dos manos con daño de fuego.',
  type: 'ARMA',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
    },
  },
  printRun: 150,
  creditsPrice: 40,
  premium: false,
}

const TRACE_CREATE: RequestTraceContext = { correlationId: 'req-create-http' }
const TRACE_SUSPEND: RequestTraceContext = { correlationId: 'req-suspend-http' }
const TRACE_REACTIVATE: RequestTraceContext = { correlationId: 'req-reactivate-http' }
const TRACE_INVENTORY: RequestTraceContext = { correlationId: 'req-inventory-http' }
const TRACE_PREMIUM: RequestTraceContext = { correlationId: 'req-premium-http' }

/**
 * HU-38: flujo real de produccion -sin AWS, con `InMemoryProductEventPublisher`
 * como doble- desde los casos de uso existentes hasta el dispatcher.
 *
 * No pasa por HTTP/NestJS: la composicion es identica a la de `AppModule`
 * (mismos adaptadores en memoria, mismos casos de uso reales), pero
 * instanciarla aqui directamente evita acoplar esta prueba a autenticacion,
 * lo cual es ortogonal a lo que HU-38 verifica. La resolucion HTTP del
 * `correlationId` (cabecera `x-correlation-id`) se prueba en
 * `test/unit/hu38-correlation-id.spec.ts` y en el controlador; aqui se asume
 * ya resuelto, tal como llega un `RequestTraceContext` real al caso de uso.
 */
describe('HU-38: outbox real -> DispatchProductOutbox -> publisher (sin AWS)', () => {
  const buildHarness = () => {
    const products = new InMemoryCanonicalProductRepository()
    const audit = new InMemoryProductAuditRepository()
    const outbox = new InMemoryProductOutboxRepository()
    const unitOfWork = new InMemoryCanonicalProductUnitOfWork()
    const clock = new SystemClock()
    const idGenerator = new UuidGenerator()
    const heroSubtypes = new HeroSubtypeRegistryV1()

    const createCanonicalProduct = new CreateCanonicalProduct({
      products,
      heroSubtypes,
      productReferences: products,
      idGenerator,
      clock,
      unitOfWork,
      audit,
      outbox,
    })

    const updateLifecycleStatus = new UpdateProductLifecycleStatus({
      products,
      clock,
      idGenerator,
      unitOfWork,
      audit,
      outbox,
    })

    const adjustInventory = new AdjustProductInventory({
      products,
      clock,
      idGenerator,
      unitOfWork,
      audit,
      outbox,
    })

    const configurePremium = new ConfigureProductPremium({
      products,
      clock,
      idGenerator,
      unitOfWork,
      audit,
      outbox,
    })

    const publisher = new InMemoryProductEventPublisher()
    const dispatcher = new DispatchProductOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      workerId: 'integration-worker',
      batchSize: 10,
    })

    return {
      outbox,
      publisher,
      dispatcher,
      createCanonicalProduct,
      updateLifecycleStatus,
      adjustInventory,
      configurePremium,
    }
  }

  it('publica los 5 eventos reales (created + 4 lifecycle) hacia su cola correcta y los marca DISPATCHED', async () => {
    const harness = buildHarness()

    const created = await harness.createCanonicalProduct.execute(
      CREATE_COMMAND,
      undefined,
      TRACE_CREATE,
    )

    await harness.updateLifecycleStatus.execute(
      created.productId,
      { status: 'SUSPENDED', reason: 'Rebalanceo pendiente de estadisticas.' },
      undefined,
      TRACE_SUSPEND,
    )
    await harness.updateLifecycleStatus.execute(
      created.productId,
      { status: 'ACTIVE', reason: 'Rebalanceo completado.' },
      undefined,
      TRACE_REACTIVATE,
    )
    await harness.adjustInventory.execute(
      created.productId,
      { printRun: 300 },
      undefined,
      TRACE_INVENTORY,
    )
    await harness.configurePremium.execute(
      created.productId,
      { premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } },
      undefined,
      TRACE_PREMIUM,
    )

    const result = await harness.dispatcher.dispatchBatch()

    // BLOCKER-CONTRACT resuelto: los cinco productores reales ya persisten
    // correlationId (propagado desde la entrada HTTP hasta el OutboxEntry),
    // asi que el dispatcher puede construir un envelope valido para todos.
    expect(result).toEqual({ claimed: 5, succeeded: 5, failed: 0 })
    expect(harness.publisher.published).toHaveLength(5)

    for (const entry of harness.outbox.entries) {
      expect(entry.status).toBe(OutboxStatus.Dispatched)
      expect(entry.lastError).toBeNull()
    }

    const byEventType = new Map(harness.publisher.published.map((p) => [p.envelope.eventType, p]))

    expect(byEventType.get('catalog.product.created')?.destination).toBe(
      ProductEventDestination.Created,
    )
    expect(byEventType.get('catalog.product.suspended')?.destination).toBe(
      ProductEventDestination.Lifecycle,
    )
    expect(byEventType.get('catalog.product.reactivated')?.destination).toBe(
      ProductEventDestination.Lifecycle,
    )
    expect(byEventType.get('catalog.product.inventory.adjusted')?.destination).toBe(
      ProductEventDestination.Lifecycle,
    )
    expect(byEventType.get('catalog.product.premium.configured')?.destination).toBe(
      ProductEventDestination.Lifecycle,
    )

    // Cada envelope conserva EXACTAMENTE el correlationId de la solicitud que
    // origino el hecho -nunca el eventId, nunca uno inventado por el dispatcher.
    expect(byEventType.get('catalog.product.created')?.envelope.correlationId).toBe(
      TRACE_CREATE.correlationId,
    )
    expect(byEventType.get('catalog.product.suspended')?.envelope.correlationId).toBe(
      TRACE_SUSPEND.correlationId,
    )
    expect(byEventType.get('catalog.product.reactivated')?.envelope.correlationId).toBe(
      TRACE_REACTIVATE.correlationId,
    )
    expect(byEventType.get('catalog.product.inventory.adjusted')?.envelope.correlationId).toBe(
      TRACE_INVENTORY.correlationId,
    )
    expect(byEventType.get('catalog.product.premium.configured')?.envelope.correlationId).toBe(
      TRACE_PREMIUM.correlationId,
    )

    const createdEnvelope = byEventType.get('catalog.product.created')?.envelope
    expect(createdEnvelope?.data).toEqual({
      productId: created.productId,
      name: created.name,
      type: created.type,
      lifecycleStatus: 'ACTIVE',
      imageUrl: created.imageUrl,
    })
  })

  it('retry: SendMessage falla, se reintenta y el eventId y el correlationId permanecen exactamente iguales', async () => {
    const harness = buildHarness()

    const created = await harness.createCanonicalProduct.execute(
      CREATE_COMMAND,
      undefined,
      TRACE_CREATE,
    )

    let shouldFail = true
    const flakyPublisher = harness.publisher
    const originalPublish = flakyPublisher.publish.bind(flakyPublisher)
    flakyPublisher.publish = (destination, envelope) => {
      if (shouldFail) {
        shouldFail = false
        return Promise.reject(new Error('SQS no disponible transitoriamente'))
      }
      return originalPublish(destination, envelope)
    }

    const originalEntry = harness.outbox.entries.find(
      (entry) => entry.aggregateId === created.productId,
    )
    expect(originalEntry).toBeDefined()
    const eventId = originalEntry!.eventId

    const firstAttempt = await harness.dispatcher.dispatchBatch()
    expect(firstAttempt).toEqual({ claimed: 1, succeeded: 0, failed: 1 })

    const afterFailure = await harness.outbox.findByEventId(eventId)
    expect(afterFailure?.status).toBe(OutboxStatus.Pending)
    expect(afterFailure?.attempts).toBe(1)
    expect(afterFailure?.correlationId).toBe(TRACE_CREATE.correlationId)

    const secondAttempt = await harness.dispatcher.dispatchBatch()
    expect(secondAttempt).toEqual({ claimed: 1, succeeded: 1, failed: 0 })

    expect(harness.publisher.published).toHaveLength(1)
    const publishedEnvelope = harness.publisher.published[0]!.envelope
    expect(publishedEnvelope.eventId).toBe(eventId)
    expect(publishedEnvelope.correlationId).toBe(TRACE_CREATE.correlationId)

    const dispatched = await harness.outbox.findByEventId(eventId)
    expect(dispatched?.status).toBe(OutboxStatus.Dispatched)
    expect(dispatched?.correlationId).toBe(TRACE_CREATE.correlationId)
  })

  it('defensa fail-closed: un OutboxEntry historico/corrupto sin correlationId sigue sin poder publicarse', async () => {
    const harness = buildHarness()

    // No se produce a traves de un caso de uso real a proposito: representa
    // un documento pre-existente en Mongo, escrito ANTES de esta correccion,
    // que nunca tuvo correlationId. El dispatcher no le inventa uno.
    await harness.outbox.record({
      eventId: '99999999-9999-4999-8999-999999999999',
      aggregateId: '88888888-8888-4888-8888-888888888888',
      aggregateType: 'CanonicalProduct',
      eventType: 'catalog.product.created',
      eventVersion: 1,
      status: OutboxStatus.Pending,
      payload: {
        productId: '88888888-8888-4888-8888-888888888888',
        name: 'Producto historico',
        type: 'ARMA',
        lifecycleStatus: 'ACTIVE',
        imageUrl: 'https://x/y',
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      dispatchedAt: null,
      purgeAt: null,
      correlationId: null,
    })

    const result = await harness.dispatcher.dispatchBatch()

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 })
    expect(harness.publisher.published).toHaveLength(0)

    const entry = await harness.outbox.findByEventId('99999999-9999-4999-8999-999999999999')
    expect(entry?.status).toBe(OutboxStatus.Pending)
    expect(entry?.lastError).toContain('correlationId')
  })
})
