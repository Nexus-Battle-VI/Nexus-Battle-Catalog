import 'reflect-metadata'

import { ValidationPipe, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'

/**
 * `GET /api/v1/catalog/product-assets/:assetId/content` es `@Public()`: la
 * vitrina de e-commerce se navega sin cuenta (HU-02, feature guest-vitrina), y
 * eso incluye ver la imagen de cada producto. Antes de este cambio el
 * `JwtAuthGuard` global respondia 401 "Falta el testimonio de identidad." a
 * cualquier peticion anonima, dejando las imagenes rotas para quien solo mira.
 *
 * La prueba no siembra ningun asset: lo unico que importa es que una peticion
 * SIN cabecera Authorization llegue hasta el caso de uso (404, no 401).
 */
describe('Acceso publico al contenido de assets de producto', () => {
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

  it('GET /content sin testimonio de identidad no devuelve 401', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/catalog/product-assets/00000000-0000-0000-0000-000000000000/content',
    )

    expect(response.status).not.toBe(401)
    expect(response.status).toBe(404)
  })
})
