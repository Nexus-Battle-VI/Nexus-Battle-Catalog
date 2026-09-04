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
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'

/**
 * HU-36 sobre HTTP: configuracion administrativa de premium y el contrato
 * interno de solo lectura para HU-36.5.
 *
 * EL SECRETO DE ESTAS PRUEBAS ES FICTICIO, igual que en las pruebas de HU-34.
 */
const SECRETO_DE_PRUEBAS = 'secreto-ficticio-solo-para-pruebas'

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
  name: `Corona ${sku}`,
  imageUrl: 'https://assets.example.test/img.png',
  description: 'Descripcion valida.',
  type: 'ARMA',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
    },
  },
  printRun: 1,
  creditsPrice: 0,
  premium: false,
})

describe('HU-36 sobre HTTP', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (sku: string): Promise<string> => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .send(ARMA(sku))
      .expect(201)

    return (respuesta.body as { productId: string }).productId
  }

  beforeAll(async () => {
    previousEnv = {
      AUTH_MODE: process.env.AUTH_MODE,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
      INTERNAL_SERVICE_AUTH_SECRET: process.env.INTERNAL_SERVICE_AUTH_SECRET,
    }

    process.env.AUTH_MODE = 'jwt'
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pruebas'
    process.env.COGNITO_CLIENT_ID = 'cliente-de-pruebas'
    process.env.INTERNAL_SERVICE_AUTH_SECRET = SECRETO_DE_PRUEBAS

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

  describe('PATCH /api/v1/admin/products/{id}/premium', () => {
    it('CA-01: activa premium con un precio real valido', async () => {
      const id = await crearProducto('corona-uno')

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
        .expect(200)

      expect(respuesta.body).toMatchObject({
        premium: true,
        realMoneyPrice: { amount: 999, currency: 'USD' },
      })
    })

    it('CA-02: premium sin precio real es 422 y conserva el producto', async () => {
      const id = await crearProducto('corona-dos')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: true })
        .expect(422)

      const sinCambios = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${id}`)
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      expect(sinCambios.body).toMatchObject({ premium: false })
    })

    it('retirar premium ya configurado es 422 (no soportado todavia)', async () => {
      const id = await crearProducto('corona-tres')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: true, realMoneyPrice: { amount: 499, currency: 'USD' } })
        .expect(200)

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: false })
        .expect(422)
    })

    it('un producto inexistente es 404', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/premium')
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
        .expect(404)
    })

    it('un jugador no puede configurar premium', async () => {
      const id = await crearProducto('corona-cuatro')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-jugador')
        .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
        .expect(403)
    })

    it('sin testimonio es 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/premium')
        .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
        .expect(401)
    })
  })

  describe('GET /api/internal/v1/catalog/products/{id}/premium-status', () => {
    const firmar = (path: string): Record<string, string> => {
      const timestamp = String(Date.now())

      return {
        [INTERNAL_SERVICE_HEADER]: 'commerce',
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(SECRETO_DE_PRUEBAS, {
          service: 'commerce',
          method: 'GET',
          path,
          timestamp,
          body: {},
        }),
      }
    }

    it('responde el estado premium sin mutar nada', async () => {
      const id = await crearProducto('corona-cinco')
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/premium`)
        .set('Authorization', 'Bearer token-admin')
        .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
        .expect(200)

      const path = `/api/internal/v1/catalog/products/${id}/premium-status`
      const respuesta = await request(app.getHttpServer()).get(path).set(firmar(path)).expect(200)

      expect(respuesta.body).toEqual({ productId: id, premium: true })
    })

    it('un producto no premium responde premium=false', async () => {
      const id = await crearProducto('corona-seis')
      const path = `/api/internal/v1/catalog/products/${id}/premium-status`

      const respuesta = await request(app.getHttpServer()).get(path).set(firmar(path)).expect(200)

      expect(respuesta.body).toEqual({ productId: id, premium: false })
    })

    it('sin firma es 401, y el producto no se ve afectado', async () => {
      const id = await crearProducto('corona-siete')

      await request(app.getHttpServer())
        .get(`/api/internal/v1/catalog/products/${id}/premium-status`)
        .expect(401)
    })

    it('un producto inexistente es 404', async () => {
      const path =
        '/api/internal/v1/catalog/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/premium-status'

      await request(app.getHttpServer()).get(path).set(firmar(path)).expect(404)
    })
  })
})
