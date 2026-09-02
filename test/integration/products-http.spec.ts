import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * Pruebas de integracion sobre la aplicacion NestJS real: se levanta el modulo
 * completo, con su raiz de composicion, sus tuberias de validacion y sus
 * controladores. No se sustituye ningun adaptador.
 */
describe('API de catalogo', () => {
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

  const create = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/api/products').send(body)

  const createCanonical = () =>
    request(app.getHttpServer())
      .post('/api/v1/catalog/products')
      .send({
        name: 'Espada canónica local',
        imageUrl: 'https://assets.example.test/catalog/espada-canonica.webp',
        description: 'Producto creado con la seguridad desactivada solo en desarrollo local.',
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
                magnitude: { mode: 'FIXED', amount: 5 },
              },
            ],
          },
        },
        printRun: -1,
        creditsPrice: 0,
        premium: false,
      })

  const base = {
    name: 'Espada de hierro',
    category: 'armas',
    priceAmount: 15_000,
    priceCurrency: 'COP',
  }

  it('POST /api/products crea un producto en borrador y responde 201', async () => {
    const response = await create({ ...base, sku: 'espada-de-hierro' })

    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      sku: 'espada-de-hierro',
      name: 'Espada de hierro',
      category: 'armas',
      price: { amount: 15_000, currency: 'COP' },
      isPremium: false,
      realMoneyPrice: null,
      status: 'DRAFT',
    })
  })

  it('POST /api/v1/catalog/products sigue siendo ejercitable en desarrollo sin identidad', async () => {
    const response = await createCanonical()

    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      printRun: -1,
      printRunMode: 'INFINITE',
      lifecycleStatus: 'ACTIVE',
      attributes: { values: { effects: [{ stackable: false }] } },
    })
  })

  it('POST /api/products responde 409 si la referencia ya existe', async () => {
    await create({ ...base, sku: 'duplicado' })

    expect((await create({ ...base, sku: 'duplicado' })).status).toBe(409)
  })

  it('POST /api/products admite una sola creacion concurrente por SKU', async () => {
    const responses = await Promise.all([
      create({ ...base, sku: 'concurrente', name: 'Primer candidato' }),
      create({ ...base, sku: 'concurrente', name: 'Segundo candidato' }),
    ])

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409])
  })

  it.each([
    ['referencia mal formada', { sku: 'Espada_Hierro' }],
    ['nombre demasiado corto', { sku: 'corto', name: 'Ab' }],
    ['precio cero', { sku: 'gratis', priceAmount: 0 }],
    ['precio fraccionario', { sku: 'fraccion', priceAmount: 1500.5 }],
    ['moneda no soportada', { sku: 'libra', priceCurrency: 'GBP' }],
  ])('POST /api/products responde 400 con %s', async (_caso, override) => {
    expect((await create({ ...base, ...override })).status).toBe(400)
  })

  it('POST /api/products rechaza campos no declarados en el contrato', async () => {
    const response = await create({ ...base, sku: 'con-extra', status: 'PUBLISHED' })

    expect(response.status).toBe(400)
  })

  it('un producto en borrador no es visible en la consulta publica', async () => {
    await create({ ...base, sku: 'oculto' })

    expect((await request(app.getHttpServer()).get('/api/products/oculto')).status).toBe(404)
  })

  it('publica el producto y pasa a ser visible', async () => {
    await create({ ...base, sku: 'visible' })

    const publish = await request(app.getHttpServer()).post('/api/products/visible/publication')
    expect(publish.status).toBe(200)
    expect(publish.body.status).toBe('PUBLISHED')

    const read = await request(app.getHttpServer()).get('/api/products/visible')
    expect(read.status).toBe(200)
    expect(read.body.sku).toBe('visible')
  })

  it('responde 400 al publicar dos veces y 404 si no existe', async () => {
    await create({ ...base, sku: 'doble' })
    await request(app.getHttpServer()).post('/api/products/doble/publication')

    expect(
      (await request(app.getHttpServer()).post('/api/products/doble/publication')).status,
    ).toBe(400)
    expect(
      (await request(app.getHttpServer()).post('/api/products/inexistente/publication')).status,
    ).toBe(404)
  })

  it('cambia el precio de un producto publicado', async () => {
    await create({ ...base, sku: 'con-precio' })
    await request(app.getHttpServer()).post('/api/products/con-precio/publication')

    const response = await request(app.getHttpServer())
      .post('/api/products/con-precio/price')
      .send({ priceAmount: 18_000, priceCurrency: 'COP' })

    expect(response.status).toBe(200)
    expect(response.body.price).toEqual({ amount: 18_000, currency: 'COP' })
  })

  it('archiva el producto y deja de ser visible', async () => {
    await create({ ...base, sku: 'para-archivar' })
    await request(app.getHttpServer()).post('/api/products/para-archivar/publication')

    const archive = await request(app.getHttpServer()).post('/api/products/para-archivar/archival')
    expect(archive.status).toBe(200)
    expect(archive.body.status).toBe('ARCHIVED')

    expect((await request(app.getHttpServer()).get('/api/products/para-archivar')).status).toBe(404)
  })

  it('responde 400 al cambiar el precio de un producto archivado', async () => {
    await create({ ...base, sku: 'archivado-precio' })
    await request(app.getHttpServer()).post('/api/products/archivado-precio/archival')

    const response = await request(app.getHttpServer())
      .post('/api/products/archivado-precio/price')
      .send({ priceAmount: 20_000, priceCurrency: 'COP' })

    expect(response.status).toBe(400)
  })

  it('GET /api/products lista solo publicados y filtra por categoria', async () => {
    await create({ ...base, sku: 'listado-arma', category: 'listado-armas' })
    await request(app.getHttpServer()).post('/api/products/listado-arma/publication')

    await create({
      ...base,
      sku: 'listado-pocion',
      category: 'listado-consumibles',
      name: 'Pocion listada',
    })
    await request(app.getHttpServer()).post('/api/products/listado-pocion/publication')

    await create({ ...base, sku: 'listado-borrador', category: 'listado-armas' })

    const armas = await request(app.getHttpServer()).get('/api/products?category=listado-armas')

    expect(armas.status).toBe(200)
    expect(armas.body.map((product: { sku: string }) => product.sku)).toEqual(['listado-arma'])
  })

  it('GET /api/products responde 400 con una categoria mal formada', async () => {
    expect(
      (await request(app.getHttpServer()).get('/api/products?category=Armas%20Pesadas')).status,
    ).toBe(400)
  })
})

describe('Sondas de salud', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /api/health/live responde 200', async () => {
    expect((await request(app.getHttpServer()).get('/api/health/live')).body).toEqual({
      status: 'ok',
      checks: {},
    })
  })

  it('GET /api/health/ready evalua las dependencias reales', async () => {
    const response = await request(app.getHttpServer()).get('/api/health/ready')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok', checks: { 'products-repository': 'ok' } })
  })

  it('GET /api/version expone servicio, version y entorno', async () => {
    const response = await request(app.getHttpServer()).get('/api/version')

    expect(response.body).toMatchObject({ service: 'nexus-battle-catalog' })
  })
})
