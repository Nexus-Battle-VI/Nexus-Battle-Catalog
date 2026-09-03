import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Collection, Db, MongoClient } from 'mongodb'

import { MongoCanonicalProductRepository } from '../../src/adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoProductRepository } from '../../src/adapters/outbound/persistence/MongoProductRepository'
import {
  toCanonicalDocument,
  toCanonicalSnapshot,
  type CanonicalProductDocument,
} from '../../src/adapters/outbound/persistence/canonical-mapping'
import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
} from '../../src/application/errors/ApplicationError'
import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import { Product } from '../../src/domain/entities/Product'
import {
  CreditsPrice,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  ProductType,
} from '../../src/domain/value-objects/canonical-product-values'
import { Category, Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import { closeMongoTestResources } from '../support/mongo-test-resources'

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const

const fixed = (amount = 2): object => ({ mode: 'FIXED', amount })
const dice = (): object => ({ mode: 'DICE', count: 2, sides: 6 })
const damage = (): object => ({ kind: 'DAMAGE', target: 'OPPONENT', magnitude: dice() })

const ATTRIBUTE_FIXTURES = [
  [
    ProductType.Hero,
    {
      kind: 'HEROE',
      heroSubtype: 'GUERRERO_ARMAS',
      basePower: 3,
      baseHealth: 10,
      baseDefense: 2,
      baseAttack: fixed(),
      baseDamage: dice(),
      abilities: IDS,
    },
  ],
  [
    ProductType.Ability,
    {
      kind: 'HABILIDAD',
      compatibleHeroSubtypes: ['MAGO_FUEGO'],
      powerCostMode: 'FIXED',
      powerCost: 2,
      effects: [damage()],
    },
  ],
  [
    ProductType.Weapon,
    {
      kind: 'ARMA',
      compatibilityScope: 'ALL_HEROES',
      effects: [damage()],
      setCode: 'SET_FUEGO',
    },
  ],
  [
    ProductType.Armor,
    {
      kind: 'ARMADURA',
      compatibilityScope: 'SELECTED_SUBTYPES',
      compatibleHeroSubtypes: ['CHAMAN'],
      slot: 'CHEST',
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          magnitude: fixed(),
        },
      ],
    },
  ],
  [
    ProductType.Item,
    {
      kind: 'ITEM',
      compatibilityScope: 'ALL_HEROES',
      effects: [{ kind: 'HEALING', target: 'SELF', magnitude: fixed(5) }],
    },
  ],
  [
    ProductType.Epic,
    {
      kind: 'EPICA',
      compatibleHeroSubtype: 'MEDICO',
      generalEffect: { kind: 'HEALING', target: 'ALLIED_GROUP', magnitude: fixed(3) },
      specificEffect: { kind: 'HEALING', target: 'ALLY', magnitude: fixed(8) },
    },
  ],
] as const

