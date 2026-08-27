import {
  ArchiveProduct,
  ChangeProductPrice,
  CreateProduct,
  GetProduct,
  ListProducts,
  PublishProduct,
} from '../../src/application/use-cases/ProductUseCases'
import {
  ProductAlreadyExistsError,
  ProductNotFoundError,
} from '../../src/application/errors/ApplicationError'
import { InMemoryProductRepository } from '../../src/adapters/outbound/persistence/InMemoryProductRepository'
import { Product, ProductStatus } from '../../src/domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { DomainError } from '../../src/domain/errors/DomainError'
import { ConfigurationError, loadConfig } from '../../src/infrastructure/config/env'
import { createLogger } from '../../src/infrastructure/observability/logger'
import { buildLiveness, buildReadiness, buildVersion } from '../../src/infrastructure/health/health'
import { SystemClock } from '../../src/adapters/outbound/system/SystemClock'
import { UuidGenerator } from '../../src/adapters/outbound/system/UuidGenerator'

const FIXED_NOW = new Date('2026-08-21T10:00:00.000Z')

interface Harness {
  products: InMemoryProductRepository
  create: CreateProduct
  publish: PublishProduct
  archive: ArchiveProduct
  changePrice: ChangeProductPrice
  get: GetProduct
  list: ListProducts
}

const buildHarness = (): Harness => {
  const products = new InMemoryProductRepository()
  const deps = { products, clock: { now: (): Date => FIXED_NOW } }

  return {
    products,
    create: new CreateProduct(deps),
    publish: new PublishProduct(deps),
    archive: new ArchiveProduct(deps),
    changePrice: new ChangeProductPrice(deps),
    get: new GetProduct(products),
    list: new ListProducts(products),
  }
}

const command = {
  sku: 'espada-de-hierro',
  name: 'Espada de hierro',
  category: 'armas',
  priceAmount: 15_000,
  priceCurrency: 'COP',
}

describe('CreateProduct', () => {
  it('crea el producto en borrador', async () => {
    const harness = buildHarness()

    const result = await harness.create.execute(command)

    expect(result).toEqual({
      sku: 'espada-de-hierro',
      name: 'Espada de hierro',
      category: 'armas',
      price: { amount: 15_000, currency: 'COP' },
      isPremium: false,
      realMoneyPrice: null,
      status: ProductStatus.Draft,
    })
    expect(harness.products.size).toBe(1)
  })

  it('normaliza la referencia, el nombre y la categoria', async () => {
    const harness = buildHarness()

    const result = await harness.create.execute({
      ...command,
      sku: '  Espada-De-Hierro ',
      name: '  Espada   de   hierro ',
      category: ' ARMAS ',
      priceCurrency: ' cop ',
    })

    expect(result.sku).toBe('espada-de-hierro')
    expect(result.name).toBe('Espada de hierro')
    expect(result.category).toBe('armas')
    expect(result.price.currency).toBe('COP')
  })

  it('rechaza una referencia duplicada', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)

    await expect(
      harness.create.execute({ ...command, name: 'Producto que no debe reemplazar al original' }),
    ).rejects.toBeInstanceOf(ProductAlreadyExistsError)
    expect(harness.products.size).toBe(1)
    await expect(harness.get.execute(command.sku, true)).resolves.toMatchObject({
      name: command.name,
    })
  })

  it('solo admite una de dos creaciones concurrentes del mismo SKU', async () => {
    const harness = buildHarness()

    const results = await Promise.allSettled([
      harness.create.execute({ ...command, name: 'Primer candidato' }),
      harness.create.execute({ ...command, name: 'Segundo candidato' }),
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    expect(harness.products.size).toBe(1)
  })

  it.each([
    ['referencia invalida', { sku: 'Espada_Hierro' }],
    ['nombre demasiado corto', { name: 'Ab' }],
    ['categoria invalida', { category: 'Armas Pesadas' }],
    ['precio cero', { priceAmount: 0 }],
    ['precio fraccionario', { priceAmount: 1_500.5 }],
    ['moneda no soportada', { priceCurrency: 'GBP' }],
  ])('rechaza una peticion con %s', async (_caso, override) => {
    const harness = buildHarness()

    await expect(harness.create.execute({ ...command, ...override })).rejects.toBeInstanceOf(
      DomainError,
    )
  })
})

describe('PublishProduct', () => {
  it('publica y persiste el resultado', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)

    const result = await harness.publish.execute(command.sku)

    expect(result.status).toBe(ProductStatus.Published)
    // Se relee del repositorio para confirmar que quedo persistido.
    expect((await harness.get.execute(command.sku)).status).toBe(ProductStatus.Published)
  })

  it('falla cuando el producto no existe', async () => {
    const harness = buildHarness()

    await expect(harness.publish.execute('inexistente')).rejects.toBeInstanceOf(
      ProductNotFoundError,
    )
  })

  it('propaga la doble publicacion como error de dominio', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)
    await harness.publish.execute(command.sku)

    await expect(harness.publish.execute(command.sku)).rejects.toBeInstanceOf(DomainError)
  })
})

