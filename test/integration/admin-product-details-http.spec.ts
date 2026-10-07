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
 * Edicion de campos de presentacion sobre HTTP: pedido explicito del cliente
 * del proyecto ("editar productos" en el panel de administracion). Mismo
 * armazon que `hu35-suspension-http.spec.ts`/`hu34-inventory-http.spec.ts`.
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

let evidenceOutcome: MfaEvidenceOutcome = MfaEvidenceOutcome.Valid
const stubEvidence: MfaEvidenceVerifierPort = {
  verify: (): Promise<MfaEvidenceOutcome> => Promise.resolve(evidenceOutcome),
}

const ARMA = (sku: string, name: string): Record<string, unknown> => ({
  sku,
  name,
  imageUrl: 'https://assets.example.test/img.png',
  description: 'Descripcion original valida.',
  type: 'ARMA',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
      dropChanceBasisPoints: 200,
    },
  },
  printRun: 100,
  creditsPrice: 0,
  premium: false,
})

describe('edicion de detalles de producto sobre HTTP', () => {
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

  beforeEach(() => {
    evidenceOutcome = MfaEvidenceOutcome.Valid
  })

  afterAll(async () => {
    await app.close()

    for (const [clave, valor] of Object.entries(previousEnv)) {
      process.env[clave] = valor
    }
  })

  describe('PATCH /api/v1/admin/products/{id}/details', () => {
    it('edita la descripcion y conserva el resto de campos', async () => {
      const id = await crearProducto('detalles-uno', 'Producto Detalles Uno')

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ description: 'Descripcion editada por el administrador.' })
        .expect(200)

      expect(respuesta.body).toMatchObject({
        productId: id,
        name: 'Producto Detalles Uno',
        description: 'Descripcion editada por el administrador.',
        type: 'ARMA',
      })
    })

    it('edita name, imageUrl y description a la vez', async () => {
      const id = await crearProducto('detalles-dos', 'Producto Detalles Dos')

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({
          name: 'Producto Renombrado',
          imageUrl: 'https://assets.example.test/nueva-imagen.png',
          description: 'Nueva descripcion completa.',
        })
        .expect(200)

      expect(respuesta.body).toMatchObject({
        name: 'Producto Renombrado',
        imageUrl: 'https://assets.example.test/nueva-imagen.png',
        description: 'Nueva descripcion completa.',
      })
    })

    it('rechaza type y attributes con 400 (el ValidationPipe global los descarta)', async () => {
      const id = await crearProducto('detalles-tres', 'Producto Detalles Tres')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ name: 'Nombre Válido', type: 'ITEM' })
        .expect(400)

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({
          name: 'Nombre Válido',
          attributes: { schemaVersion: '1', values: { kind: 'ITEM' } },
        })
        .expect(400)

      const sinCambios = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${id}`)
        .set('Authorization', 'Bearer token-admin')
        .expect(200)
      expect(sinCambios.body).toMatchObject({ name: 'Producto Detalles Tres', type: 'ARMA' })
    })

    it('un cuerpo vacio (ningun campo editable) es 400', async () => {
      const id = await crearProducto('detalles-cuatro', 'Producto Detalles Cuatro')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({})
        .expect(400)
    })

    it('un nombre demasiado corto es 400 (forma), y un nombre demasiado largo tambien', async () => {
      const id = await crearProducto('detalles-cinco', 'Producto Detalles Cinco')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ name: 'ab' })
        .expect(400)

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ name: 'a'.repeat(81) })
        .expect(400)
    })

    it('un imageUrl invalido es 400', async () => {
      const id = await crearProducto('detalles-seis', 'Producto Detalles Seis')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ imageUrl: 'no-es-una-url' })
        .expect(400)
    })

    it('renombrar a un nombre ya usado por otro producto ACTIVO del mismo tipo es 409', async () => {
      await crearProducto('detalles-siete-a', 'Nombre Ya Ocupado Siete')
      const id = await crearProducto('detalles-siete-b', 'Producto Detalles Siete')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ name: 'Nombre Ya Ocupado Siete' })
        .expect(409)

      const sinCambios = await request(app.getHttpServer())
        .get(`/api/v1/admin/products/${id}`)
        .set('Authorization', 'Bearer token-admin')
        .expect(200)
      expect(sinCambios.body).toMatchObject({ name: 'Producto Detalles Siete' })
    })

    it('un producto inexistente es 404', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/details')
        .set('Authorization', 'Bearer token-admin')
        .send({ description: 'Cualquier descripcion valida.' })
        .expect(404)
    })

    it('un jugador no puede editar detalles (403)', async () => {
      const id = await crearProducto('detalles-ocho', 'Producto Detalles Ocho')

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-jugador')
        .send({ description: 'Cualquier descripcion valida.' })
        .expect(403)
    })

    it('sin testimonio es 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/details')
        .send({ description: 'Cualquier descripcion valida.' })
        .expect(401)
    })

    it('sin evidencia de segundo factor valida es 403 (misma exigencia que las otras mutaciones)', async () => {
      const id = await crearProducto('detalles-nueve', 'Producto Detalles Nueve')
      evidenceOutcome = MfaEvidenceOutcome.Absent

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/details`)
        .set('Authorization', 'Bearer token-admin')
        .send({ description: 'Cualquier descripcion valida.' })
        .expect(403)
    })
  })
})
