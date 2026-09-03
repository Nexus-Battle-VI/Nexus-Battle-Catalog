import {
  CanonicalProductConcurrencyConflictError,
  OutboxPayloadTooLargeError,
} from '../../src/application/errors/ApplicationError'
import {
  OutboxStatus,
  type OutboxEntry,
  type ProductAuditEntry,
} from '../../src/application/ports/CanonicalProductPorts'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { InMemoryCanonicalProductUnitOfWork } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductUnitOfWork'
import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import {
  CreditsPrice,
  LifecycleStatus,
  PrintRun,
  PrintRunMode,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  ProductType,
} from '../../src/domain/value-objects/canonical-product-values'
import { ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import type { ProductAttributes } from '../../src/domain/value-objects/product-attributes'

describe('EN-027.6: Concurrencia optimista y Unidad Transaccional', () => {
  const buildProduct = (id: string, version = 0): CanonicalProduct =>
    CanonicalProduct.restore({
      productId: ProductId.create(id),
      sku: Sku.create(`sku-${id.slice(0, 8)}`),
      name: ProductName.create(`Producto ${id.slice(0, 8)}`),
      imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
      description: ProductDescription.create('Descripcion valida.'),
      type: ProductType.Armor,
      attributes: {
        schemaVersion: '1',
        values: { kind: ProductType.Armor },
      } as unknown as ProductAttributes,
      printRun: PrintRun.create(-1),
      availableUnits: null,
      pricing: ProductPricing.create({
        creditsPrice: CreditsPrice.create(100),
        premium: false,
        realMoneyPrice: null,
      }),
      lifecycleStatus: LifecycleStatus.Active,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      version,
    })

  it('permite actualizar si la versión esperada coincide', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const product = buildProduct('11111111-1111-4111-8111-111111111111', 0)
    await repo.create(product)

    const updated = buildProduct('11111111-1111-4111-8111-111111111111', 1)
    await expect(repo.update(updated, 0)).resolves.toBeUndefined()
  })

  it('lanza CanonicalProductConcurrencyConflictError si la versión esperada no coincide', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const product = buildProduct('11111111-1111-4111-8111-111111111111', 0)
    await repo.create(product)

    const staleWriter = buildProduct('11111111-1111-4111-8111-111111111111', 1)
    await expect(repo.update(staleWriter, 99)).rejects.toBeInstanceOf(
      CanonicalProductConcurrencyConflictError,
    )
  })

  it('la unidad de trabajo en memoria ejecuta y cuenta transacciones', async () => {
    const uow = new InMemoryCanonicalProductUnitOfWork()
    const result = await uow.executeTransaction((ctx) => {
      expect(ctx.session).toBeDefined()
      return Promise.resolve('operacion_confirmada')
    })

    expect(result).toBe('operacion_confirmada')
    expect(uow.executedTransactions).toBe(1)
  })
})

describe('EN-027.7: Auditoría insert-only de Producto', () => {
  const auditEntry: ProductAuditEntry = {
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    aggregateId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    aggregateType: 'CanonicalProduct',
    action: 'PRODUCT_CREATED',
    actor: {
      subject: 'admin-id-123',
      email: 'admin@nexus.test',
      role: 'ADMINISTRATOR',
    },
    timestamp: new Date('2026-09-02T12:00:00.000Z'),
    snapshot: {
      productId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sku: 'heroe-fuego',
      name: 'Héroe de Fuego',
      normalizedName: 'heroe de fuego',
      imageUrl: 'https://assets.example.test/heroe.png',
      description: 'Héroe legendario.',
      type: ProductType.Hero,
      attributes: {
        schemaVersion: '1',
        values: { kind: ProductType.Hero },
      } as unknown as ProductAttributes,
      printRun: 1,
      printRunMode: PrintRunMode.Unique,
      availableUnits: 1,
      lifecycleStatus: LifecycleStatus.Active,
      creditsPrice: 500,
      premium: false,
      realMoneyPrice: null,
      createdAt: '2026-09-02T12:00:00.000Z',
      updatedAt: '2026-09-02T12:00:00.000Z',
      version: 0,
    },
  }

  it('registra una entrada de auditoría inmutable', async () => {
    const auditRepo = new InMemoryProductAuditRepository()
    await auditRepo.record(auditEntry)

    const found = await auditRepo.findByEventId(auditEntry.eventId)
    expect(found).not.toBeNull()
    expect(found?.eventId).toBe(auditEntry.eventId)
    expect(found?.aggregateId).toBe(auditEntry.aggregateId)
    expect(found?.actor.subject).toBe('admin-id-123')
    expect(found?.snapshot.version).toBe(0)
  })

  it('permite buscar el historial cronológico por aggregateId', async () => {
    const auditRepo = new InMemoryProductAuditRepository()
    await auditRepo.record(auditEntry)
    await auditRepo.record({
      ...auditEntry,
      eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      action: 'PRODUCT_UPDATED',
      timestamp: new Date('2026-09-02T13:00:00.000Z'),
    })

    const history = await auditRepo.findByAggregateId(auditEntry.aggregateId)
    expect(history).toHaveLength(2)
    expect(history[0]?.action).toBe('PRODUCT_UPDATED')
    expect(history[1]?.action).toBe('PRODUCT_CREATED')
  })
})