describe('ArchiveProduct', () => {
  it('archiva y retira de las consultas publicas', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)
    await harness.publish.execute(command.sku)

    const result = await harness.archive.execute(command.sku)

    expect(result.status).toBe(ProductStatus.Archived)
    await expect(harness.get.execute(command.sku)).rejects.toBeInstanceOf(ProductNotFoundError)
    expect(await harness.list.execute()).toHaveLength(0)
  })

  it('falla cuando el producto no existe', async () => {
    const harness = buildHarness()

    await expect(harness.archive.execute('inexistente')).rejects.toBeInstanceOf(
      ProductNotFoundError,
    )
  })
})

describe('ChangeProductPrice', () => {
  it('cambia el precio y persiste el resultado', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)
    await harness.publish.execute(command.sku)

    const result = await harness.changePrice.execute({
      sku: command.sku,
      priceAmount: 18_000,
      priceCurrency: 'COP',
    })

    expect(result.price).toEqual({ amount: 18_000, currency: 'COP' })
    expect((await harness.get.execute(command.sku)).price.amount).toBe(18_000)
  })

  it('falla cuando el producto no existe', async () => {
    const harness = buildHarness()

    await expect(
      harness.changePrice.execute({ sku: 'inexistente', priceAmount: 1, priceCurrency: 'COP' }),
    ).rejects.toBeInstanceOf(ProductNotFoundError)
  })

  it('propaga el rechazo de un producto archivado', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)
    await harness.archive.execute(command.sku)

    await expect(
      harness.changePrice.execute({
        sku: command.sku,
        priceAmount: 20_000,
        priceCurrency: 'COP',
      }),
    ).rejects.toBeInstanceOf(DomainError)
  })
})

describe('GetProduct', () => {
  it('oculta un producto en borrador en la consulta publica', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)

    await expect(harness.get.execute(command.sku)).rejects.toBeInstanceOf(ProductNotFoundError)
  })

  it('permite recuperar un borrador cuando se solicita explicitamente', async () => {
    const harness = buildHarness()
    await harness.create.execute(command)

    expect((await harness.get.execute(command.sku, true)).status).toBe(ProductStatus.Draft)
  })

  it('rechaza una referencia mal formada', async () => {
    const harness = buildHarness()

    await expect(harness.get.execute('Espada_Hierro')).rejects.toBeInstanceOf(DomainError)
  })
})

describe('ListProducts', () => {
  const seed = async (harness: Harness): Promise<void> => {
    await harness.create.execute(command)
    await harness.publish.execute(command.sku)

    await harness.create.execute({
      ...command,
      sku: 'arco-corto',
      name: 'Arco corto',
      category: 'armas',
    })
    await harness.publish.execute('arco-corto')

    await harness.create.execute({
      ...command,
      sku: 'pocion-de-vida',
      name: 'Pocion de vida',
      category: 'consumibles',
      priceAmount: 2_000,
    })
    await harness.publish.execute('pocion-de-vida')

    // Este permanece en borrador y no debe aparecer.
    await harness.create.execute({
      ...command,
      sku: 'escudo-secreto',
      name: 'Escudo secreto',
      category: 'armas',
    })
  }

  it('lista solo los productos publicados, en orden estable', async () => {
    const harness = buildHarness()
    await seed(harness)

    const result = await harness.list.execute()

    expect(result.map((product) => product.sku)).toEqual([
      'arco-corto',
      'espada-de-hierro',
      'pocion-de-vida',
    ])
  })

  it('filtra por categoria', async () => {
    const harness = buildHarness()
    await seed(harness)

    expect((await harness.list.execute('armas')).map((product) => product.sku)).toEqual([
      'arco-corto',
      'espada-de-hierro',
    ])
    expect((await harness.list.execute('consumibles')).map((product) => product.sku)).toEqual([
      'pocion-de-vida',
    ])
    expect(await harness.list.execute('inexistente-categoria')).toHaveLength(0)
  })

  it('rechaza una categoria mal formada', async () => {
    const harness = buildHarness()

    await expect(harness.list.execute('Armas Pesadas')).rejects.toBeInstanceOf(DomainError)
  })
})

