import 'reflect-metadata'
import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { CANONICAL_PRODUCT_REPOSITORY } from '../../src/application/ports/CanonicalProductPorts'
import type { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { catalogFixture } from '../support/storefront-fixtures'

const SECRET = 'test-only-catalog-reservation-secret'
const PATH = '/api/internal/v1/catalog/reservations'
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('Storefront and internal stock HTTP contract', () => {
  let app: INestApplication
  let products: InMemoryCanonicalProductRepository
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(
        loadConfig({
          NODE_ENV: 'test',
          AUTH_MODE: 'disabled',
          INTERNAL_SERVICE_AUTH_SECRET: SECRET,
        }),
      )
      .compile()
    app = module.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
    products = app.get<InMemoryCanonicalProductRepository>(CANONICAL_PRODUCT_REPOSITORY)
    for (let n = 1; n <= 17; n++)
      await products.create(catalogFixture(n, { currency: 'USD', amount: 999 }))
    await products.create(catalogFixture(18, { suspended: true }))
  })
  afterAll(async () => {
    await app.close()
  })

  const signed = (
    path: string,
    body: object,
    service = 'commerce',
    timestamp = String(Date.now()),
  ): request.Test =>
    request(app.getHttpServer())
      .post(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(SECRET, { service, method: 'POST', path, timestamp, body }),
      )
      .send(body)

  it('serves a canonical collection, stable 16-item pages and nested-information search', async () => {
    const first = await request(app.getHttpServer()).get('/api/v1/catalog/products').expect(200)
    expect(first.body).toMatchObject({ page: 1, pageSize: 16, total: 17 })
    expect(first.body.items).toHaveLength(16)
    expect(first.body.items[0]).toMatchObject({
      productId: catalogFixture(1).productId.value,
      lifecycleStatus: 'ACTIVE',
      creditsPrice: 42,
      premium: true,
      realMoneyPrice: { amount: 999, currency: 'USD' },
    })
    const second = await request(app.getHttpServer())
      .get(
        '/api/v1/catalog/products?page=2&query=damage&type=ARMA&currency=USD&minPrice=999&maxPrice=999',
      )
      .expect(200)
    expect(second.body.items).toHaveLength(1)
    expect(second.body.total).toBe(17)
    const none = await request(app.getHttpServer())
      .get('/api/v1/catalog/products?query=.*')
      .expect(200)
    expect(none.body).toMatchObject({ items: [], total: 0 })
  })

  it.each([
    'page=0',
    'page=1.5',
    'type=weapon',
    'minPrice=5',
    'currency=USD&minPrice=20&maxPrice=10',
    'currency=BTC',
    'promotion=true',
    'page=1&page=2',
  ])('rejects invalid or unsupported filters: %s', async (query) => {
    await request(app.getHttpServer()).get(`/api/v1/catalog/products?${query}`).expect(400)
  })

  it('requires signed service requests, rejects unknown services and expired signatures', async () => {
    const body = {
      reservationId: ID,
      playerId: 'player',
      lines: [{ productId: catalogFixture(1).productId.value, quantity: 1 }],
    }
    await request(app.getHttpServer()).post(PATH).send(body).expect(401)
    await signed(PATH, body, 'web').expect(401)
    await signed(PATH, body, 'commerce', '0').expect(401)
    await signed(PATH, { ...body, lines: [] }).expect(400)
  })

  it('returns 200 and stable replay, separates rejected stock from conflicting identity, confirms without decrement', async () => {
    const product = catalogFixture(1)
    const body = {
      reservationId: ID,
      playerId: 'player',
      lines: [{ productId: product.productId.value, quantity: 2 }],
    }
    const reserved = await signed(PATH, body).expect(200)
    expect(reserved.body).toMatchObject({ reservationId: ID, state: 'RESERVED', replayed: false })
    const replay = await signed(PATH, body).expect(200)
    expect(replay.body.replayed).toBe(true)
    const conflict = await signed(PATH, { ...body, playerId: 'other' }).expect(409)
    expect(conflict.body.code).toBe('RESERVATION_CONFLICT')
    const rejected = await signed(PATH, {
      ...body,
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      lines: [{ productId: product.productId.value, quantity: 9 }],
    }).expect(409)
    expect(rejected.body.code).toBe('RESERVATION_REJECTED')
    await signed(`${PATH}/${ID}/confirmation`, { playerId: 'player' }).expect(200)
    const confirmed = await signed(`${PATH}/${ID}/confirmation`, { playerId: 'player' }).expect(200)
    expect(confirmed.body).toMatchObject({ state: 'CONFIRMED', replayed: true })
    await signed(`${PATH}/${ID}/release`, { playerId: 'player' }).expect(409)
    expect((await products.findById(product.productId))?.availableUnits).toBe(3)
  })

  it('releases exactly once and reports missing products/reservations without inventing stock', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const body = {
      reservationId: id,
      playerId: 'player',
      lines: [{ productId: catalogFixture(2).productId.value, quantity: 1 }],
    }
    await signed(PATH, body).expect(200)
    await signed(`${PATH}/${id}/release`, { playerId: 'player' }).expect(200)
    const replay = await signed(`${PATH}/${id}/release`, { playerId: 'player' }).expect(200)
    expect(replay.body).toMatchObject({ state: 'RELEASED', replayed: true })
    await signed(`${PATH}/dddddddd-dddd-4ddd-8ddd-dddddddddddd/confirmation`, {
      playerId: 'player',
    }).expect(404)
    const missing = await signed(PATH, {
      ...body,
      reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      lines: [{ productId: id, quantity: 1 }],
    }).expect(404)
    expect(missing.body).toMatchObject({ code: 'RESERVATION_REJECTED' })
    expect((await products.findById(catalogFixture(2).productId))?.availableUnits).toBe(5)
  })
})
