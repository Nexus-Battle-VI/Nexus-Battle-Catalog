import type { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'

import type { AppConfig } from '../config/env'

/**
 * Documento OpenAPI generado por Catalog.
 *
 * Se centraliza para que el servidor y la prueba de contrato inspeccionen la
 * misma salida. El endpoint canónico se contrasta contra el contrato aceptado
 * de Infrastructure, no contra una descripción escrita aparte en cada prueba.
 */
export const createCatalogOpenApiDocument = (app: INestApplication, config: AppConfig) =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nexus Battles VI — Catalog')
      .setDescription('API del bounded context Catalog.')
      .setVersion(config.version)
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Testimonio JWT verificado por el proveedor de identidad aprobado.',
        },
        'bearerAuth',
      )
      .build(),
  )