describe('InMemoryProductRepository', () => {
  it('almacena instantaneas, no referencias vivas al agregado', async () => {
    const repository = new InMemoryProductRepository()
    const product = Product.draft({
      sku: Sku.create('pocion'),
      name: ProductName.create('Pocion de vida'),
      category: Category.create('consumibles'),
      price: Money.create(2_000, 'COP'),
    })
    await repository.save(product)

    // Se muta el agregado sin volver a guardarlo.
    product.publish(FIXED_NOW)

    const stored = await repository.findBySku(Sku.create('pocion'))

    expect(stored?.currentStatus).toBe(ProductStatus.Draft)
    expect(product.currentStatus).toBe(ProductStatus.Published)
  })

  it('responde a existencia, ausencia y vaciado', async () => {
    const repository = new InMemoryProductRepository()

    expect(await repository.exists(Sku.create('nada'))).toBe(false)
    expect(await repository.findBySku(Sku.create('nada'))).toBeNull()

    await repository.save(
      Product.draft({
        sku: Sku.create('pocion'),
        name: ProductName.create('Pocion de vida'),
        category: Category.create('consumibles'),
        price: Money.create(2_000, 'COP'),
      }),
    )

    expect(await repository.exists(Sku.create('pocion'))).toBe(true)
    expect(repository.size).toBe(1)

    repository.clear()
    expect(repository.size).toBe(0)
  })

  it('incluye ocultos cuando se solicita', async () => {
    const repository = new InMemoryProductRepository()
    await repository.save(
      Product.draft({
        sku: Sku.create('borrador'),
        name: ProductName.create('Producto borrador'),
        category: Category.create('varios'),
        price: Money.create(100, 'COP'),
      }),
    )

    expect(await repository.search({})).toHaveLength(0)
    expect(await repository.search({ includeHidden: true })).toHaveLength(1)
  })
})

describe('loadConfig', () => {
  it('aplica valores por defecto seguros para el entorno local', () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: 'development',
      serviceName: 'nexus-battle-catalog',
      port: 3003,
      persistenceDriver: 'memory',
      swaggerEnabled: true,
    })
  })

  it('exige la cadena de conexion cuando el driver es mongo', () => {
    expect(() => loadConfig({ PERSISTENCE_DRIVER: 'mongo' })).toThrow(/MONGODB_URI es obligatorio/)
  })

  it('acepta una configuracion mongo completa', () => {
    expect(
      loadConfig({ PERSISTENCE_DRIVER: 'mongo', MONGODB_URI: 'mongodb://localhost:27017/catalog' })
        .persistenceDriver,
    ).toBe('mongo')
  })

  it('deshabilita la documentacion interactiva en produccion por defecto', () => {
    // Produccion exige autenticacion configurada: `loadConfig` se niega a
    // arrancar sin ella. Se aporta aqui porque el objeto de esta prueba es la
    // documentacion interactiva, no la autenticacion.
    expect(
      loadConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'jwt',
        COGNITO_USER_POOL_ID: 'us-east-1_abc',
        COGNITO_CLIENT_ID: 'cliente',
      }).swaggerEnabled,
    ).toBe(false)
  })

  it('trata una variable vacia como ausente', () => {
    expect(loadConfig({ LOG_LEVEL: '', PORT: '' })).toMatchObject({ logLevel: 'info', port: 3003 })
  })

  it.each([
    ['un valor fuera del catalogo', { LOG_LEVEL: 'verbose' }],
    ['un entero mal formado', { PORT: 'abc' }],
    ['un puerto fuera de rango', { PORT: '99999' }],
    ['un booleano invalido', { SWAGGER_ENABLED: 'si' }],
  ])('rechaza %s', (_caso, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigurationError)
  })
})

describe('observabilidad, salud y utilidades', () => {
  it('el registro es JSON estructurado y respeta el umbral', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'warn',
      service: 'catalog',
      version: '0.1.0',
      sink: (line) => lines.push(line),
      clock: () => FIXED_NOW,
    })

    logger.debug('no')
    logger.info('no')
    logger.warn('si', { sku: 'espada' })
    logger.error('si')

    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ level: 'warn', sku: 'espada' })
  })

  it('admite registros sin contexto en todos los niveles', () => {
    const lines: string[] = []
    const logger = createLogger({
      level: 'debug',
      service: 'catalog',
      version: '0.1.0',
      sink: (line) => lines.push(line),
    })

    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('d')

    expect(lines).toHaveLength(4)
  })

  it('las sondas distinguen exito, fallo y excepcion', async () => {
    expect(buildLiveness()).toEqual({ status: 'ok', checks: {} })
    await expect(
      buildReadiness([{ name: 'repo', check: (): Promise<boolean> => Promise.resolve(true) }]),
    ).resolves.toMatchObject({ status: 'ok' })
    await expect(
      buildReadiness([{ name: 'repo', check: (): Promise<boolean> => Promise.resolve(false) }]),
    ).resolves.toMatchObject({ status: 'error' })
    await expect(
      buildReadiness([
        {
          name: 'repo',
          check: (): boolean => {
            throw new Error('sin conexion')
          },
        },
      ]),
    ).resolves.toEqual({ status: 'error', checks: { repo: 'error' } })
    expect(buildVersion({ service: 'a', version: 'b', nodeEnv: 'c' })).toEqual({
      service: 'a',
      version: 'b',
      nodeEnv: 'c',
    })
  })

  it('el reloj y el generador de identificadores funcionan', () => {
    expect(new SystemClock().now().getTime()).toBeGreaterThan(0)
    expect(new UuidGenerator().generate()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})