describe('EN-027.8: Outbox persistente y reclamación por lease', () => {
  const buildOutboxEntry = (
    id: string,
    status: OutboxStatus = OutboxStatus.Pending,
  ): OutboxEntry => ({
    eventId: id,
    aggregateId: 'prod-1',
    aggregateType: 'CanonicalProduct',
    eventType: 'catalog.product.created',
    eventVersion: 1,
    status,
    payload: { productId: 'prod-1', name: 'Producto Prueba' },
    createdAt: new Date('2026-09-02T10:00:00.000Z'),
    updatedAt: new Date('2026-09-02T10:00:00.000Z'),
    attempts: 0,
  })

  it('reclama eventos pendientes de forma atómica y fija lease', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildOutboxEntry('ev-1'))
    await outbox.record(buildOutboxEntry('ev-2'))

    const claimed = await outbox.claim('worker-A', 1, 30_000)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.eventId).toBe('ev-1')
    expect(claimed[0]?.status).toBe(OutboxStatus.InFlight)
    expect(claimed[0]?.leaseExpiresAt).toBeDefined()

    // Un segundo worker concurrente no recibe el evento ya reclamado
    const claimedWorkerB = await outbox.claim('worker-B', 1, 30_000)
    expect(claimedWorkerB).toHaveLength(1)
    expect(claimedWorkerB[0]?.eventId).toBe('ev-2')
  })

  it('permite recuperar un evento cuyo lease ha expirado', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    const expiredEntry: OutboxEntry = {
      ...buildOutboxEntry('ev-expired', OutboxStatus.InFlight),
      leaseExpiresAt: new Date(Date.now() - 10_000), // Expiró hace 10s
    }
    await outbox.record(expiredEntry)

    const reclaimed = await outbox.claim('worker-C', 1, 30_000)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.eventId).toBe('ev-expired')
  })

  it('marca como completado (DISPATCHED) con fecha de despacho', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildOutboxEntry('ev-done'))

    await outbox.complete('ev-done')
    const found = await outbox.findByEventId('ev-done')
    expect(found?.status).toBe(OutboxStatus.Dispatched)
    expect(found?.dispatchedAt).not.toBeNull()
    expect(found?.dispatchedAt?.getTime()).toBeGreaterThan(0)
  })

  it('gestiona reintentos y transiciona a DEAD al superar el límite de intentos', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    await outbox.record(buildOutboxEntry('ev-fail'))

    // 4 fallos (maxAttempts = 5)
    for (let i = 0; i < 4; i += 1) {
      await outbox.fail('ev-fail', 'Error de red transitorio', 5)
      const entry = await outbox.findByEventId('ev-fail')
      expect(entry?.status).toBe(OutboxStatus.Pending)
      expect(entry?.attempts).toBe(i + 1)
    }

    // 5to fallo: debe pasar a DEAD
    await outbox.fail('ev-fail', 'Error fatal', 5)
    const deadEntry = await outbox.findByEventId('ev-fail')
    expect(deadEntry?.status).toBe(OutboxStatus.Dead)
    expect(deadEntry?.attempts).toBe(5)
    expect(deadEntry?.lastError).toBe('Error fatal')
  })

  it('rechaza payloads que superan el límite de 256 KiB', async () => {
    const outbox = new InMemoryProductOutboxRepository()
    const giantPayload: Record<string, string> = {
      bigData: 'X'.repeat(260 * 1024),
    }

    const entry: OutboxEntry = {
      ...buildOutboxEntry('ev-huge'),
      payload: giantPayload,
    }

    await expect(outbox.record(entry)).rejects.toBeInstanceOf(OutboxPayloadTooLargeError)
  })
})
