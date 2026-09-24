import 'reflect-metadata'
import { type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { CANONICAL_PRODUCT_REPOSITORY } from '../../src/application/ports/CanonicalProductPorts'
import type { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { catalogFixture } from '../support/storefront-fixtures'

const SECRET = 'test-only-official-auction-secret'

describe('Contrato de elegibilidad para subasta oficial HU-66', () => {
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
    await app.init()
    products = app.get<InMemoryCanonicalProductRepository>(CANONICAL_PRODUCT_REPOSITORY)

    await products.create(catalogFixture(101, { printRun: 1 }))
    await products.create(catalogFixture(102, { currency: 'COP', amount: 90_000 }))
    await products.create(catalogFixture(103))
    await products.create(catalogFixture(104, { printRun: 1, suspended: true }))
  })

  afterAll(async () => app.close())

  const pathFor = (sequence: number): string =>
    `/api/internal/v1/catalog/products/${catalogFixture(sequence).productId.value}/official-auction-eligibility`

  const signedGet = (path: string, service = 'auction', secret = SECRET): request.Test => {
    const timestamp = String(Date.now())
    return request(app.getHttpServer())
      .get(path)
      .set('x-internal-service', service)
      .set('x-internal-timestamp', timestamp)
      .set(
        'x-internal-signature',
        signInternalRequest(secret, { service, method: 'GET', path, timestamp, body: {} }),
      )
  }

  it('clasifica un producto unico como OFFICIAL publicable', async () => {
    const response = await signedGet(pathFor(101)).expect(200)
    expect(response.body).toEqual({
      productId: catalogFixture(101).productId.value,
      exclusive: true,
      officialMark: 'OFFICIAL',
      publishable: true,
    })
  })

  it('clasifica un producto premium como PREMIUM publicable', async () => {
    const response = await signedGet(pathFor(102)).expect(200)
    expect(response.body).toEqual({
      productId: catalogFixture(102).productId.value,
      exclusive: true,
      officialMark: 'PREMIUM',
      publishable: true,
    })
  })

  it('niega elegibilidad a productos ordinarios y suspendidos', async () => {
    const ordinary = await signedGet(pathFor(103)).expect(200)
    expect(ordinary.body as unknown).toEqual({
      productId: catalogFixture(103).productId.value,
      exclusive: false,
      officialMark: null,
      publishable: false,
    })
    const suspended = await signedGet(pathFor(104)).expect(200)
    expect(suspended.body as unknown).toMatchObject({
      exclusive: true,
      officialMark: 'OFFICIAL',
      publishable: false,
    })
  })

  it('responde 404 para un producto inexistente', async () => {
    await signedGet(pathFor(999)).expect(404)
  })

  it('solo admite a Auction con una firma HMAC valida', async () => {
    await request(app.getHttpServer()).get(pathFor(101)).expect(401)
    await signedGet(pathFor(101), 'commerce').expect(401)
    await signedGet(pathFor(101), 'auction', 'wrong-secret').expect(401)
  })
})
