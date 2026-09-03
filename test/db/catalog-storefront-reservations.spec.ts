import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'
import { MongoCanonicalProductRepository } from '../../src/adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoStockReservationRepository } from '../../src/adapters/outbound/persistence/MongoStockReservationRepository'
import { ListCatalogStorefront } from '../../src/application/use-cases/ListCatalogStorefront'
import {
  StockReservations,
  StockReservationRejectedError,
} from '../../src/application/use-cases/StockReservations'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { up } from '../../src/adapters/outbound/persistence/migrations/010-stock-reservations'
import { PrintRun } from '../../src/domain/value-objects/canonical-product-values'
import { catalogFixture } from '../support/storefront-fixtures'
import { closeMongoTestResources } from '../support/mongo-test-resources'

const id = (n: number): string => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

describe('Mongo storefront and durable batch reservations', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient
  let db: Db
  let products: MongoCanonicalProductRepository
  let reservations: StockReservations
  const createReservations = (): StockReservations =>
    new StockReservations(new MongoStockReservationRepository(db, client), {
      now: () => new Date(),
    })
  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    expect((await migrateToLatest(db)).error).toBeUndefined()
    products = new MongoCanonicalProductRepository(db)
  }, 180_000)
  beforeEach(async () => {
    await db.collection('products').deleteMany({})
    await db.collection('stock_reservations').deleteMany({})
    reservations = createReservations()
  })
  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  it('migration is repeatable, durable records have no TTL, storefront excludes suspended and combines all filters', async () => {
    await up(db)
    const indexes = await db.collection('stock_reservations').indexes()
    expect(indexes.every((index) => index.expireAfterSeconds === undefined)).toBe(true)
    for (let n = 1; n <= 17; n++) await products.create(catalogFixture(n, { currency: 'USD' }))
    await products.create(catalogFixture(18, { suspended: true, currency: 'USD' }))
    await products.create(catalogFixture(19, { currency: 'COP' }))
    const query = new ListCatalogStorefront(products)
    const first = await query.execute({
      query: 'damage',
      currency: 'USD',
      minPrice: 999,
      maxPrice: 999,
      type: 'ARMA',
    })
    expect(first.items).toHaveLength(16)
    expect(first.total).toBe(17)
    expect((await query.execute({ currency: 'USD', page: 2 })).items).toHaveLength(1)
    expect((await query.execute({ query: '999' })).total).toBe(18)
    expect((await query.execute({ query: '.*' })).total).toBe(0)
  })

  it('stores a negative outcome with no partial stock and preserves it after restock', async () => {
    const one = catalogFixture(1)
    const two = catalogFixture(2, { availableUnits: 0 })
    await products.create(one)
    await products.create(two)
    const command = {
      reservationId: id(1),
      playerId: 'player',
      lines: [
        { productId: one.productId.value, quantity: 2 },
        { productId: two.productId.value, quantity: 1 },
      ],
    }
    await expect(reservations.reserve(command)).rejects.toBeInstanceOf(
      StockReservationRejectedError,
    )
    expect((await products.findById(one.productId))?.availableUnits).toBe(5)
    expect(await db.collection('stock_reservations').countDocuments({ state: 'REJECTED' })).toBe(1)
    await products.update(two.adjustPrintRun(PrintRun.create(6), new Date()), 0)
    await expect(createReservations().reserve(command)).rejects.toBeInstanceOf(
      StockReservationRejectedError,
    )
    await expect(
      reservations.transition(id(1), { playerId: 'player' }, 'CONFIRMED'),
    ).rejects.toThrow('REJECTED')
    await reservations.reserve({ ...command, reservationId: id(2) })
    expect((await products.findById(one.productId))?.availableUnits).toBe(3)
  })

  it('one winner for concurrent last-unit reservations, persisted replay after adapter reconstruction', async () => {
    const product = catalogFixture(1, { printRun: 1 })
    await products.create(product)
    const lines = [{ productId: product.productId.value, quantity: 1 }]
    const attempts = await Promise.allSettled(
      Array.from({ length: 12 }, (_, n) =>
        reservations.reserve({ reservationId: id(n + 1), playerId: 'player', lines }),
      ),
    )
    const won = attempts.filter((result) => result.status === 'fulfilled')
    expect(won).toHaveLength(1)
    const winner = won[0]
    if (winner?.status !== 'fulfilled') throw new Error('Expected a winner')
    const resumed = createReservations()
    expect(
      (
        await resumed.reserve({
          reservationId: winner.value.reservationId,
          playerId: 'player',
          lines,
        })
      ).replayed,
    ).toBe(true)
    expect((await products.findById(product.productId))?.availableUnits).toBe(0)
    expect(await db.collection('stock_reservations').countDocuments({ state: 'RESERVED' })).toBe(1)
    expect(await db.collection('stock_reservations').countDocuments({ state: 'REJECTED' })).toBe(11)
  })

  it('concurrent same-id attempts consume once; changed payload conflicts and confirm never consumes again', async () => {
    const product = catalogFixture(1)
    await products.create(product)
    const command = {
      reservationId: id(1),
      playerId: 'player',
      lines: [{ productId: product.productId.value, quantity: 2 }],
    }
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => reservations.reserve(command)),
    )
    expect(attempts.filter((attempt) => !attempt.replayed)).toHaveLength(1)
    await expect(reservations.reserve({ ...command, playerId: 'other' })).rejects.toThrow(
      'otra operación',
    )
    await reservations.transition(id(1), { playerId: 'player' }, 'CONFIRMED')
    expect(
      (await createReservations().transition(id(1), { playerId: 'player' }, 'CONFIRMED')).replayed,
    ).toBe(true)
    await expect(
      reservations.transition(id(1), { playerId: 'player' }, 'RELEASED'),
    ).rejects.toThrow('CONFIRMED')
    expect((await products.findById(product.productId))?.availableUnits).toBe(3)
  })

  it('release is atomic and idempotent across retries, infinite stock is never modified', async () => {
    const finite = catalogFixture(1)
    const infinite = catalogFixture(2, { printRun: -1 })
    await products.create(finite)
    await products.create(infinite)
    const command = {
      reservationId: id(1),
      playerId: 'player',
      lines: [
        { productId: finite.productId.value, quantity: 4 },
        { productId: infinite.productId.value, quantity: 10 },
      ],
    }
    await reservations.reserve(command)
    const releases = await Promise.all(
      Array.from({ length: 8 }, () =>
        reservations.transition(id(1), { playerId: 'player' }, 'RELEASED'),
      ),
    )
    expect(releases.filter((release) => !release.replayed)).toHaveLength(1)
    expect((await createReservations().reserve(command)).state).toBe('RELEASED')
    await expect(
      reservations.transition(id(1), { playerId: 'player' }, 'CONFIRMED'),
    ).rejects.toThrow('RELEASED')
    expect((await products.findById(finite.productId))?.availableUnits).toBe(5)
    expect((await products.findById(infinite.productId))?.version).toBe(0)
  })

  it('rejects suspended finite/infinite and missing products without applying a batch', async () => {
    const finite = catalogFixture(1, { suspended: true })
    const infinite = catalogFixture(2, { suspended: true, printRun: -1 })
    await products.create(finite)
    await products.create(infinite)
    for (const [index, product] of [finite, infinite].entries()) {
      await expect(
        reservations.reserve({
          reservationId: id(index + 1),
          playerId: 'player',
          lines: [{ productId: product.productId.value, quantity: 1 }],
        }),
      ).rejects.toBeInstanceOf(StockReservationRejectedError)
      expect(await products.decrementAvailability(product.productId)).toBeNull()
    }
    await expect(
      reservations.reserve({
        reservationId: id(3),
        playerId: 'player',
        lines: [{ productId: id(10), quantity: 1 }],
      }),
    ).rejects.toThrow('no existe')
    await expect(
      reservations.transition(id(100), { playerId: 'player' }, 'CONFIRMED'),
    ).rejects.toThrow('No existe')
    expect(await db.collection('stock_reservations').countDocuments({ state: 'REJECTED' })).toBe(3)
  })
})
