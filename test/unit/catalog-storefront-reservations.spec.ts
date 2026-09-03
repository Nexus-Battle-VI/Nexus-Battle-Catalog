import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryStockReservationRepository } from '../../src/adapters/outbound/persistence/InMemoryStockReservationRepository'
import { ListCatalogStorefront } from '../../src/application/use-cases/ListCatalogStorefront'
import { StockReservations } from '../../src/application/use-cases/StockReservations'
import { DomainError } from '../../src/domain/errors/DomainError'
import { catalogFixture } from '../support/storefront-fixtures'

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('Canonical storefront and stock reservations', () => {
  let products: InMemoryCanonicalProductRepository
  let reservations: StockReservations
  let storefront: ListCatalogStorefront
  beforeEach(() => {
    products = new InMemoryCanonicalProductRepository()
    reservations = new StockReservations(new InMemoryStockReservationRepository(products), {
      now: () => new Date('2026-09-03T01:00:00Z'),
    })
    storefront = new ListCatalogStorefront(products)
  })

  it('paginates 17 active canonical products and preserves sold out/infinite states', async () => {
    for (let n = 1; n <= 17; n++)
      await products.create(
        catalogFixture(n, n === 1 ? { availableUnits: 0 } : n === 17 ? { printRun: -1 } : {}),
      )
    await products.create(catalogFixture(18, { suspended: true }))
    const page1 = await storefront.execute({})
    const page2 = await storefront.execute({ page: 2 })
    expect(page1).toMatchObject({ page: 1, pageSize: 16, total: 17 })
    expect(page1.items).toHaveLength(16)
    expect(page1.items[0]?.availableUnits).toBe(0)
    expect(page2.items).toHaveLength(1)
    expect(page2.items[0]?.availableUnits).toBeNull()
    expect((await storefront.execute({ page: 3 })).items).toEqual([])
  })

  it('combines literal nested attribute search, type and fiat price without currency conversion', async () => {
    await products.create(catalogFixture(1, { currency: 'USD', amount: 999 }))
    await products.create(catalogFixture(2, { currency: 'COP', amount: 999 }))
    await products.create(catalogFixture(3))
    expect(
      (
        await storefront.execute({
          query: 'damage',
          type: 'ARMA',
          currency: 'USD',
          minPrice: 900,
          maxPrice: 1000,
        })
      ).total,
    ).toBe(1)
    expect((await storefront.execute({ query: '999' })).total).toBe(2)
    expect((await storefront.execute({ query: 'fuego' })).total).toBe(3)
    expect((await storefront.execute({ query: '.*' })).total).toBe(0)
    expect((await storefront.execute({ type: 'ITEM' })).total).toBe(0)
    await expect(storefront.execute({ minPrice: 1 })).rejects.toThrow('currency')
    await expect(
      storefront.execute({ currency: 'USD', minPrice: 10, maxPrice: 1 }),
    ).rejects.toThrow('minPrice')
    await expect(storefront.execute({ currency: 'BTC' })).rejects.toThrow('currency')
    await expect(storefront.execute({ page: 0 })).rejects.toThrow('page')
    await expect(storefront.execute({ currency: 'USD', maxPrice: 0.5 })).rejects.toThrow('enteros')
  })

  it('preserves a negative outcome after restock without partially reserving the batch', async () => {
    const first = catalogFixture(1)
    const second = catalogFixture(2, { availableUnits: 0 })
    await products.create(first)
    await products.create(second)
    const command = {
      reservationId: ID,
      playerId: 'player',
      lines: [
        { productId: first.productId.value, quantity: 2 },
        { productId: second.productId.value, quantity: 1 },
      ],
    }
    await expect(reservations.reserve(command)).rejects.toThrow('unidades')
    expect((await products.findById(first.productId))?.availableUnits).toBe(5)
    await products.update(
      second.adjustPrintRun(second.printRun, new Date()).releaseUnits(1, new Date()),
      0,
    )
    await expect(reservations.reserve(command)).rejects.toThrow('unidades')
    await expect(reservations.transition(ID, { playerId: 'player' }, 'CONFIRMED')).rejects.toThrow(
      'REJECTED',
    )
    expect((await reservations.reserve({ ...command, reservationId: SECOND_ID })).state).toBe(
      'RESERVED',
    )
  })

  it('normalizes line ordering, replays once, rejects altered payload, confirms without another decrement', async () => {
    const first = catalogFixture(1)
    const infinite = catalogFixture(2, { printRun: -1 })
    await products.create(first)
    await products.create(infinite)
    const lines = [
      { productId: first.productId.value, quantity: 2 },
      { productId: infinite.productId.value, quantity: 9 },
    ]
    expect(
      (await reservations.reserve({ reservationId: ID, playerId: 'player', lines })).replayed,
    ).toBe(false)
    expect(
      (
        await reservations.reserve({
          reservationId: ID,
          playerId: 'player',
          lines: [...lines].reverse(),
        })
      ).replayed,
    ).toBe(true)
    await expect(
      reservations.reserve({ reservationId: ID, playerId: 'other', lines }),
    ).rejects.toThrow('otra operación')
    await expect(
      reservations.reserve({
        reservationId: ID,
        playerId: 'player',
        lines: [{ ...lines[0], quantity: 1 }],
      }),
    ).rejects.toThrow('otra operación')
    await reservations.transition(ID, { playerId: 'player' }, 'CONFIRMED')
    expect((await reservations.transition(ID, { playerId: 'player' }, 'CONFIRMED')).replayed).toBe(
      true,
    )
    await expect(reservations.transition(ID, { playerId: 'player' }, 'RELEASED')).rejects.toThrow(
      'CONFIRMED',
    )
    expect((await products.findById(first.productId))?.availableUnits).toBe(3)
    expect((await products.findById(infinite.productId))?.version).toBe(0)
  })

  it('releases once, preserves the identity, prevents reactivation and conflicting transitions', async () => {
    const product = catalogFixture(1)
    await products.create(product)
    const command = {
      reservationId: ID,
      playerId: 'player',
      lines: [{ productId: product.productId.value, quantity: 5 }],
    }
    await reservations.reserve(command)
    await expect(reservations.transition(ID, { playerId: 'other' }, 'RELEASED')).rejects.toThrow(
      'otro jugador',
    )
    await reservations.transition(ID, { playerId: 'player' }, 'RELEASED')
    expect((await reservations.transition(ID, { playerId: 'player' }, 'RELEASED')).replayed).toBe(
      true,
    )
    expect((await reservations.reserve(command)).state).toBe('RELEASED')
    await expect(reservations.transition(ID, { playerId: 'player' }, 'CONFIRMED')).rejects.toThrow(
      'RELEASED',
    )
    expect((await products.findById(product.productId))?.availableUnits).toBe(5)
    await expect(
      reservations.transition(SECOND_ID, { playerId: 'player' }, 'CONFIRMED'),
    ).rejects.toThrow('No existe')
  })

  it('rejects inactive and unknown products, invalid quantities, duplicate lines and unknown fields', async () => {
    const product = catalogFixture(1, { suspended: true })
    await products.create(product)
    const line = { productId: product.productId.value, quantity: 1 }
    const command = { reservationId: ID, playerId: 'player', lines: [line] }
    await expect(reservations.reserve(command)).rejects.toThrow('suspendido')
    await expect(
      reservations.reserve({
        ...command,
        reservationId: SECOND_ID,
        lines: [{ productId: SECOND_ID, quantity: 1 }],
      }),
    ).rejects.toThrow('no existe')
    for (const body of [
      { ...command, lines: [] },
      { ...command, lines: [line, line] },
      { ...command, lines: [{ ...line, quantity: 0 }] },
      { ...command, playerId: '' },
      { ...command, surprise: true },
    ]) {
      expect(() => reservations.reserve(body)).toThrow(DomainError)
    }
    await expect(products.decrementAvailability(product.productId)).resolves.toBeNull()
    expect(() => product.reserveUnits(1, new Date())).toThrow('suspendido')
    expect(() => catalogFixture(2).reserveUnits(0, new Date())).toThrow('entero')
    expect(() => catalogFixture(2).releaseUnits(1, new Date())).toThrow('tiraje')
  })

  it('concurrent reservations cannot overdraw the same last unit', async () => {
    const product = catalogFixture(1, { printRun: 1 })
    await products.create(product)
    const results = await Promise.allSettled(
      [ID, SECOND_ID].map((reservationId) =>
        reservations.reserve({
          reservationId,
          playerId: 'player',
          lines: [{ productId: product.productId.value, quantity: 1 }],
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect((await products.findById(product.productId))?.availableUnits).toBe(0)
  })
})
