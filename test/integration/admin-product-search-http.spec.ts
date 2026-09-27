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
 * Busqueda/listado administrativo del catalogo completo sobre HTTP: pedido
 * explicito del cliente del proyecto ("buscar productos" en el panel de
 * administracion, incluidos los suspendidos). Mismo armazon que
 * `hu35-suspension-http.spec.ts`.
 */
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

const MOTIVO_VALIDO = 'Rebalanceo pendiente de estadísticas'

const ARMA = (sku: string, name: string): Record<string, unknown> => ({
  sku,
  name,
  imageUrl: 'https://assets.example.test/img.png',
  description: 'Descripcion valida con la palabra fuego.',
  type: 'ARMA',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
    },
  },
  printRun: 100,
  creditsPrice: 0,
  premium: false,
})

describe('busqueda administrativa sobre HTTP', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (sku: string, name: string): Promise<string> => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .send(ARMA(sku, name))
      .expect(201)

    return (respuesta.body as { productId: string }).productId
  }

  const suspender = async (id: string): Promise<void> => {
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}/status`)
      .set('Authorization', 'Bearer token-admin')
      .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
      .expect(200)
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

  describe('GET /api/v1/admin/products', () => {
    it('incluye productos SUSPENDED, a diferencia de la vitrina publica', async () => {
      const activoId = await crearProducto('busqueda-activo', 'Espada Activa De Busqueda')
      const suspendidoId = await crearProducto(
        'busqueda-suspendido',
        'Espada Suspendida De Busqueda',
      )
      await suspender(suspendidoId)

      const respuesta = await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ query: 'De Busqueda' })
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      const ids = (respuesta.body as { items: { productId: string }[] }).items.map(
        (item) => item.productId,
      )
      expect(ids).toEqual(expect.arrayContaining([activoId, suspendidoId]))

      const vitrina = await request(app.getHttpServer())
        .get('/api/v1/catalog/products')
        .query({ query: 'De Busqueda' })
        .expect(200)
      const idsVitrina = (vitrina.body as { items: { productId: string }[] }).items.map(
        (item) => item.productId,
      )
      expect(idsVitrina).toEqual([activoId])
    })

    it('filtra por lifecycleStatus cuando se solicita', async () => {
      const id = await crearProducto('busqueda-filtro-status', 'Filtro De Estado Suspendido')
      await suspender(id)

      const suspendidos = await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ query: 'Filtro De Estado Suspendido', lifecycleStatus: 'SUSPENDED' })
        .set('Authorization', 'Bearer token-admin')
        .expect(200)
      const activos = await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ query: 'Filtro De Estado Suspendido', lifecycleStatus: 'ACTIVE' })
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      expect((suspendidos.body as { total: number }).total).toBe(1)
      expect((activos.body as { total: number }).total).toBe(0)
    })

    it('filtra por tipo', async () => {
      await crearProducto('busqueda-tipo', 'Producto Tipo Busqueda')

      const respuesta = await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ query: 'Producto Tipo Busqueda', type: 'ITEM' })
        .set('Authorization', 'Bearer token-admin')
        .expect(200)

      expect((respuesta.body as { total: number }).total).toBe(0)
    })

    it('un tipo fuera del enum es 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ type: 'MASCOTA' })
        .set('Authorization', 'Bearer token-admin')
        .expect(400)
    })

    it('una pagina invalida es 400', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .query({ page: 0 })
        .set('Authorization', 'Bearer token-admin')
        .expect(400)
    })

    it('un jugador no puede buscar en el panel de administracion (403)', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/admin/products')
        .set('Authorization', 'Bearer token-jugador')
        .expect(403)
    })

    it('sin testimonio es 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/admin/products').expect(401)
    })
  })
})
