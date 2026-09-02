import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { AppModule } from '../../src/infrastructure/bootstrap/app.module'
import { loadConfig } from '../../src/infrastructure/config/env'
import { createCatalogOpenApiDocument } from '../../src/infrastructure/openapi/catalog-openapi'

const INFRASTRUCTURE_CONTRACT_URL =
  'https://raw.githubusercontent.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/main/docs/contracts/catalog-product-v1.openapi.yaml'

/**
 * Guardarraíl local del contrato objetivo de Infrastructure:
 * docs/contracts/catalog-product-v1.openapi.yaml (v1.0.0, ADR-013).
 *
 * Cubre las propiedades de integración que no pueden quedar a criterio del
 * controlador: ruta, operación, JWT y catálogo estable de respuestas. La
 * forma cerrada de los datos se valida en las pruebas HTTP y en el parser del
 * dominio, que rechaza variantes y campos no declarados.
 */
describe('OpenAPI del producto canónico', () => {
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

  it('expone el endpoint aceptado por ADR-013 con seguridad y respuestas estables', () => {
    const document = createCatalogOpenApiDocument(app, loadConfig(process.env))
    const operation = document.paths['/api/v1/catalog/products']?.post

    expect(operation).toBeDefined()
    expect(operation).toMatchObject({
      operationId: 'createCatalogProductV1',
      tags: ['Catalog Products'],
      security: [{ bearerAuth: [] }],
    })
    expect(Object.keys(operation?.responses ?? {})).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '422',
      '503',
    ])
    expect(document.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    })
  })

  /**
   * Se habilita en CI porque es una comparación entre repositorios. El test
   * local anterior permanece determinista y permite trabajar sin red; CI falla
   * si Infrastructure cambia el contrato objetivo sin que Catalog lo adopte.
   */
  const verifyAgainstInfrastructure = process.env.VERIFY_INFRASTRUCTURE_OPENAPI === 'true'

  ;(verifyAgainstInfrastructure ? it : it.skip)(
    'coincide con el contrato aceptado publicado por Infrastructure',
    async () => {
      const response = await fetch(INFRASTRUCTURE_CONTRACT_URL)
      expect(response.ok).toBe(true)

      const target = await response.text()
      const local = createCatalogOpenApiDocument(app, loadConfig(process.env))
      const operation = local.paths['/api/v1/catalog/products']?.post

      expect(target).toContain('openapi: 3.1.0')
      expect(target).toContain('x-contract-status: accepted')
      expect(target).toContain('/api/v1/catalog/products:')
      expect(target).toContain('operationId: createCatalogProductV1')
      expect(target).toContain('bearerAuth: []')

      // `503` forma parte del contrato desde que la autorizacion consulta a
      // Account y falla cerrada cuando no puede comprobar el TOTP. Si
      // Infrastructure no lo publica, el consumidor recibiria una respuesta
      // que su especificacion no contempla; la comprobacion entre repositorios
      // debe detectarlo en vez de limitarse al catalogo historico.
      for (const status of ['201', '400', '401', '403', '409', '422', '503']) {
        expect(target).toContain(`'${status}':`)
        expect(operation?.responses).toHaveProperty(status)
      }

      expect(operation).toMatchObject({
        operationId: 'createCatalogProductV1',
        security: [{ bearerAuth: [] }],
      })
    },
  )
})
