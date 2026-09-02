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
} from '../../src/application/ports/MfaEvidenceVerifierPort'

/**
 * Integracion con la autenticacion ACTIVA.
 *
 * Se levanta la aplicacion real con `AUTH_MODE=jwt`, de modo que los guards se
 * registran de verdad. Lo unico que se sustituye es el verificador: emitir
 * tokens autenticos exigiria un pool de Cognito real, y eso convertiria una
 * prueba de autorizacion en una prueba de red.
 *
 * Lo que se comprueba es concreto: antes de esto, CUALQUIERA podia crear un
 * producto, publicarlo o cambiarle el precio.
 */
const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-jugador': {
    subject: 'sujeto-jugador',
    email: null,
    roles: new Set([Role.Player]),
    jti: 'jti-jugador',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-moderador': {
    subject: 'sujeto-moderador',
    email: null,
    roles: new Set([Role.Player, Role.Moderator]),
    jti: 'jti-moderador',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-administrador': {
    subject: 'sujeto-admin',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
    jti: 'jti-admin',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-administrador-sin-evidencia': {
    subject: 'sujeto-admin-sin-evidencia',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
    jti: 'jti-admin-sin-evidencia',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-administrador-evidencia-no-disponible': {
    subject: 'sujeto-admin-evidencia-no-disponible',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
    jti: 'jti-admin-evidencia-no-disponible',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-super-administrador': {
    subject: 'sujeto-super-admin',
    email: null,
    roles: new Set([Role.Player, Role.SuperAdministrator]),
    jti: 'jti-super-admin',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-administrador-mfa': {
    subject: 'sujeto-admin-mfa',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
    jti: 'jti-admin-mfa',
    expiresAt: new Date(Date.now() + 900_000),
  },
  'token-super-administrador-mfa': {
    subject: 'sujeto-super-admin-mfa',
    email: null,
    roles: new Set([Role.Player, Role.SuperAdministrator]),
    jti: 'jti-super-admin-mfa',
    expiresAt: new Date(Date.now() + 900_000),
  },
}

const stubVerifier: TokenVerifierPort = {
  verify: (token: string): Promise<VerifiedIdentity> => {
    const identity = IDENTITIES[token]

    return identity === undefined
      ? Promise.reject(new TokenVerificationError())
      : Promise.resolve(identity)
  },
}

