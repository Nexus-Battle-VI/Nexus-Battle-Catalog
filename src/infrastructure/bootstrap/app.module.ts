import { Module, type CanActivate } from '@nestjs/common'
import { APP_GUARD, Reflector } from '@nestjs/core'
import type { Db, MongoClient } from 'mongodb'

import { ProductsController } from '../../adapters/inbound/http/products.controller'
import { MfaEvidenceGuard } from '../../adapters/inbound/http/auth/mfa-evidence.guard'
import { AccountMfaEvidenceClient } from '../../adapters/outbound/identity/AccountMfaEvidenceClient'
import {
  MFA_EVIDENCE_VERIFIER,
  MfaEvidenceOutcome,
  type MfaEvidenceVerifierPort,
} from '../../application/ports/MfaEvidenceVerifierPort'
import { CanonicalProductsController } from '../../adapters/inbound/http/canonical-products.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import {
  ARCHIVE_PRODUCT,
  CHANGE_PRICE,
  CREATE_PRODUCT,
  GET_PRODUCT,
  LIST_PRODUCTS,
  PUBLISH_PRODUCT,
  CREATE_CANONICAL_PRODUCT,
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
import { CreateCanonicalProduct } from '../../application/use-cases/CreateCanonicalProduct'
import { PRODUCT_REPOSITORY } from '../../application/ports/ProductRepositoryPort'
import { CLOCK } from '../../application/ports/ClockPort'
import type { ProductRepositoryPort } from '../../application/ports/ProductRepositoryPort'
import type { ClockPort } from '../../application/ports/ClockPort'

import { InMemoryProductRepository } from '../../adapters/outbound/persistence/InMemoryProductRepository'
import { InMemoryCanonicalProductRepository } from '../../adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { InMemoryCanonicalProductUnitOfWork } from '../../adapters/outbound/persistence/InMemoryCanonicalProductUnitOfWork'
import { MongoProductRepository } from '../../adapters/outbound/persistence/MongoProductRepository'
import { MongoCanonicalProductRepository } from '../../adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoProductAuditRepository } from '../../adapters/outbound/persistence/MongoProductAuditRepository'
import { MongoProductOutboxRepository } from '../../adapters/outbound/persistence/MongoProductOutboxRepository'
import { MongoCanonicalProductUnitOfWork } from '../../adapters/outbound/persistence/MongoCanonicalProductUnitOfWork'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'
import { HeroSubtypeRegistryV1 } from '../../adapters/outbound/registry/HeroSubtypeRegistryV1'

import { createMongoClient, databaseOf } from '../persistence/database'
import { createLogger, type Logger } from '../observability/logger'
import { AuthMode, loadConfig, PersistenceDriver, type AppConfig } from '../config/env'

