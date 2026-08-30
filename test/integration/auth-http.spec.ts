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
  'token-jugador': { subject: 'sujeto-jugador', email: null, roles: new Set([Role.Player]) },
  'token-moderador': {
    subject: 'sujeto-moderador',
    email: null,
    roles: new Set([Role.Player, Role.Moderator]),
  },
  'token-administrador': {
    subject: 'sujeto-admin',
    email: null,
    roles: new Set([Role.Player, Role.Administrator]),
  },
  'token-super-administrador': {
    subject: 'sujeto-super-admin',
    email: null,
    roles: new Set([Role.Player, Role.SuperAdministrator]),
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TOKEN_VERIFIER)
      .useValue(stubVerifier)
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
