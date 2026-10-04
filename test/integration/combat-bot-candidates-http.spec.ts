import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { CANONICAL_PRODUCT_REPOSITORY } from '../../src/application/ports/CanonicalProductPorts'
import type { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { signInternalRequest } from '../../src/adapters/outbound/identity/internal-signature'
import { AppModule, APP_CONFIG } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { createCatalogOpenApiDocument } from '../../src/infrastructure/openapi/catalog-openapi'
import { ProductType } from '../../src/domain/value-objects/canonical-product-values'
import {
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
} from '../../src/application/ports/TokenVerifierPort'
import {
  combatCatalogProduct,
  combatProductId,
  damageEffect,
  fixedMagnitude,
} from '../support/combat-bot-candidates-fixtures'

const SECRET = 'test-only-combat-bot-candidates-secret'
const PATH = '/api/internal/v1/catalog/combat/bot-candidates'

const createApp = async (secret: string | null): Promise<INestApplication> => {
  const rejectingVerifier: TokenVerifierPort = {
    verify: () => Promise.reject(new TokenVerificationError()),
  }
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(
      loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_aaaaaaaaa',
        COGNITO_CLIENT_ID: 'contract-test-client',
        ...(secret === null ? {} : { INTERNAL_SERVICE_AUTH_SECRET: secret }),
      }),
    )
    .overrideProvider(TOKEN_VERIFIER)
    .useValue(rejectingVerifier)
    .compile()
  const app = module.createNestApplication()
  app.setGlobalPrefix('api')
  await app.init()
  return app
}

const signedGet = (
  app: INestApplication,
  options: {
    readonly service?: string
    readonly secret?: string
    readonly timestamp?: string
  } = {},
): request.Test => {
  const service = options.service ?? 'combat'
  const timestamp = options.timestamp ?? String(Date.now())
  const secret = options.secret ?? SECRET

  return request(app.getHttpServer())
    .get(PATH)
    .set('x-internal-service', service)
    .set('x-internal-timestamp', timestamp)
    .set(
      'x-internal-signature',
      signInternalRequest(secret, { service, method: 'GET', path: PATH, timestamp, body: {} }),
    )
}

describe('GET /api/internal/v1/catalog/combat/bot-candidates', () => {
  let app: INestApplication
  let products: InMemoryCanonicalProductRepository

  beforeAll(async () => {
    app = await createApp(SECRET)
    products = app.get<InMemoryCanonicalProductRepository>(CANONICAL_PRODUCT_REPOSITORY)

    const abilities = [1, 2, 3].map((sequence) =>
      combatCatalogProduct(sequence, ProductType.Ability, {
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
        powerCostMode: 'FIXED',
        powerCost: sequence,
        effects: [damageEffect(sequence)],
      }),
    )
    for (const product of abilities) await products.create(product)
    await products.create(
      combatCatalogProduct(10, ProductType.Hero, {
        kind: 'HEROE',
        heroSubtype: 'GUERRERO_ARMAS',
        basePower: 8,
        baseHealth: 30,
        baseDefense: 5,
        baseAttack: fixedMagnitude(3),
        baseDamage: { mode: 'DICE', count: 1, sides: 8 },
        abilities: abilities.map((ability) => ability.productId.value),
      }),
    )
    await products.create(
      combatCatalogProduct(20, ProductType.Weapon, {
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [damageEffect(2)],
      }),
    )
  })

  afterAll(async () => app.close())

  it('devuelve el schema gameplay exacto a Combat con HMAC válido y sin bearer', async () => {
    const response = await signedGet(app).expect(200)

    expect(response.body).toEqual({
      schemaVersion: '1',
      heroes: [
        {
          productId: combatProductId(10),
          sku: 'combat-010',
          heroSubtype: 'GUERRERO_ARMAS',
          basePower: 8,
          baseHealth: 30,
          baseDefense: 5,
          baseAttack: { mode: 'FIXED', amount: 3 },
          baseDamage: { mode: 'DICE', count: 1, sides: 8 },
          abilities: [combatProductId(1), combatProductId(2), combatProductId(3)],
        },
      ],
      abilities: [1, 2, 3].map((sequence) => ({
        productId: combatProductId(sequence),
        sku: `combat-${String(sequence).padStart(3, '0')}`,
        compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
        powerCostMode: 'FIXED',
        powerCost: sequence,
        chargeTurns: 1,
        effects: [
          {
            kind: 'DAMAGE',
            target: 'OPPONENT',
            magnitude: { mode: 'FIXED', amount: sequence },
            stackable: false,
          },
        ],
      })),
      equipment: [
        {
          productId: combatProductId(20),
          sku: 'combat-020',
          type: 'ARMA',
          compatibilityScope: 'ALL_HEROES',
          effects: [
            {
              kind: 'DAMAGE',
              target: 'OPPONENT',
              magnitude: { mode: 'FIXED', amount: 2 },
              stackable: false,
            },
          ],
        },
      ],
      epics: [],
    })
  })

  it('rechaza firma ausente, inválida, caller distinto y timestamp vencido', async () => {
    await request(app.getHttpServer()).get(PATH).expect(401)
    await signedGet(app, { secret: 'wrong-secret' }).expect(401)
    await signedGet(app, { service: 'commerce' }).expect(401)
    await signedGet(app, { service: 'community' }).expect(401)
    await signedGet(app, { timestamp: String(Date.now() - 31_000) }).expect(401)
  })

  it('falla cerrado con 503 cuando no existe secreto interno', async () => {
    const withoutSecret = await createApp(null)
    try {
      await signedGet(withoutSecret).expect(503)
    } finally {
      await withoutSecret.close()
    }
  })

  it('no concede a Combat acceso a otros contratos internos', async () => {
    const path = `/api/internal/v1/catalog/products/${combatProductId(20)}/official-auction-eligibility`
    const timestamp = String(Date.now())
    const signature = signInternalRequest(SECRET, {
      service: 'combat',
      method: 'GET',
      path,
      timestamp,
      body: {},
    })

    await request(app.getHttpServer())
      .get(path)
      .set('x-internal-service', 'combat')
      .set('x-internal-timestamp', timestamp)
      .set('x-internal-signature', signature)
      .expect(401)
  })

  it('permanece fuera del OpenAPI público', () => {
    const document = createCatalogOpenApiDocument(
      app,
      loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'disabled' }),
    )

    expect(document.paths[PATH]).toBeUndefined()
  })
})
