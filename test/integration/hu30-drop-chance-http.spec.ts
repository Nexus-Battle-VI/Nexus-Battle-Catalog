import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import {
  Role,
  TOKEN_VERIFIER,
  TokenVerificationError,
  type TokenVerifierPort,
  type VerifiedIdentity,
} from '../../src/application/ports/TokenVerifierPort'
import {
  MFA_EVIDENCE_VERIFIER,
  MfaEvidenceOutcome,
  type MfaEvidenceVerifierPort,
} from '../../src/application/ports/MfaEvidenceVerifierPort'

const ADMIN: VerifiedIdentity = {
  subject: 'sujeto-admin',
  email: null,
  roles: new Set([Role.Player, Role.Administrator]),
  jti: 'jti-con-evidencia',
  expiresAt: new Date(Date.now() + 900_000),
}

const JUGADOR: VerifiedIdentity = {
  subject: 'sujeto-jugador',
  email: null,
  roles: new Set([Role.Player]),
  jti: 'jti-jugador',
  expiresAt: new Date(Date.now() + 900_000),
}

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-admin': ADMIN,
  'token-jugador': JUGADOR,
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

const stubEvidence: MfaEvidenceVerifierPort = {
  verify: (): Promise<MfaEvidenceOutcome> => Promise.resolve(MfaEvidenceOutcome.Valid),
}

const ARMA = (sku: string): Record<string, unknown> => ({
  sku,
  name: `Arma ${sku}`,
  imageUrl: 'https://assets.example.test/img.png',
  description: 'Descripcion valida.',
  type: 'ARMA',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
      dropChanceBasisPoints: 100,
    },
  },
  printRun: -1,
  creditsPrice: 500,
  premium: false,
})

/**
 * HU-30 (Task HU-30.1) sobre HTTP: configurar la tasa de caida Versus de un
 * producto ARMA/ARMADURA/ITEM ya existente. Brecha confirmada en auditoria:
 * `PATCH :id/details` declara `attributes` no editable a proposito, y sin
 * esta ruta un producto creado antes de HU-30 no podria volver a equiparse en
 * Versus (Player-Inventory rechaza la instantanea con
 * `DROP_RATE_UNAVAILABLE`).
 */
describe('HU-30 sobre HTTP: PATCH /api/v1/admin/products/{id}/drop-chance', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (
    body: Record<string, unknown>,
  ): Promise<{ productId: string; attributes: { values: Record<string, unknown> } }> => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .send(body)
      .expect(201)

    return respuesta.body as { productId: string; attributes: { values: Record<string, unknown> } }
  }

  beforeAll(async () => {
    previousEnv = {
      AUTH_MODE: process.env.AUTH_MODE,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    }

    process.env.AUTH_MODE = 'jwt'
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pruebas'
    process.env.COGNITO_CLIENT_ID = 'cliente-de-pruebas'

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(MFA_EVIDENCE_VERIFIER)
      .useValue(stubEvidence)
      .compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )
    await app.init()
  })

  afterAll(async () => {
    await app.close()

    for (const [clave, valor] of Object.entries(previousEnv)) {
      process.env[clave] = valor
    }
  })

  it('configura la tasa de un ARMA sin tasa previa', async () => {
    const { productId } = await crearProducto(ARMA('espada-historica-1'))

    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 500 })
      .expect(200)

    const values = (respuesta.body as { attributes: { values: Record<string, unknown> } })
      .attributes.values
    expect(values.dropChanceBasisPoints).toBe(500)
  })

  it('un segundo ajuste reemplaza la tasa anterior', async () => {
    const { productId } = await crearProducto(ARMA('espada-historica-2'))

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 500 })
      .expect(200)

    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 900 })
      .expect(200)

    const values = (respuesta.body as { attributes: { values: Record<string, unknown> } })
      .attributes.values
    expect(values.dropChanceBasisPoints).toBe(900)
  })

  // El rechazo 422 de un producto HEROE (solo ARMA/ARMADURA/ITEM tienen tasa
  // de caida Versus) ya esta cubierto a nivel de dominio y caso de uso en
  // `test/unit/hu30-configure-drop-chance.spec.ts`: montar aqui un HEROE
  // valido exigiria registrar un `heroSubtype` real (HU-07, ajeno a HU-30).

  it('rechaza una tasa fuera de 0..10000 (400)', async () => {
    const { productId } = await crearProducto(ARMA('espada-historica-3'))

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: -1 })
      .expect(400)

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 10_001 })
      .expect(400)
  })

  it('un producto inexistente es 404', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/drop-chance')
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 500 })
      .expect(404)
  })

  it('un jugador no puede configurar la tasa', async () => {
    const { productId } = await crearProducto(ARMA('espada-historica-4'))

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-jugador')
      .send({ dropChanceBasisPoints: 500 })
      .expect(403)
  })

  it('sin testimonio es 401', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/drop-chance')
      .send({ dropChanceBasisPoints: 500 })
      .expect(401)
  })

  it('un campo no declarado en el cuerpo es 400', async () => {
    const { productId } = await crearProducto(ARMA('espada-historica-5'))

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 500, type: 'EPICA' })
      .expect(400)
  })

  it('no toca name/imageUrl/description/effects del producto', async () => {
    const creado = await crearProducto(ARMA('espada-historica-6'))

    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${creado.productId}/drop-chance`)
      .set('Authorization', 'Bearer token-admin')
      .send({ dropChanceBasisPoints: 250 })
      .expect(200)

    const body = respuesta.body as {
      name: string
      attributes: { values: Record<string, unknown> }
    }
    expect(body.name).toBe('Arma espada-historica-6')
    expect(body.attributes.values.effects).toEqual(creado.attributes.values.effects)
  })
})
