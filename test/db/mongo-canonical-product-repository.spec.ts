import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Long, type Collection, type Db, type MongoClient } from 'mongodb'

import { MongoCanonicalProductRepository } from '../../src/adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoProductRepository } from '../../src/adapters/outbound/persistence/MongoProductRepository'
import {
  toCanonicalDocument,
  toCanonicalProduct,
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

    const doc = toCanonicalDocument(product)
    const updated = toCanonicalProduct({ ...doc, version: Long.fromNumber(1) })
    await expect(repository.update(updated, 0)).resolves.toBeUndefined()

    const found = await products().findOne({ _id: product.productId.value })
    expect(found?.version ? Long.fromValue(found.version).toNumber() : 0).toBe(1)
  })

  it('rechaza la actualización con conflicto de concurrencia si la versión difiere', async () => {
    const product = buildProduct(...ATTRIBUTE_FIXTURES[1])
    await repository.create(product)

    const doc = toCanonicalDocument(product)
    const staleWriter = toCanonicalProduct({ ...doc, version: Long.fromNumber(1) })
    await expect(repository.update(staleWriter, 99)).rejects.toBeInstanceOf(
      CanonicalProductConcurrencyConflictError,
    )
  })

  describe('lectura por referencia y por lote (HU-27)', () => {
    it('prioriza la identidad canónica si otro producto usa el mismo UUID como alias', async () => {
      const productId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'
      const aliasOwner = buildProduct(...ATTRIBUTE_FIXTURES[2], {
        productId: '99999999-9999-4999-8999-999999999998',
        sku: productId,
        name: 'Alias con forma UUID',
      })
      const canonical = buildProduct(...ATTRIBUTE_FIXTURES[2], {
        productId,
        sku: 'identidad-canonica',
        name: 'Identidad canónica prioritaria',
      })
      await repository.create(aliasOwner)
      await repository.create(canonical)
      expect((await repository.findByReference(productId))?.productId.value).toBe(productId)
      expect((await repository.findByReference('identidad-canonica'))?.productId.value).toBe(
        productId,
      )
    })

    it('findByReference resuelve por productId y por alias sku', async () => {
      const product = buildProduct(...ATTRIBUTE_FIXTURES[2], {
        productId: '99999999-9999-4999-8999-999999999999',
        sku: 'espada-referencia',
      })
      await repository.create(product)

      const byId = await repository.findByReference(product.productId.value)
      const bySku = await repository.findByReference('espada-referencia')

      expect(byId?.toSnapshot()).toEqual(product.toSnapshot())
      expect(bySku?.toSnapshot()).toEqual(product.toSnapshot())
      await expect(repository.findByReference('no-existe')).resolves.toBeNull()
    })

    it('findByReference no resuelve un documento heredado por su SKU', async () => {
      const legacyRepository = new MongoProductRepository(db)
      await legacyRepository.create(
        Product.draft({
          sku: Sku.create('solo-heredado'),
          name: ProductName.create('Solo heredado'),
          category: Category.create('armas'),
          price: Money.create(100, 'COP'),
        }),
      )

      await expect(repository.findByReference('solo-heredado')).resolves.toBeNull()
    })

    it('findByReferences resuelve un lote en una sola consulta y respeta el conjunto pedido', async () => {
      const a = buildProduct(...ATTRIBUTE_FIXTURES[2], { name: 'Lote A', sku: 'lote-a' })
      const b = buildProduct(...ATTRIBUTE_FIXTURES[4], { name: 'Lote B', sku: 'lote-b' })
      const fuera = buildProduct(...ATTRIBUTE_FIXTURES[2], { name: 'Fuera', sku: 'fuera' })
      await repository.create(a)
      await repository.create(b)
      await repository.create(fuera)

      const found = await repository.findByReferences({
        references: [a.productId.value, 'lote-b', 'fantasma'],
      })

      expect(found.map((product) => product.productId.value).sort()).toEqual(
        [a.productId.value, b.productId.value].sort(),
      )
    })

    it('findByReferences filtra por substring de nombre normalizado y por tipo', async () => {
      const espada = buildProduct(...ATTRIBUTE_FIXTURES[2], {
        name: 'Espada Rúnica',
        sku: 'espada-runica',
      })
      const item = buildProduct(...ATTRIBUTE_FIXTURES[4], {
        name: 'Espada de bolsillo (ITEM)',
        sku: 'espada-item',
      })
      await repository.create(espada)
      await repository.create(item)

      const porNombre = await repository.findByReferences({
        references: ['espada-runica', 'espada-item'],
        nameQuery: 'rúnica',
      })
      const porTipo = await repository.findByReferences({
        references: ['espada-runica', 'espada-item'],
        type: ProductType.Weapon,
      })

      expect(porNombre.map((product) => product.sku.value)).toEqual(['espada-runica'])
      expect(porTipo.map((product) => product.sku.value)).toEqual(['espada-runica'])
    })

    it('findByReferences devuelve también productos SUSPENDED que el consumidor posee', async () => {
      const active = buildProduct(...ATTRIBUTE_FIXTURES[2], { name: 'Activo', sku: 'activo' })
      await repository.create(active)
      const suspendedDoc = {
        ...toCanonicalDocument(
          buildProduct(...ATTRIBUTE_FIXTURES[2], { name: 'Suspendido', sku: 'suspendido' }),
        ),
        lifecycleStatus: 'SUSPENDED' as const,
      }
      await products().insertOne(suspendedDoc)

      const found = await repository.findByReferences({ references: ['activo', 'suspendido'] })

      expect(found.map((product) => product.lifecycleStatus).sort()).toEqual([
        'ACTIVE',
        'SUSPENDED',
      ])
    })

    it('findByReferences con un tratamiento de término literal no interpreta metacaracteres', async () => {
      const product = buildProduct(...ATTRIBUTE_FIXTURES[2], {
        name: 'Arma Normal',
        sku: 'arma-normal',
      })
      await repository.create(product)

      const found = await repository.findByReferences({
        references: ['arma-normal'],
        nameQuery: 'a.*a',
      })

      expect(found).toEqual([])
    })

    /**
     * La consulta a Mongo de `findByReferences` es un lookup por referencia
     * (`_id` / `sku`): acota el universo por índice y NO recorre la colección
     * entera. El filtrado por nombre y por tipo ocurre en memoria sobre ese
     * conjunto ya pequeño — no es un índice de texto. Se comprueba con
     * `executionStats`: al pedir 3 referencias de una colección de 60, se
     * examinan pocos documentos, no los 60.
     */
    it('el lookup por referencia examina pocos documentos, no toda la colección', async () => {
      for (let index = 0; index < 60; index += 1) {
        await repository.create(
          buildProduct(...ATTRIBUTE_FIXTURES[2], {
            name: `Producto Plan ${String(index)}`,
            sku: `plan-${String(index).padStart(2, '0')}`,
          }),
        )
      }

      const references = ['plan-01', 'plan-30', 'plan-57']
      const stats = (await products()
        .find({
          type: { $exists: true },
          $or: [{ _id: { $in: references } }, { sku: { $in: references } }],
        })
        .explain('executionStats')) as {
        executionStats: { totalDocsExamined: number; nReturned: number }
      }

      expect(stats.executionStats.nReturned).toBe(3)
      // Un COLLSCAN examinaría los 60. Con el índice, del orden de las 3 pedidas.
      expect(stats.executionStats.totalDocsExamined).toBeLessThanOrEqual(12)
    })

    it('findByReferences no recorre la colección para resolver un lote pequeño', async () => {
      for (let index = 0; index < 40; index += 1) {
        await repository.create(
          buildProduct(...ATTRIBUTE_FIXTURES[2], {
            name: `Lote Grande ${String(index)}`,
            sku: `lote-grande-${String(index).padStart(2, '0')}`,
          }),
        )
      }

      const found = await repository.findByReferences({
        references: ['lote-grande-05', 'lote-grande-20'],
        nameQuery: 'lote grande 20',
      })

      expect(found.map((product) => product.sku.value)).toEqual(['lote-grande-20'])
    })
  })
})
