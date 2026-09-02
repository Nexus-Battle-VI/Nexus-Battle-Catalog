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
  SecondFactorMethod,
  type SecondFactorMethod as SecondFactorMethodValue,
  type MfaEvidenceVerifierPort,
} from '../../src/application/ports/MfaEvidenceVerifierPort'

/**
 * La evidencia de segundo factor sobre las mutaciones administrativas.
 *
 * Lo que se comprueba es concreto: antes de esto, un testimonio con rol
 * ADMINISTRATOR bastaba para crear un producto, sin que nada distinguiera un
 * token nacido tras el segundo factor de otro nacido sin el.
 */
const ADMIN: VerifiedIdentity = {
  subject: 'sujeto-admin',
  email: null,
  roles: new Set([Role.Player, Role.Administrator]),
  jti: 'jti-con-evidencia',
  expiresAt: new Date(Date.now() + 900_000),
}

const ADMIN_OTRO_TESTIMONIO: VerifiedIdentity = { ...ADMIN, jti: 'jti-sin-evidencia' }
const ADMIN_SIN_JTI: VerifiedIdentity = { ...ADMIN, jti: null }
const JUGADOR: VerifiedIdentity = {
  subject: 'sujeto-jugador',
  email: null,
  roles: new Set([Role.Player]),
  jti: 'jti-jugador',
  expiresAt: new Date(Date.now() + 900_000),
}