describe('MongoCanonicalProductRepository', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db
  let repository: MongoCanonicalProductRepository
  let sequence = 0

  const products = (): Collection<CanonicalProductDocument> =>
    db.collection<CanonicalProductDocument>('products')

  const buildProduct = (
    type: ProductType,
    values: object,
    overrides: {
      readonly productId?: string
      readonly sku?: string
      readonly name?: string
      readonly premium?: boolean
    } = {},
  ): CanonicalProduct => {
    sequence += 1
    const suffix = String(sequence).padStart(12, '0')

    return CanonicalProduct.create({
      productId: ProductId.create(overrides.productId ?? `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`),
      sku: Sku.create(overrides.sku ?? `producto-canonico-${String(sequence)}`),
      name: ProductName.create(overrides.name ?? `Producto canónico ${String(sequence)}`),
      imageUrl: ProductImageUrl.create(
        `https://assets.example.test/producto-${String(sequence)}.png`,
      ),
      description: ProductDescription.create('Producto canónico para prueba de persistencia.'),
      type,
      attributes: parseProductAttributes({ schemaVersion: '1', values }, type),
      printRun: PrintRun.create(sequence % 2 === 0 ? -1 : 1),
      pricing: ProductPricing.create({
        creditsPrice: CreditsPrice.create(sequence),
        premium: overrides.premium ?? false,
        realMoneyPrice: overrides.premium === true ? Money.create(999, 'USD') : null,
      }),
      createdAt: new Date('2026-08-31T20:00:00.000Z'),
    })
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  beforeEach(async () => {
    repository = new MongoCanonicalProductRepository(db)
    await products().deleteMany({})
  })

  it.each(ATTRIBUTE_FIXTURES)(
    'persiste y recupera sin pérdida un producto %s',
    async (type, values) => {
      const product = buildProduct(type, values)

      await repository.create(product)
      const document = await products().findOne({ _id: product.productId.value })
      const restored = await repository.findById(product.productId)

      expect(document).not.toBeNull()
      expect(toCanonicalSnapshot(document!)).toEqual(product.toSnapshot())
      expect(restored?.toSnapshot()).toEqual(product.toSnapshot())
      expect(await products().countDocuments({ _id: product.productId.value })).toBe(1)
    },
  )

  it('consulta el tipo por productId sin exponer el documento', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[1])
    await repository.create(product)

    await expect(repository.findTypeById(product.productId)).resolves.toBe(ProductType.Ability)
    await expect(
      repository.findTypeById(ProductId.create('ffffffff-ffff-4fff-8fff-ffffffffffff')),
    ).resolves.toBeNull()
    await expect(
      repository.findById(ProductId.create('ffffffff-ffff-4fff-8fff-ffffffffffff')),
    ).resolves.toBeNull()
  })

  it('consulta unicidad solo para nombre normalizado, tipo y estado activo', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[2])
    await repository.create(product)

    await expect(
      repository.existsByNormalizedNameAndType(product.normalizedName, product.type),
    ).resolves.toBe(true)
    await expect(
      repository.existsByNormalizedNameAndType('nombre libre', product.type),
    ).resolves.toBe(false)
  })

  it('no filtra documentos canónicos hacia las búsquedas del repositorio heredado', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[2])
    await repository.create(product)

    const legacyRepository = new MongoProductRepository(db)

    await expect(legacyRepository.search({ includeHidden: true })).resolves.toEqual([])
  })

  it('impone la unicidad de SKU entre documentos heredados y canónicos', async () => {
    const legacyRepository = new MongoProductRepository(db)
    const legacy = Product.draft({
      sku: Sku.create('alias-compartido'),
      name: ProductName.create('Producto heredado'),
      category: Category.create('armas'),
      price: Money.create(100, 'COP'),
    })
    await expect(legacyRepository.create(legacy)).resolves.toBe(true)

    const canonical = buildProduct(...ATTRIBUTE_FIXTURES[2], { sku: 'alias-compartido' })
    await expect(repository.create(canonical)).rejects.toBeInstanceOf(
      CanonicalProductSkuAlreadyExistsError,
    )

    const canonicalFirst = buildProduct(...ATTRIBUTE_FIXTURES[2], { sku: 'alias-canonico' })
    await repository.create(canonicalFirst)
    const collidingLegacy = Product.draft({
      sku: Sku.create('alias-canonico'),
      name: ProductName.create('Segundo producto heredado'),
      category: Category.create('armas'),
      price: Money.create(100, 'COP'),
    })

    await expect(legacyRepository.create(collidingLegacy)).resolves.toBe(false)
  })

  it('resuelve una única escritura concurrente para nombre normalizado y tipo', async () => {
    const first = buildProduct(...ATTRIBUTE_FIXTURES[2], { name: 'Arma Concurrente' })
    const second = buildProduct(...ATTRIBUTE_FIXTURES[2], { name: '  ARMA   concurrente  ' })

    const results = await Promise.allSettled([repository.create(first), repository.create(second)])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    const rejection = results.find(({ status }) => status === 'rejected')
    expect(rejection).toMatchObject({ reason: expect.any(CanonicalProductAlreadyExistsError) })
    expect(
      await products().countDocuments({
        normalizedName: 'arma concurrente',
        type: ProductType.Weapon,
      }),
    ).toBe(1)
  })

  it('traduce una colisión de SKU a un error estable', async () => {
    const first = buildProduct(...ATTRIBUTE_FIXTURES[4], { sku: 'alias-ocupado' })
    const second = buildProduct(...ATTRIBUTE_FIXTURES[4], { sku: 'alias-ocupado' })

    await repository.create(first)

    await expect(repository.create(second)).rejects.toBeInstanceOf(
      CanonicalProductSkuAlreadyExistsError,
    )
  })

  it('traduce una colisión de productId a un error estable', async () => {
    const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const first = buildProduct(...ATTRIBUTE_FIXTURES[4], { productId })
    const second = buildProduct(...ATTRIBUTE_FIXTURES[4], { productId })

    await repository.create(first)

    await expect(repository.create(second)).rejects.toBeInstanceOf(
      CanonicalProductIdentityAlreadyExistsError,
    )
  })

  it('crea los índices únicos requeridos por el contrato canónico', async () => {
    const indexes = await products().indexes()

    expect(indexes).toEqual(
      expect.arrayContaining([
        // `_id` siempre es único por definición del motor; MongoDB no repite
        // esa propiedad como `unique: true` al describir el índice incorporado.
        expect.objectContaining({ name: '_id_', key: { _id: 1 } }),
        expect.objectContaining({ name: 'uniq_products_sku', unique: true }),
        expect.objectContaining({ name: 'uniq_active_product_name_type', unique: true }),
      ]),
    )
  })

  it('persiste créditos y precio real como long y no produce auditoría ni eventos laterales', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[5], { premium: true })
    await repository.create(product)

    expect(
      await products().countDocuments({
        _id: product.productId.value,
        creditsPrice: { $type: 'long' },
        'realMoneyPrice.amount': { $type: 'long' },
      }),
    ).toBe(1)

    const collectionNames = (await db.listCollections().toArray()).map(({ name }) => name)
    expect(collectionNames).not.toEqual(
      expect.arrayContaining(['audit', 'audits', 'outbox', 'events', 'pending_events']),
    )
  })

  it('el motor rechaza documentos canónicos parciales o con campos laterales', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[2])
    const document = {
      ...toCanonicalDocument(product),
      description: undefined,
      campoLateral: 'no permitido',
    } as unknown as CanonicalProductDocument

    await expect(products().insertOne(document)).rejects.toThrow()
    expect(await products().countDocuments({ _id: product.productId.value })).toBe(0)
  })

  it('actualiza un producto cuando la versión esperada coincide', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[0])
    await repository.create(product)

    const updated = CanonicalProduct.restore({
      ...toCanonicalSnapshot(product),
      version: 1,
    })
    await expect(repository.update(updated, 0)).resolves.toBeUndefined()

    const found = await products().findOne({ _id: product.productId.value })
    expect(found?.version.toNumber()).toBe(1)
  })

  it('rechaza la actualización con conflicto de concurrencia si la versión difiere', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[1])
    await repository.create(product)

    const staleWriter = CanonicalProduct.restore({
      ...toCanonicalSnapshot(product),
      version: 1,
    })
    await expect(repository.update(staleWriter, 99)).rejects.toBeInstanceOf(
      CanonicalProductConcurrencyConflictError,
    )
  })
})
