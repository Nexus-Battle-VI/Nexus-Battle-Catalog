import 'reflect-metadata'

import { CreateCanonicalProduct } from '../../src/application/use-cases/CreateCanonicalProduct'
import { UpdateProductLifecycleStatus } from '../../src/application/use-cases/UpdateProductLifecycleStatus'
import { AdjustProductInventory } from '../../src/application/use-cases/AdjustProductInventory'
import { ConfigureProductPremium } from '../../src/application/use-cases/ConfigureProductPremium'
import { DispatchProductOutbox } from '../../src/application/use-cases/DispatchProductOutbox'
import { OutboxStatus } from '../../src/application/ports/CanonicalProductPorts'
import { ProductEventDestination } from '../../src/application/ports/ProductEventPublisherPort'
import type { LoggerPort } from '../../src/application/ports/LoggerPort'
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

/**
 * HU-38: flujo real de produccion -sin AWS, con `InMemoryProductEventPublisher`
 * como doble- desde los casos de uso existentes hasta el dispatcher.
 *
 * No pasa por HTTP/NestJS: la composicion es identica a la de `AppModule`
 * (mismos adaptadores en memoria, mismos casos de uso reales), pero
 * instanciarla aqui directamente evita acoplar esta prueba a autenticacion,
 * lo cual es ortogonal a lo que HU-38 verifica.
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

  it(
    'BLOCKER-CONTRACT real: hoy ningun productor conserva correlationId, asi que el ' +
      'dispatcher no publica NADA -queda PENDING, no DISPATCHED, no se pierde el evento',
    async () => {
      const harness = buildHarness()

      const created = await harness.createCanonicalProduct.execute(CREATE_COMMAND)

      await harness.updateLifecycleStatus.execute(created.productId, {
        status: 'SUSPENDED',
        reason: 'Rebalanceo pendiente de estadisticas.',
      })
      await harness.updateLifecycleStatus.execute(created.productId, {
        status: 'ACTIVE',
        reason: 'Rebalanceo completado.',
      })
      await harness.adjustInventory.execute(created.productId, { printRun: 300 })
      await harness.configurePremium.execute(created.productId, {
        premium: true,
        realMoneyPrice: { amount: 999, currency: 'USD' },
      })

      const result = await harness.dispatcher.dispatchBatch()

      // Los cinco eventos (created + 4 lifecycle) se reclaman -pasan el
      // filtro de eventType- pero NINGUNO se publica: el envelope V1 exige
      // correlationId y Catalog no tiene hoy ninguna fuente real para el
      // (auditado en codigo: sin request-context). Ver ApplicationError
      // `MissingCorrelationIdError` y HU-38 seccion 17/46.
      expect(result.claimed).toBe(5)
      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(5)
      expect(harness.publisher.published).toHaveLength(0)

      const entries = harness.outbox.entries
      expect(entries).toHaveLength(5)
      for (const entry of entries) {
        expect(entry.status).toBe(OutboxStatus.Pending)
        expect(entry.attempts).toBe(1)
        expect(entry.dispatchedAt).toBeNull()
        expect(entry.lastError).toContain('correlationId')
      }
    },
  )

  it(
    'si un correlationId real llegara a existir, el dispatcher SI publica cada evento ' +
      'hacia su cola correcta y marca DISPATCHED (prueba de que el wiring esta listo)',
    async () => {
      const harness = buildHarness()

      const created = await harness.createCanonicalProduct.execute(CREATE_COMMAND)
      await harness.updateLifecycleStatus.execute(created.productId, {
        status: 'SUSPENDED',
        reason: 'Rebalanceo pendiente de estadisticas.',
      })

      // Simulacion deliberada de una extension FUTURA (fuera de alcance de
      // este PR): un correlationId capturado del request-context original.
      // Los casos de uso reales de HOY no escriben este campo -por eso la
      // prueba anterior documenta que hoy siempre falta-.
      for (const entry of harness.outbox.entries) {
        Object.assign(entry, { correlationId: `req-simulado-${entry.eventId.slice(0, 8)}` })
      }

      const result = await harness.dispatcher.dispatchBatch()

      expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 })
      expect(harness.publisher.published).toHaveLength(2)

      const byEventType = new Map(
        harness.publisher.published.map((p) => [p.envelope.eventType, p.destination]),
      )
      expect(byEventType.get('catalog.product.created')).toBe(ProductEventDestination.Created)
      expect(byEventType.get('catalog.product.suspended')).toBe(ProductEventDestination.Lifecycle)

      for (const entry of harness.outbox.entries) {
        expect(entry.status).toBe(OutboxStatus.Dispatched)
      }

      const createdEnvelope = harness.publisher.published.find(
        (p) => p.envelope.eventType === 'catalog.product.created',
      )?.envelope
      expect(createdEnvelope?.data).toEqual({
        productId: created.productId,
        name: created.name,
        type: created.type,
        lifecycleStatus: 'ACTIVE',
        imageUrl: created.imageUrl,
      })
    },
  )
})
