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
  PRODUCT_OUTBOX_PORT,
  type ProductOutboxPort,
} from '../../src/application/ports/CanonicalProductPorts'

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

const MOTIVO_VALIDO = 'Rebalanceo pendiente de estadísticas'

const ARMA = (sku: string): Record<string, unknown> => ({
  sku,
  name: `Espada ${sku}`,
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
  printRun: 300,
  creditsPrice: 0,
  premium: false,
})

/**
 * HU-38: verifica que el `correlationId` viaja realmente desde la cabecera
 * HTTP hasta el `OutboxEntry`, a traves de los cuatro productores reales
 * expuestos por controlador (resolucion del BLOCKER-CONTRACT de PR#51).
 */
describe('HU-38: correlationId de x-correlation-id hasta el outbox', () => {
  let app: INestApplication
  let outbox: ProductOutboxPort
  let previousEnv: Record<string, string | undefined>

  const crearProducto = async (sku: string, correlationId?: string): Promise<string> => {
    const req = request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')

    if (correlationId !== undefined) req.set('x-correlation-id', correlationId)

    const respuesta = await req.send(ARMA(sku)).expect(201)

    return (respuesta.body as { productId: string }).productId
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

    outbox = moduleRef.get<ProductOutboxPort>(PRODUCT_OUTBOX_PORT)
  })

  afterAll(async () => {
    await app.close()

    for (const [clave, valor] of Object.entries(previousEnv)) {
      process.env[clave] = valor
    }
  })

  const claimByAggregate = async (aggregateId: string, eventType: string) => {
    const claimed = await outbox.claim(`test-${aggregateId}`, 20, 60_000)
    return claimed.find(
      (entry) => entry.aggregateId === aggregateId && entry.eventType === eventType,
    )
  }

  it('creacion: preserva x-correlation-id en el OutboxEntry y lo devuelve en la respuesta', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'req-create-http')
      .send(ARMA('correlacion-creacion'))
      .expect(201)

    expect(respuesta.headers['x-correlation-id']).toBe('req-create-http')

    const productId = (respuesta.body as { productId: string }).productId
    const entry = await claimByAggregate(productId, 'catalog.product.created')

    expect(entry?.correlationId).toBe('req-create-http')
  })

  it('creacion SIN x-correlation-id: la operacion funciona y el outbox recibe un id generado valido', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .send(ARMA('correlacion-sin-cabecera'))
      .expect(201)

    const generated = respuesta.headers['x-correlation-id']
    expect(generated).toBeDefined()
    expect(generated!.length).toBeGreaterThan(0)
    expect(generated!.length).toBeLessThanOrEqual(128)

    const productId = (respuesta.body as { productId: string }).productId
    const entry = await claimByAggregate(productId, 'catalog.product.created')

    expect(entry?.correlationId).toBe(generated)
  })

  it('ajuste de inventario: preserva x-correlation-id en catalog.product.inventory.adjusted', async () => {
    const id = await crearProducto('correlacion-inventario')

    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}/inventory`)
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'req-admin-inventario')
      .send({ printRun: 500 })
      .expect(200)

    expect(respuesta.headers['x-correlation-id']).toBe('req-admin-inventario')

    const entry = await claimByAggregate(id, 'catalog.product.inventory.adjusted')
    expect(entry?.correlationId).toBe('req-admin-inventario')
  })

  it('condicion premium: preserva x-correlation-id en catalog.product.premium.configured', async () => {
    const id = await crearProducto('correlacion-premium')

    const respuesta = await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}/premium`)
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'req-admin-premium')
      .send({ premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } })
      .expect(200)

    expect(respuesta.headers['x-correlation-id']).toBe('req-admin-premium')

    const entry = await claimByAggregate(id, 'catalog.product.premium.configured')
    expect(entry?.correlationId).toBe('req-admin-premium')
  })

  it('suspension y reactivacion: cada peticion persiste SU PROPIO correlationId', async () => {
    const id = await crearProducto('correlacion-estado')

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}/status`)
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'req-admin-suspend')
      .send({ status: 'SUSPENDED', reason: MOTIVO_VALIDO })
      .expect(200)

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${id}/status`)
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'req-admin-reactivate')
      .send({ status: 'ACTIVE', reason: 'Rebalanceo completado, producto listo' })
      .expect(200)

    const claimed = await outbox.claim(`test-${id}`, 20, 60_000)
    const suspended = claimed.find(
      (entry) => entry.aggregateId === id && entry.eventType === 'catalog.product.suspended',
    )
    const reactivated = claimed.find(
      (entry) => entry.aggregateId === id && entry.eventType === 'catalog.product.reactivated',
    )

    expect(suspended?.correlationId).toBe('req-admin-suspend')
    expect(reactivated?.correlationId).toBe('req-admin-reactivate')
  })

  it('una cabecera invalida (>128 caracteres) no rompe la operacion; se genera un id propio', async () => {
    const respuesta = await request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .set('Authorization', 'Bearer token-admin')
      .set('x-correlation-id', 'x'.repeat(300))
      .send(ARMA('correlacion-invalida'))
      .expect(201)

    const generated = respuesta.headers['x-correlation-id']
    expect(generated).toBeDefined()
    expect(generated).not.toBe('x'.repeat(300))
    expect(generated!.length).toBeLessThanOrEqual(128)
  })
})
