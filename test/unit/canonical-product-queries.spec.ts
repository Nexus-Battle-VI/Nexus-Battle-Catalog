import {
  GetCanonicalProduct,
  LookupCanonicalProducts,
} from '../../src/application/use-cases/CanonicalProductQueries'
import { CanonicalProductNotFoundError } from '../../src/application/errors/ApplicationError'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import {
  CreditsPrice,
  LifecycleStatus,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  ProductType,
} from '../../src/domain/value-objects/canonical-product-values'
import { ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import { DomainError } from '../../src/domain/errors/DomainError'

const damage = (): object => ({
  kind: 'DAMAGE',
  target: 'OPPONENT',
  magnitude: { mode: 'FIXED', amount: 5 },
})

const WEAPON_VALUES = {
  kind: 'ARMA',
  compatibilityScope: 'ALL_HEROES',
  effects: [damage()],
} as const

const ITEM_VALUES = {
  kind: 'ITEM',
  compatibilityScope: 'ALL_HEROES',
  effects: [{ kind: 'HEALING', target: 'SELF', magnitude: { mode: 'FIXED', amount: 3 } }],
} as const

let sequence = 0

const buildProduct = (params: {
  readonly name: string
  readonly type?: ProductType
  readonly values?: object
  readonly lifecycleStatus?: LifecycleStatus
  readonly productId?: string
  readonly sku?: string
}): CanonicalProduct => {
  sequence += 1
  const type = params.type ?? ProductType.Weapon
  const values = params.values ?? WEAPON_VALUES
  const productId = ProductId.create(
    params.productId ?? `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence).padStart(12, '0')}`,
  )
  const sku = Sku.create(params.sku ?? `producto-${String(sequence)}`)
  const base = {
    productId,
    sku,
    name: ProductName.create(params.name),
    imageUrl: ProductImageUrl.create(`https://assets.example.test/p-${String(sequence)}.png`),
    description: ProductDescription.create('Producto canónico para pruebas de lectura.'),
    type,
    attributes: parseProductAttributes({ schemaVersion: '1', values }, type),
    printRun: PrintRun.create(-1),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(10),
      premium: false,
      realMoneyPrice: null,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  }

  if (params.lifecycleStatus === LifecycleStatus.Suspended) {
    return CanonicalProduct.restore({
      ...base,
      lifecycleStatus: LifecycleStatus.Suspended,
      updatedAt: base.createdAt,
      version: 0,
    })
  }

  return CanonicalProduct.create(base)
}

const seed = async (
  repo: InMemoryCanonicalProductRepository,
  product: CanonicalProduct,
): Promise<CanonicalProduct> => {
  await repo.create(product)
  return product
}

describe('GetCanonicalProduct', () => {
  it('resuelve por productId', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const product = await seed(repo, buildProduct({ name: 'Espada de Fuego' }))

    const dto = await new GetCanonicalProduct(repo).execute(product.productId.value)

    expect(dto).toMatchObject({
      productId: product.productId.value,
      sku: product.sku.value,
      name: 'Espada de Fuego',
      type: ProductType.Weapon,
      lifecycleStatus: LifecycleStatus.Active,
    })
  })

  it('resuelve por el alias sku', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const product = await seed(repo, buildProduct({ name: 'Escudo', sku: 'escudo-de-dragon' }))

    const dto = await new GetCanonicalProduct(repo).execute('  escudo-de-dragon  ')

    expect(dto.productId).toBe(product.productId.value)
  })

  it('devuelve también un producto SUSPENDED, con su lifecycleStatus', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const product = await seed(
      repo,
      buildProduct({ name: 'Reliquia Retirada', lifecycleStatus: LifecycleStatus.Suspended }),
    )

    const dto = await new GetCanonicalProduct(repo).execute(product.productId.value)

    expect(dto.lifecycleStatus).toBe(LifecycleStatus.Suspended)
  })

  it('lanza CanonicalProductNotFoundError cuando la referencia no existe', async () => {
    const repo = new InMemoryCanonicalProductRepository()

    await expect(new GetCanonicalProduct(repo).execute('no-existe')).rejects.toBeInstanceOf(
      CanonicalProductNotFoundError,
    )
  })
})

describe('LookupCanonicalProducts', () => {
  it('devuelve lista vacía cuando no se pasan referencias', async () => {
    const repo = new InMemoryCanonicalProductRepository()

    await expect(new LookupCanonicalProducts(repo).execute({ references: [] })).resolves.toEqual({
      items: [],
    })
  })

  it('resuelve varias referencias mezclando productId y sku, y omite las inexistentes', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const a = await seed(repo, buildProduct({ name: 'Alfa', sku: 'alfa' }))
    const b = await seed(repo, buildProduct({ name: 'Beta', sku: 'beta' }))

    const result = await new LookupCanonicalProducts(repo).execute({
      references: [a.productId.value, 'beta', 'fantasma', a.productId.value],
    })

    expect(result.items.map((item) => item.productId).sort()).toEqual(
      [a.productId.value, b.productId.value].sort(),
    )
  })

  it('filtra por substring del nombre normalizado', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const espada = await seed(repo, buildProduct({ name: 'Espada Larga', sku: 'espada-larga' }))
    await seed(repo, buildProduct({ name: 'Escudo Torre', sku: 'escudo-torre' }))

    const result = await new LookupCanonicalProducts(repo).execute({
      references: ['espada-larga', 'escudo-torre'],
      query: 'ESPADA',
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.productId).toBe(espada.productId.value)
  })

  it('filtra por tipo canónico', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    const arma = await seed(repo, buildProduct({ name: 'Arma X', sku: 'arma-x' }))
    await seed(
      repo,
      buildProduct({ name: 'Item Y', sku: 'item-y', type: ProductType.Item, values: ITEM_VALUES }),
    )

    const result = await new LookupCanonicalProducts(repo).execute({
      references: ['arma-x', 'item-y'],
      type: 'ARMA',
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.productId).toBe(arma.productId.value)
  })

  it('rechaza un tipo desconocido como error de dominio', async () => {
    const repo = new InMemoryCanonicalProductRepository()

    await expect(
      new LookupCanonicalProducts(repo).execute({ references: ['x'], type: 'LEGENDARIO' }),
    ).rejects.toBeInstanceOf(DomainError)
  })

  it('nunca devuelve un producto fuera del conjunto de referencias pedido', async () => {
    const repo = new InMemoryCanonicalProductRepository()
    await seed(repo, buildProduct({ name: 'Dentro', sku: 'dentro' }))
    const fuera = await seed(repo, buildProduct({ name: 'Fuera', sku: 'fuera' }))

    const result = await new LookupCanonicalProducts(repo).execute({ references: ['dentro'] })

    expect(result.items.map((item) => item.productId)).not.toContain(fuera.productId.value)
  })
})