import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { TOKEN_VERIFIER } from '../../application/ports/TokenVerifierPort'
import type { TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { ID_GENERATOR } from '../../application/ports/IdGeneratorPort'
import {
  CANONICAL_PRODUCT_REPOSITORY,
  CANONICAL_PRODUCT_UNIT_OF_WORK,
  CANONICAL_PRODUCT_WRITE,
  HERO_SUBTYPE_REGISTRY,
  PRODUCT_AUDIT_PORT,
  PRODUCT_OUTBOX_PORT,
  PRODUCT_REFERENCE_QUERY,
  type CanonicalProductRepositoryPort,
  type CanonicalProductUnitOfWorkPort,
  type ProductAuditPort,
  type ProductOutboxPort,
} from '../../application/ports/CanonicalProductPorts'
import type { IdGeneratorPort } from '../../application/ports/IdGeneratorPort'
import type { ReadinessCheck, VersionReport } from '../health/health'

export const APP_CONFIG = Symbol('AppConfig')
export const LOGGER = Symbol('Logger')
export const CATALOG_MONGO_CLIENT = Symbol('CatalogMongoClient')
const CATALOG_DATABASE = Symbol('CatalogDatabase')

/**
 * Raiz de composicion.
 *
 * Es el unico lugar donde se eligen implementaciones concretas. Los casos de
 * uso son clases planas sin decoradores de NestJS: se registran con fabricas
 * explicitas, de modo que la capa de aplicacion permanece independiente del
 * framework.
 */
@Module({
  controllers: [ProductsController, CanonicalProductsController, HealthController],
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
      provide: CATALOG_MONGO_CLIENT,
      useFactory: async (config: AppConfig, logger: Logger): Promise<MongoClient | null> => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) return null

        if (config.databaseUrl === null) {
          throw new Error('MONGODB_URI es obligatorio con PERSISTENCE_DRIVER=mongo.')
        }

        const options = { uri: config.databaseUrl }
        const client = createMongoClient(options)
        await client.connect()
        logger.info('mongo_persistence', { detail: 'Adaptador MongoDB activo.' })

        return client
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: CATALOG_DATABASE,
      useFactory: (client: MongoClient | null, config: AppConfig): Db | null => {
        if (client === null) return null
        return databaseOf(client, { uri: config.databaseUrl ?? '' })
      },
      inject: [CATALOG_MONGO_CLIENT, APP_CONFIG],
    },
    {
      provide: CANONICAL_PRODUCT_UNIT_OF_WORK,
      useFactory: (
        config: AppConfig,
        client: MongoClient | null,
      ): CanonicalProductUnitOfWorkPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          return new InMemoryCanonicalProductUnitOfWork()
        }
        if (client === null) throw new Error('MongoClient no se inicializo.')
        return new MongoCanonicalProductUnitOfWork(client)
      },
      inject: [APP_CONFIG, CATALOG_MONGO_CLIENT],
    },
    {
      provide: PRODUCT_AUDIT_PORT,
      useFactory: (config: AppConfig, database: Db | null): ProductAuditPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          return new InMemoryProductAuditRepository()
        }
        if (database === null) throw new Error('MongoDB no se inicializo.')
        return new MongoProductAuditRepository(database)
      },
      inject: [APP_CONFIG, CATALOG_DATABASE],
    },
    {
      provide: PRODUCT_OUTBOX_PORT,
      useFactory: (config: AppConfig, database: Db | null): ProductOutboxPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          return new InMemoryProductOutboxRepository()
        }
        if (database === null) throw new Error('MongoDB no se inicializo.')
        return new MongoProductOutboxRepository(database)
      },
      inject: [APP_CONFIG, CATALOG_DATABASE],
    },
    {
      provide: PRODUCT_REPOSITORY,
      useFactory: (
        config: AppConfig,
        logger: Logger,
        database: Db | null,
      ): ProductRepositoryPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          logger.warn('in_memory_persistence', {
            detail: 'PERSISTENCE_DRIVER=memory: el estado se pierde al reiniciar el servicio.',
          })
          return new InMemoryProductRepository()
        }

        if (database === null) throw new Error('MongoDB no se inicializo.')
        return new MongoProductRepository(database)
      },
      inject: [APP_CONFIG, LOGGER, CATALOG_DATABASE],
    },
    {
      provide: CANONICAL_PRODUCT_REPOSITORY,
      useFactory: (config: AppConfig, database: Db | null): CanonicalProductRepositoryPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          return new InMemoryCanonicalProductRepository()
        }

        if (database === null) throw new Error('MongoDB no se inicializo.')
        return new MongoCanonicalProductRepository(database)
      },
      inject: [APP_CONFIG, CATALOG_DATABASE],
    },
    { provide: CANONICAL_PRODUCT_WRITE, useExisting: CANONICAL_PRODUCT_REPOSITORY },
    { provide: PRODUCT_REFERENCE_QUERY, useExisting: CANONICAL_PRODUCT_REPOSITORY },
    { provide: HERO_SUBTYPE_REGISTRY, useFactory: () => new HeroSubtypeRegistryV1() },
    { provide: ID_GENERATOR, useFactory: (): IdGeneratorPort => new UuidGenerator() },
    {
      provide: TOKEN_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): TokenVerifierPort => {
        if (config.cognito === null) {
          // No se devuelve un verificador que acepte cualquier cosa: sin
          // proveedor, el guard directamente no se registra. Un verificador
          // permisivo daria la apariencia de que hay comprobacion.
          logger.warn('authentication_disabled', {
            detail:
              'AUTH_MODE=disabled: ninguna ruta verifica quien realiza la peticion. BLOCKER de ADR-004.',
          })

          return {
            verify: (): Promise<never> => {
              throw new Error('No hay verificador de testimonios configurado.')
            },
          }
        }

        return new CognitoTokenVerifier(config.cognito)
      },
      inject: [APP_CONFIG, LOGGER],
    },
    // Los guards se registran de forma global SOLO cuando hay proveedor. El
    // orden importa: JwtAuthGuard deja la identidad verificada en la peticion y
    // RolesGuard la lee. NestJS los ejecuta en el orden de declaracion.
    {
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: TokenVerifierPort,
      ): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new JwtAuthGuard(reflector, verifier)
          : // Sin proveedor no se deja pasar sin mas: se atribuye la identidad
            // anonima, para que lo que se guarde diga que nadie fue verificado.
            new AnonymousIdentityGuard(),
      inject: [APP_CONFIG, Reflector, TOKEN_VERIFIER],
    },
    {
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector): CanActivate =>
        config.authMode === AuthMode.Jwt
          ? new RolesGuard(reflector)
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector],
    },
    {
      // Comprueba la evidencia de segundo factor en las mutaciones marcadas.
      // Va DESPUES de RolesGuard: quien no tiene rol suficiente ya fue
      // rechazado, y asi no se gasta una llamada de red por cada intento sin
      // permiso.
      provide: APP_GUARD,
      useFactory: (
        config: AppConfig,
        reflector: Reflector,
        verifier: MfaEvidenceVerifierPort,
      ): CanActivate =>
        // Solo con proveedor de identidad activo, igual que `RolesGuard`. Sin
        // proveedor no hay RBAC ni testimonios, asi que exigir evidencia de un
        // segundo factor que nadie pudo superar dejaria el servicio
        // inutilizable en desarrollo sin ganar ninguna proteccion: un binario
        // con `NODE_ENV=production` y `AUTH_MODE=disabled` no arranca.
        config.authMode === AuthMode.Jwt
          ? new MfaEvidenceGuard({ reflector, verifier })
          : { canActivate: (): boolean => true },
      inject: [APP_CONFIG, Reflector, MFA_EVIDENCE_VERIFIER],
    },
    {
      provide: MFA_EVIDENCE_VERIFIER,
      useFactory: (config: AppConfig, logger: Logger): MfaEvidenceVerifierPort => {
        if (config.accountInternalUrl === null || config.internalServiceAuthSecret === null) {
          logger.warn('mfa_evidence_verifier', {
            driver: 'no-configurado',
            detail:
              'Sin ACCOUNT_INTERNAL_URL o INTERNAL_SERVICE_AUTH_SECRET no se puede comprobar el segundo factor: las mutaciones administrativas fallaran cerradas.',
          })

          // NO se deja pasar ante configuracion ausente. Un despliegue
          // incompleto dejaria las mutaciones administrativas exigiendo solo el
          // rol, que es exactamente lo que este cambio viene a cerrar.
          return {
            verify: (): Promise<MfaEvidenceOutcome> =>
              Promise.resolve(MfaEvidenceOutcome.Unavailable),
          }
        }

        logger.info('mfa_evidence_verifier', { driver: 'account' })

        return new AccountMfaEvidenceClient({
          baseUrl: config.accountInternalUrl,
          secret: config.internalServiceAuthSecret,
          serviceName: config.internalServiceName,
          timeoutMs: config.internalTimeoutMs,
          logger,
        })
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
      provide: CREATE_CANONICAL_PRODUCT,
      useFactory: (
        products: CanonicalProductRepositoryPort,
        heroSubtypes: HeroSubtypeRegistryV1,
        productReferences: CanonicalProductRepositoryPort,
        idGenerator: IdGeneratorPort,
        clock: ClockPort,
        unitOfWork: CanonicalProductUnitOfWorkPort,
        audit: ProductAuditPort,
        outbox: ProductOutboxPort,
      ): CreateCanonicalProduct =>
        new CreateCanonicalProduct({
          products,
          heroSubtypes,
          productReferences,
          idGenerator,
          clock,
          unitOfWork,
          audit,
          outbox,
        }),
      inject: [
        CANONICAL_PRODUCT_WRITE,
        HERO_SUBTYPE_REGISTRY,
        PRODUCT_REFERENCE_QUERY,
        ID_GENERATOR,
        CLOCK,
        CANONICAL_PRODUCT_UNIT_OF_WORK,
        PRODUCT_AUDIT_PORT,
        PRODUCT_OUTBOX_PORT,
      ],
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
          check: (): Promise<boolean> => products.isAvailable(),
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