const IDENTITIES: Readonly<Record<string, VerifiedIdentity>> = {
  'token-admin': ADMIN,
  'token-admin-otro-jti': ADMIN_OTRO_TESTIMONIO,
  'token-admin-sin-jti': ADMIN_SIN_JTI,
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

/** Registra cada consulta para poder afirmar que NO se hace en rutas publicas. */
const consultas: { subject: string; jti: string; method: SecondFactorMethodValue }[] = []
let resultado: MfaEvidenceOutcome = MfaEvidenceOutcome.Valid

const stubEvidence: MfaEvidenceVerifierPort = {
  verify: (
    subject: string,
    jti: string,
    method: SecondFactorMethodValue,
  ): Promise<MfaEvidenceOutcome> => {
    consultas.push({ subject, jti, method })

    // Solo el testimonio con evidencia sembrada la tiene.
    if (jti !== ADMIN.jti) {
      return Promise.resolve(MfaEvidenceOutcome.Absent)
    }

    return Promise.resolve(resultado)
  },
}

const producto = (sku: string): Record<string, unknown> => ({
  sku,
  name: 'Espada de hierro',
  category: 'armas',
  priceAmount: 15_000,
  priceCurrency: 'COP',
})

describe('Evidencia de segundo factor en las mutaciones administrativas', () => {
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
    process.env = { ...process.env, ...previousEnv }
  })

  beforeEach(() => {
    consultas.length = 0
    resultado = MfaEvidenceOutcome.Valid
  })

  it('permite crear un producto con rol administrativo y evidencia valida', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin')
      .send(producto('sku-con-evidencia'))

    expect(response.status).toBe(201)
    expect(consultas).toEqual([
      {
        subject: 'sujeto-admin',
        jti: 'jti-con-evidencia',
        method: SecondFactorMethod.AuthenticatorApp,
      },
    ])
  })

  /**
   * El caso que motiva todo el cambio: mismo rol, mismo sujeto, testimonio sin
   * evidencia. Antes esto creaba el producto.
   */
  it('DENIEGA la creacion si el testimonio no tiene evidencia', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin-otro-jti')
      .send(producto('sku-sin-evidencia'))

    expect(response.status).toBe(403)
    // El producto NO existe: la comprobacion ocurrio antes de cualquier efecto.
    const consulta = await request(app.getHttpServer()).get('/api/products/sku-sin-evidencia')
    expect(consulta.status).toBe(404)
  })

  /**
   * La evidencia se liga al testimonio, no a la persona. El mismo sujeto con
   * otro `jti` no hereda la prueba del anterior.
   */
  it('DENIEGA al mismo sujeto con un jti distinto', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin-otro-jti')
      .send(producto('sku-jti-distinto'))

    expect(response.status).toBe(403)
    expect(consultas).toEqual([
      {
        subject: 'sujeto-admin',
        jti: 'jti-sin-evidencia',
        method: SecondFactorMethod.AuthenticatorApp,
      },
    ])
  })

  it('DENIEGA si el testimonio no trae identificador', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin-sin-jti')
      .send(producto('sku-sin-jti'))

    expect(response.status).toBe(403)
    // Ni siquiera se pregunta: sin `jti` no hay nada que consultar.
    expect(consultas).toEqual([])
  })

  /**
   * FALLO CERRADO. Un tiempo de espera agotado NO puede convertirse en «adelante».
   * Y responde 503, no 403: el sistema no pudo comprobarlo, y culpar a la
   * persona seria mentir sobre la causa y mandar a depurar al sitio equivocado.
   */
  it('falla CERRADO con 503 cuando la evidencia no se puede comprobar', async () => {
    resultado = MfaEvidenceOutcome.Unavailable

    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin')
      .send(producto('sku-indisponible'))

    expect(response.status).toBe(503)
    const consulta = await request(app.getHttpServer()).get('/api/products/sku-indisponible')
    expect(consulta.status).toBe(404)
  })

  it('distingue 403 de 503: denegado no es lo mismo que no verificable', async () => {
    resultado = MfaEvidenceOutcome.Unavailable
    const indisponible = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin')
      .send(producto('sku-a'))

    resultado = MfaEvidenceOutcome.Valid
    const denegado = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-admin-otro-jti')
      .send(producto('sku-b'))

    expect(indisponible.status).toBe(503)
    expect(denegado.status).toBe(403)
  })

  it.each([
    ['publicacion', 'publication'],
    ['archivado', 'archival'],
  ])('protege tambien la mutacion de %s', async (_nombre, ruta) => {
    const response = await request(app.getHttpServer())
      .post(`/api/products/sku-cualquiera/${ruta}`)
      .set('Authorization', 'Bearer token-admin-otro-jti')
      .send({})

    expect(response.status).toBe(403)
  })

  it('protege tambien el cambio de precio', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products/sku-cualquiera/price')
      .set('Authorization', 'Bearer token-admin-otro-jti')
      .send({ amount: 2000, currency: 'COP' })

    expect(response.status).toBe(403)
  })

  /**
   * RBAC sigue actuando ANTES. Sin rol suficiente se rechaza sin llegar a
   * consultar la evidencia: no se gasta una llamada de red por cada intento sin
   * permiso.
   */
  it('un jugador sigue rechazado por rol, sin consultar la evidencia', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/products')
      .set('Authorization', 'Bearer token-jugador')
      .send(producto('sku-jugador'))

    expect(response.status).toBe(403)
    expect(consultas).toEqual([])
  })

  /**
   * CONTROL de todo lo anterior: las rutas publicas NO dependen de Account. Sin
   * esta prueba, «las mutaciones consultan la evidencia» pasaria igual con una
   * implementacion que consultara en TODAS las rutas y dejara el catalogo
   * publico caido cuando Account lo estuviera.
   */
  it('las lecturas publicas NO consultan a Account', async () => {
    const listado = await request(app.getHttpServer()).get('/api/products')

    expect(listado.status).toBe(200)
    expect(consultas).toEqual([])
  })

  it('la consulta publica de un producto tampoco depende de Account', async () => {
    resultado = MfaEvidenceOutcome.Unavailable

    const response = await request(app.getHttpServer()).get('/api/products/sku-con-evidencia')

    // Existe o no, lo que importa es que no es 503: no se pregunto a Account.
    expect(response.status).not.toBe(503)
    expect(consultas).toEqual([])
  })
})
