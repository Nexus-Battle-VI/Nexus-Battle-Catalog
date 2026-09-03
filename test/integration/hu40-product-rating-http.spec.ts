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
 * HU-40 (CA-03) sobre HTTP: el contrato interno de calificación que Community
 * empuja hacia el producto canónico.
 *
 * EL SECRETO DE ESTAS PRUEBAS ES FICTICIO, igual que en `hu34-inventory-http`.
 */
const SECRETO_DE_PRUEBAS = 'secreto-ficticio-solo-para-pruebas'

const ADMIN: VerifiedIdentity = {
  subject: 'sujeto-admin',
  email: null,
  roles: new Set([Role.Player, Role.Administrator]),
  jti: 'jti-con-evidencia',
  expiresAt: new Date(Date.now() + 900_000),
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> =>
    token === 'token-admin' ? Promise.resolve(ADMIN) : Promise.reject(new TokenVerificationError()),
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
    },
  },
  printRun: 10,
  creditsPrice: 500,
  premium: false,
})

describe('HU-40 (CA-03) sobre HTTP', () => {
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

  const leerProducto = async (id: string): Promise<Record<string, unknown>> => {
    const respuesta = await request(app.getHttpServer())
      .get(`/api/v1/admin/products/${id}`)
      .set('Authorization', 'Bearer token-admin')
      .expect(200)

    return respuesta.body as Record<string, unknown>
  }

  const firmar = (path: string, body: Record<string, unknown>): Record<string, string> => {
    const timestamp = String(Date.now())

    return {
      [INTERNAL_SERVICE_HEADER]: 'community',
      [INTERNAL_TIMESTAMP_HEADER]: timestamp,
      [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(SECRETO_DE_PRUEBAS, {
        service: 'community',
        method: 'POST',
        path,
        timestamp,
        body,
      }),
    }
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

  describe('POST /api/internal/v1/catalog/products/{id}/rating', () => {
    it('un producto nuevo nace sin calificaciones', async () => {
      const id = await crearProducto('espada-sin-calificar')

      expect(await leerProducto(id)).toMatchObject({ averageRating: null, reviewCount: 0 })
    })

    it('aplica el agregado empujado por Community', async () => {
      const id = await crearProducto('espada-calificada')
      const path = `/api/internal/v1/catalog/products/${id}/rating`
      const cuerpo = { averageRating: 4.5, reviewCount: 2 }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(200)

      expect(await leerProducto(id)).toMatchObject({ averageRating: 4.5, reviewCount: 2 })
    })

    it('un reintento con el mismo agregado deja el mismo resultado', async () => {
      const id = await crearProducto('espada-reintento')
      const path = `/api/internal/v1/catalog/products/${id}/rating`
      const cuerpo = { averageRating: 3, reviewCount: 1 }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(200)
      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(200)

      expect(await leerProducto(id)).toMatchObject({ averageRating: 3, reviewCount: 1 })
    })

    it('un producto inexistente es 404', async () => {
      const path = '/api/internal/v1/catalog/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/rating'
      const cuerpo = { averageRating: 5, reviewCount: 1 }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(404)
    })

    it('CA-03: un promedio sin calificaciones es rechazado con 400', async () => {
      const id = await crearProducto('espada-inconsistente')
      const path = `/api/internal/v1/catalog/products/${id}/rating`
      const cuerpo = { averageRating: 4, reviewCount: 0 }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(400)

      expect(await leerProducto(id)).toMatchObject({ averageRating: null, reviewCount: 0 })
    })

    it('un promedio fuera de 1-5 es rechazado con 400', async () => {
      const id = await crearProducto('espada-fuera-de-rango')
      const path = `/api/internal/v1/catalog/products/${id}/rating`
      const cuerpo = { averageRating: 6, reviewCount: 3 }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(400)
    })

    it('sin firma NO actualiza, y responde 401', async () => {
      const id = await crearProducto('espada-sin-firma')
      const path = `/api/internal/v1/catalog/products/${id}/rating`

      await request(app.getHttpServer())
        .post(path)
        .send({ averageRating: 5, reviewCount: 1 })
        .expect(401)

      expect(await leerProducto(id)).toMatchObject({ averageRating: null, reviewCount: 0 })
    })

    it('un servicio no declarado es rechazado aunque firme bien', async () => {
      const id = await crearProducto('espada-servicio-ajeno')
      const path = `/api/internal/v1/catalog/products/${id}/rating`
      const cuerpo = { averageRating: 5, reviewCount: 1 }
      const timestamp = String(Date.now())

      await request(app.getHttpServer())
        .post(path)
        .set({
          [INTERNAL_SERVICE_HEADER]: 'servicio-desconocido',
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(SECRETO_DE_PRUEBAS, {
            service: 'servicio-desconocido',
            method: 'POST',
            path,
            timestamp,
            body: cuerpo,
          }),
        })
        .send(cuerpo)
        .expect(401)
    })
  })
})
