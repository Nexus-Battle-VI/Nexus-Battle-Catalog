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
import { AdminProductsController } from '../../adapters/inbound/http/admin-products.controller'
import { InternalProductAcquisitionsController } from '../../adapters/inbound/http/internal-product-acquisitions.controller'
import { InternalServiceGuard } from '../../adapters/inbound/http/auth/internal-service.guard'
import { AdjustProductInventory } from '../../application/use-cases/AdjustProductInventory'
import { GetCanonicalProduct } from '../../application/use-cases/GetCanonicalProduct'
import { AcquireProductUnit } from '../../application/use-cases/AcquireProductUnit'
import { ListCatalogStorefront } from '../../application/use-cases/ListCatalogStorefront'
import type { CatalogStorefrontPort } from '../../application/ports/CatalogStorefrontPort'
import { StockReservations } from '../../application/use-cases/StockReservations'
import {
  STOCK_RESERVATIONS,
  type StockReservationPort,
} from '../../application/ports/StockReservationPort'
import { InMemoryStockReservationRepository } from '../../adapters/outbound/persistence/InMemoryStockReservationRepository'
import { MongoStockReservationRepository } from '../../adapters/outbound/persistence/MongoStockReservationRepository'
import { InternalStockReservationsController } from '../../adapters/inbound/http/internal-stock-reservations.controller'
import { MongoProductAcquisitionRepository } from '../../adapters/outbound/persistence/MongoProductAcquisitionRepository'
import { InMemoryProductAcquisitionRepository } from '../../adapters/outbound/persistence/InMemoryProductAcquisitionRepository'
import { AdminProductAssetsController } from '../../adapters/inbound/http/admin-product-assets.controller'
import { CatalogProductAssetsController } from '../../adapters/inbound/http/catalog-product-assets.controller'
import { HealthController } from '../../adapters/inbound/http/health.controller'
import {
  ARCHIVE_PRODUCT,
  CHANGE_PRICE,
  CREATE_PRODUCT,
  GET_PRODUCT,
  LIST_PRODUCTS,
  PUBLISH_PRODUCT,
  CREATE_CANONICAL_PRODUCT,
  GET_CANONICAL_PRODUCT_BY_REFERENCE,
  LOOKUP_CANONICAL_PRODUCTS,
  ADJUST_PRODUCT_INVENTORY,
  GET_CANONICAL_PRODUCT,
  ACQUIRE_PRODUCT_UNIT,
  CREATE_PRODUCT_ASSET_UPLOAD_INTENT,
  FINALIZE_PRODUCT_ASSET,
  GET_PRODUCT_ASSET_CONTENT,
  RECONCILE_PRODUCT_ASSETS,
  PRODUCT_ASSET_STORAGE_PORT,
  PRODUCT_ASSET_REPOSITORY_PORT,
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
import {
  GetCanonicalProductByReference,
  LookupCanonicalProducts,
} from '../../application/use-cases/CanonicalProductQueries'
import { CreateProductAssetUploadIntent } from '../../application/use-cases/CreateProductAssetUploadIntent'
import { FinalizeProductAsset } from '../../application/use-cases/FinalizeProductAsset'
import { GetProductAssetContent } from '../../application/use-cases/GetProductAssetContent'
import { ReconcileProductAssets } from '../../application/use-cases/ReconcileProductAssets'
import { PRODUCT_REPOSITORY } from '../../application/ports/ProductRepositoryPort'
import { CLOCK } from '../../application/ports/ClockPort'
import type { ProductRepositoryPort } from '../../application/ports/ProductRepositoryPort'
import type { ClockPort } from '../../application/ports/ClockPort'
import type { ProductAssetStoragePort } from '../../application/ports/ProductAssetStoragePort'
import type { ProductAssetRepositoryPort } from '../../application/ports/ProductAssetRepositoryPort'

import { InMemoryProductRepository } from '../../adapters/outbound/persistence/InMemoryProductRepository'
import { InMemoryCanonicalProductRepository } from '../../adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { InMemoryCanonicalProductUnitOfWork } from '../../adapters/outbound/persistence/InMemoryCanonicalProductUnitOfWork'
import { InMemoryProductAssetRepository } from '../../adapters/outbound/persistence/InMemoryProductAssetRepository'
import { MongoProductRepository } from '../../adapters/outbound/persistence/MongoProductRepository'
import { MongoCanonicalProductRepository } from '../../adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoProductAuditRepository } from '../../adapters/outbound/persistence/MongoProductAuditRepository'
import { MongoProductOutboxRepository } from '../../adapters/outbound/persistence/MongoProductOutboxRepository'
import { MongoCanonicalProductUnitOfWork } from '../../adapters/outbound/persistence/MongoCanonicalProductUnitOfWork'
import { MongoProductAssetRepository } from '../../adapters/outbound/persistence/MongoProductAssetRepository'
import { InMemoryProductAssetStorageAdapter } from '../../adapters/outbound/storage/InMemoryProductAssetStorageAdapter'
import { S3ProductAssetStorageAdapter } from '../../adapters/outbound/storage/S3ProductAssetStorageAdapter'
import { SystemClock } from '../../adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../adapters/outbound/system/UuidGenerator'
import { HeroSubtypeRegistryV1 } from '../../adapters/outbound/registry/HeroSubtypeRegistryV1'

import { createMongoClient, databaseOf } from '../persistence/database'
import { createLogger, type Logger } from '../observability/logger'
import {
  AssetsStorageDriver,
  AuthMode,
  loadConfig,
  PersistenceDriver,
  type AppConfig,
} from '../config/env'

import { JwtAuthGuard } from '../../adapters/inbound/http/auth/jwt-auth.guard'
import { RolesGuard } from '../../adapters/inbound/http/auth/roles.guard'
import { AnonymousIdentityGuard } from '../../adapters/inbound/http/auth/anonymous.guard'
import { TOKEN_VERIFIER } from '../../application/ports/TokenVerifierPort'
import type { TokenVerifierPort } from '../../application/ports/TokenVerifierPort'
import { CognitoTokenVerifier } from '../../adapters/outbound/identity/CognitoTokenVerifier'
import { ID_GENERATOR } from '../../application/ports/IdGeneratorPort'
import {
  CANONICAL_PRODUCT_READ,
  CANONICAL_PRODUCT_REPOSITORY,
  CANONICAL_PRODUCT_UNIT_OF_WORK,
  CANONICAL_PRODUCT_WRITE,
  HERO_SUBTYPE_REGISTRY,
  PRODUCT_AUDIT_PORT,
  PRODUCT_OUTBOX_PORT,
  PRODUCT_ACQUISITION_PORT,
  PRODUCT_REFERENCE_QUERY,
  type CanonicalProductReadPort,
  type CanonicalProductRepositoryPort,
  type CanonicalProductUnitOfWorkPort,
  type ProductAcquisitionPort,
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
  controllers: [
    ProductsController,
    CanonicalProductsController,
    AdminProductsController,
    InternalProductAcquisitionsController,
    InternalStockReservationsController,
    AdminProductAssetsController,
    CatalogProductAssetsController,
    HealthController,
  ],
  providers: [
    {
      provide: STOCK_RESERVATIONS,
      useFactory: (
        database: Db | null,
        client: MongoClient | null,
        products: CanonicalProductRepositoryPort,
      ): StockReservationPort => {
        if (database !== null && client !== null)
          return new MongoStockReservationRepository(database, client)
        if (!(products instanceof InMemoryCanonicalProductRepository))
          throw new Error('El almacén de reservas necesita el mismo catálogo en memoria.')
        return new InMemoryStockReservationRepository(products)
      },
      inject: [CATALOG_DATABASE, CATALOG_MONGO_CLIENT, CANONICAL_PRODUCT_REPOSITORY],
    },
    {
      provide: StockReservations,
      useFactory: (reservations: StockReservationPort, clock: ClockPort): StockReservations =>
        new StockReservations(reservations, clock),
      inject: [STOCK_RESERVATIONS, CLOCK],
    },
    {
      provide: ListCatalogStorefront,
      useFactory: (products: CatalogStorefrontPort): ListCatalogStorefront =>
        new ListCatalogStorefront(products),
      inject: [CANONICAL_PRODUCT_REPOSITORY],
    },
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
    { provide: CANONICAL_PRODUCT_READ, useExisting: CANONICAL_PRODUCT_REPOSITORY },
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
      // El contrato interno va PRIMERO y se registra SIEMPRE, tambien con
      // `AUTH_MODE=disabled`.
      //
      // Siempre, porque su proteccion no depende de que haya proveedor de
      // identidad: quien llama no es una persona, es otro servicio con un
      // secreto compartido. Atarlo a `AUTH_MODE` dejaria el endpoint interno
      // abierto en cualquier entorno sin proveedor.
      //
      // Primero, porque las rutas internas no llevan testimonio: si el guard de
      // testimonios actuara antes, la peticion firmada seria rechazada por no
      // traer algo que no le corresponde traer.
      provide: APP_GUARD,
      useFactory: (config: AppConfig, reflector: Reflector, logger: Logger): CanActivate =>
        new InternalServiceGuard({
          reflector,
          secret: config.internalServiceAuthSecret,
          // Lista explicita: hoy solo Commerce adquiere unidades. Subasta se
          // anade cuando exista, y anadirla obliga a decidirlo aqui.
          allowedServices: ['commerce'],
          clock: new SystemClock(),
          logger,
        }),
      inject: [APP_CONFIG, Reflector, LOGGER],
    },
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
      provide: PRODUCT_ACQUISITION_PORT,
      useFactory: (config: AppConfig, database: Db | null): ProductAcquisitionPort => {
        if (config.persistenceDriver !== PersistenceDriver.Mongo) {
          return new InMemoryProductAcquisitionRepository()
        }
        if (database === null) throw new Error('MongoDB no se inicializo.')
        return new MongoProductAcquisitionRepository(database)
      },
      inject: [APP_CONFIG, CATALOG_DATABASE],
    },
    {
      provide: ADJUST_PRODUCT_INVENTORY,
      useFactory: (
        products: CanonicalProductRepositoryPort,
        clock: ClockPort,
        idGenerator: IdGeneratorPort,
        unitOfWork: CanonicalProductUnitOfWorkPort,
        audit: ProductAuditPort,
        outbox: ProductOutboxPort,
      ): AdjustProductInventory =>
        new AdjustProductInventory({ products, clock, idGenerator, unitOfWork, audit, outbox }),
      inject: [
        CANONICAL_PRODUCT_WRITE,
        CLOCK,
        ID_GENERATOR,
        CANONICAL_PRODUCT_UNIT_OF_WORK,
        PRODUCT_AUDIT_PORT,
        PRODUCT_OUTBOX_PORT,
      ],
    },
    {
      provide: GET_CANONICAL_PRODUCT,
      useFactory: (products: CanonicalProductRepositoryPort): GetCanonicalProduct =>
        new GetCanonicalProduct({ products }),
      inject: [CANONICAL_PRODUCT_WRITE],
    },
    {
      provide: ACQUIRE_PRODUCT_UNIT,
      useFactory: (
        products: CanonicalProductRepositoryPort,
        acquisitions: ProductAcquisitionPort,
        clock: ClockPort,
        idGenerator: IdGeneratorPort,
        unitOfWork: CanonicalProductUnitOfWorkPort,
        outbox: ProductOutboxPort,
      ): AcquireProductUnit =>
        new AcquireProductUnit({ products, acquisitions, clock, idGenerator, unitOfWork, outbox }),
      inject: [
        CANONICAL_PRODUCT_WRITE,
        PRODUCT_ACQUISITION_PORT,
        CLOCK,
        ID_GENERATOR,
        CANONICAL_PRODUCT_UNIT_OF_WORK,
        PRODUCT_OUTBOX_PORT,
      ],
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
        productAssets: ProductAssetRepositoryPort,
        config: AppConfig,
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
          productAssets,
          assetsEnforceStrict: config.assetsEnforceStrict,
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
        PRODUCT_ASSET_REPOSITORY_PORT,
        APP_CONFIG,
      ],
    },
    {
      provide: GET_CANONICAL_PRODUCT_BY_REFERENCE,
      useFactory: (products: CanonicalProductReadPort): GetCanonicalProductByReference =>
        new GetCanonicalProductByReference(products),
      inject: [CANONICAL_PRODUCT_READ],
    },
    {
      provide: LOOKUP_CANONICAL_PRODUCTS,
      useFactory: (products: CanonicalProductReadPort): LookupCanonicalProducts =>
        new LookupCanonicalProducts(products),
      inject: [CANONICAL_PRODUCT_READ],
    },
    {
      provide: PRODUCT_ASSET_REPOSITORY_PORT,
      useFactory: (config: AppConfig, db: Db | null): ProductAssetRepositoryPort =>
        config.persistenceDriver === PersistenceDriver.Mongo && db !== null
          ? new MongoProductAssetRepository(db)
          : new InMemoryProductAssetRepository(),
      inject: [APP_CONFIG, CATALOG_DATABASE],
    },
    {
      provide: PRODUCT_ASSET_STORAGE_PORT,
      useFactory: (config: AppConfig, logger: Logger): ProductAssetStoragePort => {
        if (config.assetsStorageDriver === AssetsStorageDriver.S3 && config.assetsBucketName) {
          logger.info('product_asset_storage', { driver: 's3', bucket: config.assetsBucketName })
          return new S3ProductAssetStorageAdapter({
            bucketName: config.assetsBucketName,
            region: config.assetsRegion,
          })
        }
        logger.info('product_asset_storage', { driver: 'memory' })
        return new InMemoryProductAssetStorageAdapter()
      },
      inject: [APP_CONFIG, LOGGER],
    },
    {
      provide: CREATE_PRODUCT_ASSET_UPLOAD_INTENT,
      useFactory: (
        storage: ProductAssetStoragePort,
        repository: ProductAssetRepositoryPort,
        idGenerator: IdGeneratorPort,
        clock: ClockPort,
        config: AppConfig,
      ): CreateProductAssetUploadIntent =>
        new CreateProductAssetUploadIntent({
          storage,
          repository,
          idGenerator,
          clock,
          apiBaseUrl: config.assetsBaseUrl,
        }),
      inject: [
        PRODUCT_ASSET_STORAGE_PORT,
        PRODUCT_ASSET_REPOSITORY_PORT,
        ID_GENERATOR,
        CLOCK,
        APP_CONFIG,
      ],
    },
    {
      provide: FINALIZE_PRODUCT_ASSET,
      useFactory: (
        storage: ProductAssetStoragePort,
        repository: ProductAssetRepositoryPort,
        clock: ClockPort,
      ): FinalizeProductAsset =>
        new FinalizeProductAsset({
          storage,
          repository,
          clock,
        }),
      inject: [PRODUCT_ASSET_STORAGE_PORT, PRODUCT_ASSET_REPOSITORY_PORT, CLOCK],
    },
    {
      provide: GET_PRODUCT_ASSET_CONTENT,
      useFactory: (
        storage: ProductAssetStoragePort,
        repository: ProductAssetRepositoryPort,
      ): GetProductAssetContent =>
        new GetProductAssetContent({
          storage,
          repository,
        }),
      inject: [PRODUCT_ASSET_STORAGE_PORT, PRODUCT_ASSET_REPOSITORY_PORT],
    },
    {
      provide: RECONCILE_PRODUCT_ASSETS,
      useFactory: (
        storage: ProductAssetStoragePort,
        repository: ProductAssetRepositoryPort,
        clock: ClockPort,
      ): ReconcileProductAssets =>
        new ReconcileProductAssets({
          storage,
          repository,
          clock,
        }),
      inject: [PRODUCT_ASSET_STORAGE_PORT, PRODUCT_ASSET_REPOSITORY_PORT, CLOCK],
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