describe('API de catalogo con autenticacion activa', () => {
  let app: INestApplication
  let previousEnv: Record<string, string | undefined>

  beforeAll(async () => {
    previousEnv = {
      AUTH_MODE: process.env.AUTH_MODE,
      COGNITO_USER_POOL_ID: process.env.COGNITO_USER_POOL_ID,
      COGNITO_CLIENT_ID: process.env.COGNITO_CLIENT_ID,
    }

    process.env.AUTH_MODE = 'jwt'
    process.env.COGNITO_USER_POOL_ID = 'us-east-1_pruebas'
    process.env.COGNITO_CLIENT_ID = 'cliente-de-pruebas'

    // Este bloque comprueba principalmente RBAC. La unica ausencia simulada es
    // la del testimonio creado expresamente para demostrar que el endpoint
    // canonico tambien esta conectado al guard oficial de evidencia MFA. El
    // comportamiento exhaustivo vive en `mfa-evidence-http.spec.ts`.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
      .overrideProvider(MFA_EVIDENCE_VERIFIER)
      .useValue({
        verify: (_subject: string, jti: string): Promise<MfaEvidenceOutcome> => {
          if (jti === 'jti-admin-sin-evidencia') {
            return Promise.resolve(MfaEvidenceOutcome.Absent)
          }

          if (jti === 'jti-admin-evidencia-no-disponible') {
            return Promise.resolve(MfaEvidenceOutcome.Unavailable)
          }

          return Promise.resolve(MfaEvidenceOutcome.Valid)
        },
      })
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

    for (const [key, value] of Object.entries(previousEnv)) {
      process.env[key] = value ?? ''
    }
  })

  const bearer = (token: string) => `Bearer ${token}`

  let contador = 0
  const nuevoProducto = () => {
    contador += 1

    return {
      sku: `producto-de-prueba-${String(contador)}`,
      name: 'Producto de prueba',
      category: 'armas',
      priceAmount: 15_000,
      priceCurrency: 'COP',
    }
  }

  const crear = (token?: string) => {
    const call = request(app.getHttpServer()).post('/api/products')

    return token === undefined
      ? call.send(nuevoProducto())
      : call.set('Authorization', bearer(token)).send(nuevoProducto())
  }

  let contadorCanonico = 0
  const nuevoProductoCanonico = () => {
    contadorCanonico += 1

    return {
      name: `Espada de fuego ${String(contadorCanonico)}`,
      imageUrl: 'https://assets.example.test/catalog/espada-de-fuego.webp',
      description: 'Espada de dos manos con daño de fuego.',
      type: 'ARMA',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'ARMA',
          compatibilityScope: 'ALL_HEROES',
          effects: [
            {
              kind: 'DAMAGE',
              target: 'OPPONENT',
              magnitude: { mode: 'DICE', count: 2, sides: 6 },
            },
          ],
        },
      },
      printRun: 150,
      creditsPrice: 40,
      premium: false,
    }
  }

  const crearCanonico = (token: string, body = nuevoProductoCanonico()) =>
    request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', bearer(token))
      .send(body)

  describe('El catalogo publicado es publico', () => {
    it('se puede listar sin testimonio: es informacion de escaparate', async () => {
      const response = await request(app.getHttpServer()).get('/api/products')

      expect(response.status).toBe(200)
    })

    it('las sondas de salud responden sin testimonio', async () => {
      const response = await request(app.getHttpServer()).get('/api/health/live')

      expect(response.status).toBeLessThan(400)
    })
  })

  describe('La gestion del catalogo exige rol de administrador', () => {
    it('responde 401 al crear sin testimonio', async () => {
      expect((await crear()).status).toBe(401)
    })

    it('responde 401 con un testimonio que no verifica', async () => {
      expect((await crear('token-falsificado')).status).toBe(401)
    })

    it.each([
      ['un jugador', 'token-jugador'],
      ['un moderador', 'token-moderador'],
    ])('responde 403 al crear un producto siendo %s', async (_quien, token) => {
      expect((await crear(token)).status).toBe(403)
    })

    it('permite crear un producto a un administrador', async () => {
      expect((await crear('token-administrador')).status).toBe(201)
    })

    it('un SUPER_ADMINISTRATOR puro satisface la gestion ADMINISTRATOR', async () => {
      expect((await crear('token-super-administrador')).status).toBe(201)
    })
  })

  describe('Creación canónica administrativa', () => {
    it('deniega al administrador sin evidencia de segundo factor', async () => {
      expect((await crearCanonico('token-administrador-sin-evidencia')).status).toBe(403)
    })

    it('falla cerrado si Account no permite comprobar la evidencia', async () => {
      expect((await crearCanonico('token-administrador-evidencia-no-disponible')).status).toBe(503)
    })

    it('permite al SUPER_ADMINISTRATOR con segundo factor confirmado', async () => {
      expect((await crearCanonico('token-super-administrador-mfa')).status).toBe(201)
    })

    it('crea un producto canónico para administrador con segundo factor y genera SKU', async () => {
      const response = await crearCanonico('token-administrador-mfa')

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        type: 'ARMA',
        printRun: 150,
        printRunMode: 'LIMITED',
        lifecycleStatus: 'ACTIVE',
        premium: false,
        realMoneyPrice: null,
        attributes: {
          schemaVersion: '1',
          values: {
            kind: 'ARMA',
            effects: [{ kind: 'DAMAGE', stackable: false }],
          },
        },
      })
      expect(response.body.sku).toMatch(/^espada-de-fuego-[0-9]+-[0-9a-f]{8}$/)
      expect(response.body.productId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    })

    it('rechaza campos derivados declarados por el cliente', async () => {
      const body = { ...nuevoProductoCanonico(), productId: 'no-debe-llegar' }

      expect((await crearCanonico('token-administrador-mfa', body)).status).toBe(400)
    })

    it('rechaza campos derivados dentro de una variante de atributos', async () => {
      const body = nuevoProductoCanonico()
      const attributes = body.attributes as {
        values: { effects: Record<string, unknown>[] }
      }
      attributes.values.effects[0]!.stackable = false

      expect((await crearCanonico('token-administrador-mfa', body)).status).toBe(400)
    })

    it('traduce una regla de dominio a 422', async () => {
      const body = { ...nuevoProductoCanonico(), printRun: 0 }

      expect((await crearCanonico('token-administrador-mfa', body)).status).toBe(422)
    })

    it('traduce nombre y tipo activo duplicados a 409', async () => {
      const body = nuevoProductoCanonico()

      expect((await crearCanonico('token-administrador-mfa', body)).status).toBe(201)
      expect((await crearCanonico('token-administrador-mfa', body)).status).toBe(409)
    })
  })

  describe('Publicar, archivar y cambiar precio', () => {
    let sku: string

    beforeAll(async () => {
      const created = await crear('token-administrador')
      sku = (created.body as { sku: string }).sku
    })

    it.each([
      ['publicar', (s: string) => `/api/products/${s}/publication`],
      ['archivar', (s: string) => `/api/products/${s}/archival`],
    ])('responde 403 al %s siendo jugador', async (_accion, path) => {
      const response = await request(app.getHttpServer())
        .post(path(sku))
        .set('Authorization', bearer('token-jugador'))

      expect(response.status).toBe(403)
    })

    /**
     * Cambiar el precio de un producto ajeno es la operacion con consecuencia
     * economica directa, y antes no exigia absolutamente nada.
     */
    it('responde 403 al cambiar el precio siendo jugador', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/products/${sku}/price`)
        .set('Authorization', bearer('token-jugador'))
        .send({ priceAmount: 1, priceCurrency: 'COP' })

      expect(response.status).toBe(403)
    })

    it('permite cambiar el precio a un administrador', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/products/${sku}/price`)
        .set('Authorization', bearer('token-administrador'))
        .send({ priceAmount: 22_000, priceCurrency: 'COP' })

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ price: { amount: 22_000, currency: 'COP' } })
    })
  })
})
