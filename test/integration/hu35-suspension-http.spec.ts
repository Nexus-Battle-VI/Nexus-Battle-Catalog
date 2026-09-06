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

/**
 * HU-35 sobre HTTP: suspension (borrado logico) y reactivacion de producto,
 * incluyendo el control de acceso de CA-02 (HU-35.2) y la idempotencia de
 * HU-35.4. Mismo armazon que `hu36-premium-http.spec.ts`.
 */
const ADMIN: VerifiedIdentity = {
  subject: 'sujeto-admin',
  email: null,
  roles: new Set([Role.Player, Role.Administrator]),
  jti: 'jti-con-evidencia',
  expiresAt: new Date(Date.now() + 900_000),
}

const MODERADOR: VerifiedIdentity = {
  subject: 'sujeto-moderador',
  email: null,
  roles: new Set([Role.Player, Role.Moderator]),
  jti: 'jti-moderador',
  expiresAt: new Date(Date.now() + 900_000),
}

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-admin': ADMIN,
  'token-moderador': MODERADOR,
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

const MOTIVO_VALIDO = 'Rebalanceo pendiente de estadísticas'

const ARMA = (sku: string, printRun = 300): Record<string, unknown> => ({
  sku,
  name: `Mago ${sku}`,
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
  printRun,
  creditsPrice: 0,
  premium: false,
})

describe('HU-35 sobre HTTP', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (sku: string, printRun = 300): Promise<string> => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .send(ARMA(sku, printRun))
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
    process.env.INTERNAL_SERVICE_AUTH_SECRET = 'secreto-ficticio-solo-para-pruebas'

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

  describe('PATCH /api/v1/admin/products/{id}/status', () => {
    it('CA-01: suspende un producto activo y retira su disponibilidad', async () => {
      const id = await crearProducto('mago-uno')

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(200)

      expect(respuesta.body).toMatchObject({ lifecycleStatus: 'SUSPENDED' })
    })

    it('CA-02: un Moderador no puede suspender un producto (403)', async () => {
      const id = await crearProducto('mago-dos')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-moderador')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(403)

      const sinCambios = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${id}`)
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      expect(sinCambios.body).toMatchObject({ lifecycleStatus: 'ACTIVE' })
    })

    it('CA-02: un Administrador sin motivo recibe 400 y el producto conserva su estado', async () => {
      const id = await crearProducto('mago-tres')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED' })
        .expect(400)

      const sinCambios = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${id}`)
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      expect(sinCambios.body).toMatchObject({ lifecycleStatus: 'ACTIVE' })
    })

    it('CA-02: un motivo de menos de 10 caracteres recibe 400', async () => {
      const id = await crearProducto('mago-cuatro')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: 'corto' })
        .expect(400)
    })

    it('un producto inexistente es 404', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/status')
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(404)
    })

    it('sin testimonio es 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/status')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(401)
    })

    it('caso adicional de idempotencia: suspender un producto ya suspendido responde 200 informativo', async () => {
      const id = await crearProducto('mago-cinco')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(200)

      const segunda = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(200)

      expect(segunda.body).toMatchObject({ lifecycleStatus: 'SUSPENDED' })
    })

    it('CA-03: reactiva un producto suspendido', async () => {
      const id = await crearProducto('mago-seis')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
        .expect(200)

      const reactivado = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/status`)
        .set('Authorization', 'Bearer token-admin')
        .send({ status: 'ACTIVE', reason: 'Rebalanceo completado, producto listo' })
        .expect(200)

      expect(reactivado.body).toMatchObject({ lifecycleStatus: 'ACTIVE' })
    })
  })
})
