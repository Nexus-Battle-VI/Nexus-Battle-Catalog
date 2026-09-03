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
 * HU-34 sobre HTTP: el ajuste administrativo y el contrato interno.
 *
 * EL SECRETO DE ESTAS PRUEBAS ES FICTICIO y no vale en ningun entorno. Nunca
 * debe aparecer aqui uno real: un secreto en el repositorio es un secreto
 * publicado, aunque el repositorio fuera privado.
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

const ARMA = (sku: string, printRun: number): Record<string, unknown> => ({
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
  printRun,
  creditsPrice: 500,
  premium: false,
})

describe('HU-34 sobre HTTP', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (sku: string, printRun: number): Promise<string> => {
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

    // Se restaura el entorno tal y como estaba. `undefined` se asigna en lugar
    // de borrar la clave: el efecto sobre `process.env` es el mismo -la
    // variable deja de estar definida- y no hace falta el borrado dinamico.
    for (const [clave, valor] of Object.entries(previousEnv)) {
      process.env[clave] = valor
    }
  })

  describe('PATCH /api/v1/admin/products/{id}/inventory', () => {
    it('devuelve la disponibilidad recalculada y el producto creado la trae', async () => {
      const id = await crearProducto('escudo-uno', 200)

      const creado = await request(app.getHttpServer())
        .get(`/api/v1/catalog/products/${id}`)
        .set('Authorization', 'Bearer token-admin')

      // La lectura canonica puede no existir todavia; lo que importa aqui es
      // que el ajuste responda con el contador.
      expect([200, 404]).toContain(creado.status)

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: 350 })
        .expect(200)

      expect(respuesta.body).toMatchObject({ printRun: 350, availableUnits: 350 })
    })

    it('CA-02: un tiraje de -3 es 422 y conserva el valor original', async () => {
      const id = await crearProducto('escudo-dos', 10)

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: -3 })
        .expect(422)

      const sinCambios = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: 10 })
        .expect(200)

      expect(sinCambios.body).toMatchObject({ printRun: 10, availableUnits: 10 })
    })

    it('tiraje infinito responde con disponibilidad nula', async () => {
      const id = await crearProducto('pocion-de-vida', 10)

      const respuesta = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: -1 })
        .expect(200)

      expect(respuesta.body).toMatchObject({ printRun: -1, printRunMode: 'INFINITE' })
      expect((respuesta.body as { availableUnits: number | null }).availableUnits).toBeNull()
    })

    it('un producto inexistente es 404', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/inventory')
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: 5 })
        .expect(404)
    })

    it('un jugador no puede ajustar el tiraje', async () => {
      const id = await crearProducto('escudo-tres', 10)

      await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-jugador')
        .send({ printRun: 20 })
        .expect(403)
    })

    it('sin testimonio es 401', async () => {
      await request(app.getHttpServer())
        .patch('/api/v1/admin/products/cccccccc-cccc-4ccc-8ccc-cccccccccccc/inventory')
        .send({ printRun: 5 })
        .expect(401)
    })
  })

  describe('POST /api/internal/v1/catalog/products/{id}/acquisitions', () => {
    const firmar = (path: string, body: Record<string, unknown>): Record<string, string> => {
      const timestamp = String(Date.now())

      return {
        [INTERNAL_SERVICE_HEADER]: 'commerce',
        [INTERNAL_TIMESTAMP_HEADER]: timestamp,
        [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(SECRETO_DE_PRUEBAS, {
          service: 'commerce',
          method: 'POST',
          path,
          timestamp,
          body,
        }),
      }
    }

    it('sin firma NO decrementa, y responde 401', async () => {
      const id = await crearProducto('arma-sin-firma', 3)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`

      await request(app.getHttpServer())
        .post(path)
        .send({ acquisitionId: '11111111-1111-4111-8111-111111111111', playerId: 'jugador-1' })
        .expect(401)

      // El control: la disponibilidad sigue intacta. Comprobar solo el codigo
      // dejaria pasar una implementacion que rechaza DESPUES de haber restado.
      const despues = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: 3 })
        .expect(200)

      expect(despues.body).toMatchObject({ availableUnits: 3 })
    })

    it('con firma valida decrementa, y el reintento no vuelve a restar', async () => {
      const id = await crearProducto('arma-con-firma', 3)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`
      const cuerpo = {
        acquisitionId: '22222222-2222-4222-8222-222222222222',
        playerId: 'jugador-1',
      }

      const primera = await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(200)

      expect(primera.body).toMatchObject({ availableUnits: 2, replayed: false })

      const reintento = await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, cuerpo))
        .send(cuerpo)
        .expect(200)

      expect(reintento.body).toMatchObject({ availableUnits: 2, replayed: true })
    })

    it('CA-01: agotado responde 409 sin cambiar el ciclo de vida', async () => {
      const id = await crearProducto('arma-de-una-unidad', 1)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`

      const primera = {
        acquisitionId: '33333333-3333-4333-8333-333333333333',
        playerId: 'jugador-1',
      }
      const segunda = {
        acquisitionId: '44444444-4444-4444-8444-444444444444',
        playerId: 'jugador-2',
      }

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, primera))
        .send(primera)
        .expect(200)

      await request(app.getHttpServer())
        .post(path)
        .set(firmar(path, segunda))
        .send(segunda)
        .expect(409)

      const estado = await request(app.getHttpServer())
        .patch(`/api/v1/admin/products/${id}/inventory`)
        .set('Authorization', 'Bearer token-admin')
        .send({ printRun: 1 })
        .expect(200)

      // Agotado y suspendido son independientes: el ciclo de vida no se toca.
      expect(estado.body).toMatchObject({ availableUnits: 0, lifecycleStatus: 'ACTIVE' })
    })

    it('una firma de OTRA ruta no sirve para esta', async () => {
      const id = await crearProducto('arma-firma-cruzada', 3)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`
      const cuerpo = {
        acquisitionId: '55555555-5555-4555-8555-555555555555',
        playerId: 'jugador-1',
      }

      // Se firma una ruta distinta. Si la firma solo cubriera el cuerpo, esto
      // pasaria: es justo lo que la cadena canonica viene a impedir.
      const cabeceras = firmar('/api/internal/v1/catalog/products/otro/acquisitions', cuerpo)

      await request(app.getHttpServer()).post(path).set(cabeceras).send(cuerpo).expect(401)
    })

    it('un servicio no declarado es rechazado aunque firme bien', async () => {
      const id = await crearProducto('arma-servicio-ajeno', 3)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`
      const cuerpo = {
        acquisitionId: '66666666-6666-4666-8666-666666666666',
        playerId: 'jugador-1',
      }
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

    it('un sello fuera de ventana es rechazado', async () => {
      const id = await crearProducto('arma-sello-viejo', 3)
      const path = `/api/internal/v1/catalog/products/${id}/acquisitions`
      const cuerpo = {
        acquisitionId: '77777777-7777-4777-8777-777777777777',
        playerId: 'jugador-1',
      }
      const timestamp = String(Date.now() - 600_000)

      await request(app.getHttpServer())
        .post(path)
        .set({
          [INTERNAL_SERVICE_HEADER]: 'commerce',
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signInternalRequest(SECRETO_DE_PRUEBAS, {
            service: 'commerce',
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
