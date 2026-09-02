import 'reflect-metadata'

import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
import { SwaggerModule } from '@nestjs/swagger'

import { AppModule } from './infrastructure/bootstrap/app.module'
import { loadConfig } from './infrastructure/config/env'
import { createLogger } from './infrastructure/observability/logger'
import { createCatalogOpenApiDocument } from './infrastructure/openapi/catalog-openapi'

const bootstrap = async (): Promise<void> => {
  const config = loadConfig(process.env)
  const logger = createLogger({
    level: config.logLevel,
    service: config.serviceName,
    version: config.version,
  })

  const app = await NestFactory.create(AppModule, { logger: false })

  app.setGlobalPrefix(config.globalPrefix)

  app.useGlobalPipes(
    new ValidationPipe({
      // Se descartan las propiedades no declaradas y se rechaza la peticion si
      // llegan campos desconocidos: evita que un cliente inyecte datos que el
      // contrato no contempla.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  app.enableShutdownHooks()

  if (config.swaggerEnabled) {
    const document = createCatalogOpenApiDocument(app, config)

    SwaggerModule.setup(`${config.globalPrefix}/docs`, app, document)
  }

  await app.listen(config.port)

  logger.info('service_started', {
    port: config.port,
    globalPrefix: config.globalPrefix,
    persistenceDriver: config.persistenceDriver,
    swagger: config.swaggerEnabled,
  })
}

void bootstrap()
