import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoProductOutboxRepository } from '../../src/adapters/outbound/persistence/MongoProductOutboxRepository'
import { DISPATCHABLE_EVENT_TYPES } from '../../src/application/services/ProductEventRouting'
import { OutboxStatus, type OutboxEntry } from '../../src/application/ports/CanonicalProductPorts'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/** `_id`/`eventId` deben cumplir el patron UUID del validador de `outbox` (migracion 005). */
const EVENT_IDS = {
  'ev-created': '11111111-1111-4111-8111-111111111111',
  'ev-suspended': '22222222-2222-4222-8222-222222222222',
  'ev-reactivated': '33333333-3333-4333-8333-333333333333',
  'ev-inventory': '44444444-4444-4444-8444-444444444444',
  'ev-premium': '55555555-5555-4555-8555-555555555555',
  'ev-depleted': '66666666-6666-4666-8666-666666666666',
  'ev-cualquiera': '77777777-7777-4777-8777-777777777777',
  'ev-correlacion': '88888888-8888-4888-8888-888888888888',
} as const satisfies Readonly<Record<string, string>>

const buildEntry = (
  alias: keyof typeof EVENT_IDS,
  eventType: string,
  correlationId: string | null = 'req-1',
): OutboxEntry => ({
  eventId: EVENT_IDS[alias],
  aggregateId: '99999999-9999-4999-8999-999999999999',
  aggregateType: 'CanonicalProduct',
  eventType,
  eventVersion: 1,
  status: OutboxStatus.Pending,
  payload: { productId: 'agg-1' },
  createdAt: new Date('2026-09-06T10:00:00.000Z'),
  updatedAt: new Date('2026-09-06T10:00:00.000Z'),
  leaseExpiresAt: null,
  attempts: 0,
  lastError: null,
  dispatchedAt: null,
  purgeAt: null,
  correlationId,
})

/**
 * HU-38, seccion 34: el filtro de `allowedEventTypes` en `claim()` tambien
 * debe cumplirse contra MongoDB real, no solo contra el doble en memoria -la
 * query usa `$in` sobre `eventType` junto al `$or` de lease existente, y esa
 * combinacion es exactamente lo que una prueba unitaria no puede verificar.
 */
describe('MongoProductOutboxRepository: claim() filtrado por eventType (HU-38)', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoProductOutboxRepository

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  beforeEach(async () => {
    repository = new MongoProductOutboxRepository(db)
    await db.collection('outbox').deleteMany({})
  })

  it('reclama created y los cuatro lifecycle, pero NO stock.depleted', async () => {
    await repository.record(buildEntry('ev-created', 'catalog.product.created'))
    await repository.record(buildEntry('ev-suspended', 'catalog.product.suspended'))
    await repository.record(buildEntry('ev-reactivated', 'catalog.product.reactivated'))
    await repository.record(buildEntry('ev-inventory', 'catalog.product.inventory.adjusted'))
    await repository.record(buildEntry('ev-premium', 'catalog.product.premium.configured'))
    await repository.record(buildEntry('ev-depleted', 'catalog.product.stock.depleted', null))

    const claimed = await repository.claim('worker-1', 10, 30_000, DISPATCHABLE_EVENT_TYPES)

    expect(claimed).toHaveLength(5)
    expect(claimed.map((entry) => entry.eventId).sort()).toEqual(
      [
        EVENT_IDS['ev-created'],
        EVENT_IDS['ev-suspended'],
        EVENT_IDS['ev-reactivated'],
        EVENT_IDS['ev-inventory'],
        EVENT_IDS['ev-premium'],
      ].sort(),
    )
    for (const entry of claimed) {
      expect(entry.status).toBe(OutboxStatus.InFlight)
    }

    const depleted = await repository.findByEventId(EVENT_IDS['ev-depleted'])
    expect(depleted?.status).toBe(OutboxStatus.Pending)
    expect(depleted?.attempts).toBe(0)
  })

  it('sin allowedEventTypes reclama cualquier evento (compatibilidad hacia atras)', async () => {
    await repository.record(buildEntry('ev-cualquiera', 'catalog.product.stock.depleted', null))

    const claimed = await repository.claim('worker-1', 10, 30_000)

    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.eventId).toBe(EVENT_IDS['ev-cualquiera'])
  })

  it('persiste y recupera correlationId', async () => {
    await repository.record(buildEntry('ev-correlacion', 'catalog.product.created', 'req-xyz'))

    const found = await repository.findByEventId(EVENT_IDS['ev-correlacion'])
    expect(found?.correlationId).toBe('req-xyz')
  })
})
