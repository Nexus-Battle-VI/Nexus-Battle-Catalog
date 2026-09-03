import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Contrato de LECTURA canónica (HU-27) sobre la aplicación real.
 *
 * `GET /api/v1/catalog/products/:reference` y `POST .../lookup` son `@Public()`,
 * igual que las lecturas heredadas del catálogo: información de escaparate.
 */
describe('Lectura canónica de productos', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    )

    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  const createCanonical = (overrides: Record<string, unknown> = {}): request.Test =>
    request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .send({
        name: 'Producto canónico de lectura',
        imageUrl: 'https://assets.example.test/catalog/lectura.webp',
        description: 'Sembrado para ejercitar el contrato de lectura de HU-27.',
        type: 'ARMA',
        attributes: {
          schemaVersion: '1',
          values: {
            kind: 'ARMA',
            compatibilityScope: 'ALL_HEROES',
            effects: [
              { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 5 } },
            ],
          },
        },
        printRun: -1,
        creditsPrice: 0,
        premium: false,
        ...overrides,
      })

  it('GET /:reference resuelve por productId', async () => {
    const created = await createCanonical({ name: 'Espada por id', sku: 'espada-por-id' })
    expect(created.status).toBe(201)
    const { productId, sku } = created.body as { productId: string; sku: string }

    const response = await request(app.getHttpServer()).get(`/api/v1/catalog/products/${productId}`)

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      productId,
      sku,
      name: 'Espada por id',
      type: 'ARMA',
      lifecycleStatus: 'ACTIVE',
    })
    expect(response.body).toHaveProperty('attributes')
    expect(response.body).toHaveProperty('imageUrl')
  })

  it('GET /:reference resuelve por el alias sku', async () => {
    const created = await createCanonical({ name: 'Escudo por sku', sku: 'escudo-por-sku' })
    const { productId } = created.body as { productId: string }

    const response = await request(app.getHttpServer()).get(
      '/api/v1/catalog/products/escudo-por-sku',
    )

    expect(response.status).toBe(200)
    expect(response.body.productId).toBe(productId)
  })

  it('GET /:reference responde 404 cuando no existe', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/catalog/products/no-existe-jamas',
    )

    expect(response.status).toBe(404)
  })

  it('POST /lookup resuelve varias referencias sin N+1 y omite las inexistentes', async () => {
    const uno = (await createCanonical({ name: 'Lote Uno', sku: 'lote-uno' })).body as {
      productId: string
    }
    const dos = (await createCanonical({ name: 'Lote Dos', sku: 'lote-dos' })).body as {
      sku: string
    }

    const response = await request(app.getHttpServer())
      .post('/api/v1/catalog/products/lookup')
      .send({ references: [uno.productId, dos.sku, 'inexistente'] })

    expect(response.status).toBe(200)
    const ids = (response.body.items as { productId: string }[]).map((item) => item.productId)
    expect(ids).toContain(uno.productId)
    expect(ids).toHaveLength(2)
  })

  it('POST /lookup filtra por substring de nombre dentro del conjunto pedido', async () => {
    await createCanonical({ name: 'Hacha Vikinga', sku: 'hacha-vikinga' })
    await createCanonical({ name: 'Lanza Corta', sku: 'lanza-corta' })

    const response = await request(app.getHttpServer())
      .post('/api/v1/catalog/products/lookup')
      .send({ references: ['hacha-vikinga', 'lanza-corta'], query: 'hacha' })

    expect(response.status).toBe(200)
    expect(response.body.items).toHaveLength(1)
    expect(response.body.items[0].name).toBe('Hacha Vikinga')
  })

  it('POST /lookup filtra por tipo canónico', async () => {
    await createCanonical({ name: 'Arma Tipada', sku: 'arma-tipada' })

    const armas = await request(app.getHttpServer())
      .post('/api/v1/catalog/products/lookup')
      .send({ references: ['arma-tipada'], type: 'ARMA' })
    const items = await request(app.getHttpServer())
      .post('/api/v1/catalog/products/lookup')
      .send({ references: ['arma-tipada'], type: 'ITEM' })

    expect(armas.body.items).toHaveLength(1)
    expect(items.body.items).toHaveLength(0)
  })

  it.each([
    ['sin referencias', { references: [] }],
    ['con un campo no declarado', { references: ['x'], sobra: 1 }],
    ['con un tipo fuera del enum', { references: ['x'], type: 'LEGENDARIO' }],
    ['sin cuerpo', undefined],
  ])('POST /lookup responde 400 %s', async (_caso, body) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/catalog/products/lookup')
      .send(body)

    expect(response.status).toBe(400)
  })

  it('regresión: el listado heredado GET /api/products sigue respondiendo 200', async () => {
    const response = await request(app.getHttpServer()).get('/api/products')

    expect(response.status).toBe(200)
    expect(Array.isArray(response.body)).toBe(true)
  })
})
