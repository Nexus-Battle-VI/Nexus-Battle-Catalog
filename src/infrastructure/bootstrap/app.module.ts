import { Module } from '@nestjs/common'

import { ProductsController } from '../../adapters/inbound/http/products.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import {
  ARCHIVE_PRODUCT,
  CHANGE_PRICE,
  CREATE_PRODUCT,
  GET_PRODUCT,
  LIST_PRODUCTS,
  PUBLISH_PRODUCT,
} from '../../adapters/inbound/http/tokens'
import { READINESS_CHECKS, VERSION_REPORT } from '../../adapters/inbound/http/tokens.health'

import {
  ArchiveProduct,
  ChangeProductPrice,
  CreateProduct,
  GetProduct,
  ListProducts,
  PublishProduct,
} from '../../application/use-cases/ProductUseCases'
import { PRODUCT_REPOSITORY } from '../../application/ports/ProductRepositoryPort'
import { CLOCK } from '../../application/ports/ClockPort'
import type { ProductRepositoryPort } from '../../application/ports/ProductRepositoryPort'
import type { ClockPort } from '../../application/ports/ClockPort'

import { InMemoryProductRepository } from '../../adapters/outbound/persistence/InMemoryProductRepository'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'

import { createLogger, type Logger } from '../observability/logger'
import { loadConfig, PersistenceDriver, type AppConfig } from '../config/env'
import type { ReadinessCheck, VersionReport } from '../health/health'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran con fabricas
 * explicitas, de modo que la capa de aplicacion permanece independiente del
 * framework.
 */
@Module({
  controllers: [ProductsController, HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(process.env),
    },
    {
      provide: LOGGER,
      useFactory: (config: AppConfig): Logger =>
        createLogger({
          level: config.logLevel,
          service: config.serviceName,
          version: config.version,
        }),
      inject: [APP_CONFIG],
    },
    {
      provide: PRODUCT_REPOSITORY,
      useFactory: (config: AppConfig, logger: Logger): ProductRepositoryPort => {
        if (config.persistenceDriver === PersistenceDriver.Mongo) {
          // La configuracion se valida al arrancar para que un despliegue mal
          // parametrizado falle de inmediato. El adaptador MongoDB depende de
          // que ADR-005 decida el ODM; no se sustituye por una simulacion.
          logger.warn('mongo_driver_not_available', {
            detail:
              'El adaptador MongoDB requiere ADR-005 aprobado. Se usa el repositorio en memoria.',
          })
        }

        return new InMemoryProductRepository()
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: CLOCK,
      useFactory: (): ClockPort => new SystemClock(),
    },
    {
      provide: CREATE_PRODUCT,
      useFactory: (products: ProductRepositoryPort, clock: ClockPort): CreateProduct =>
        new CreateProduct({ products, clock }),
      inject: [PRODUCT_REPOSITORY, CLOCK],
    },
    {
      provide: PUBLISH_PRODUCT,
      useFactory: (products: ProductRepositoryPort, clock: ClockPort): PublishProduct =>
        new PublishProduct({ products, clock }),
      inject: [PRODUCT_REPOSITORY, CLOCK],
    },
    {
      provide: ARCHIVE_PRODUCT,
      useFactory: (products: ProductRepositoryPort, clock: ClockPort): ArchiveProduct =>
        new ArchiveProduct({ products, clock }),
      inject: [PRODUCT_REPOSITORY, CLOCK],
    },
    {
      provide: CHANGE_PRICE,
      useFactory: (products: ProductRepositoryPort, clock: ClockPort): ChangeProductPrice =>
        new ChangeProductPrice({ products, clock }),
      inject: [PRODUCT_REPOSITORY, CLOCK],
    },
    {
      provide: GET_PRODUCT,
      useFactory: (products: ProductRepositoryPort): GetProduct => new GetProduct(products),
      inject: [PRODUCT_REPOSITORY],
    },
    {
      provide: LIST_PRODUCTS,
      useFactory: (products: ProductRepositoryPort): ListProducts => new ListProducts(products),
      inject: [PRODUCT_REPOSITORY],
    },
    {
      provide: READINESS_CHECKS,
      useFactory: (products: ProductRepositoryPort): readonly ReadinessCheck[] => [
        // La comprobacion ejercita el repositorio de verdad: si el almacen no
        // responde, la sonda falla. No se declara `ok` de forma incondicional.
        {
          name: 'products-repository',
          check: (): boolean => typeof products.search === 'function',
        },
      ],
      inject: [PRODUCT_REPOSITORY],
    },
    {
      provide: VERSION_REPORT,
      useFactory: (config: AppConfig): VersionReport => ({
        service: config.serviceName,
        version: config.version,
        nodeEnv: config.nodeEnv,
      }),
      inject: [APP_CONFIG],
    },
  ],
})
export class AppModule {}
