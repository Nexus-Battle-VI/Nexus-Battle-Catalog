import { Product, ProductStatus } from '../../src/domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { DomainError } from '../../src/domain/errors/DomainError'

const AT = new Date('2026-08-21T10:00:00.000Z')

const cop = (amount: number): Money => Money.create(amount, 'COP')

const draft = (): Product =>
  Product.draft({
    sku: Sku.create('espada-de-hierro'),
    name: ProductName.create('Espada de hierro'),
    category: Category.create('armas'),
    price: cop(15_000),
  })

const published = (): Product => {
  const product = draft()
  product.publish(AT)
  product.pullEvents()

  return product
}

describe('Sku, ProductName y Category', () => {
  it('normalizan a kebab-case en minusculas', () => {
    expect(Sku.create('  Espada-De-Hierro ').value).toBe('espada-de-hierro')
    expect(Category.create('  ARMAS ').value).toBe('armas')
    expect(String(Sku.create('pocion'))).toBe('pocion')
    expect(String(Category.create('consumibles'))).toBe('consumibles')
  })

  it('comparan por valor', () => {
    expect(Sku.create('a-b').equals(Sku.create('A-B'))).toBe(true)
    expect(Sku.create('a-b').equals(Sku.create('c-d'))).toBe(false)
    expect(Category.create('armas').equals(Category.create('armas'))).toBe(true)
    expect(Category.create('armas').equals(Category.create('pociones'))).toBe(false)
  })

  it.each([['snake_case'], ['-inicia'], ['termina-'], [''], ['1-numero']])(
    'rechazan la referencia "%s"',
    (raw) => {
      expect(() => Sku.create(raw)).toThrow(DomainError)
      expect(() => Category.create(raw)).toThrow(DomainError)
    },
  )

  it('el nombre colapsa espacios internos y compara por valor', () => {
    const name = ProductName.create('  Espada   de   hierro ')

    expect(name.value).toBe('Espada de hierro')
    expect(String(name)).toBe('Espada de hierro')
    expect(name.equals(ProductName.create('Espada de hierro'))).toBe(true)
    expect(name.equals(ProductName.create('Escudo'))).toBe(false)
  })

  it.each([['Ab'], ['x'.repeat(81)]])('rechaza el nombre "%s"', (raw) => {
    expect(() => ProductName.create(raw)).toThrow(DomainError)
  })
})

describe('Money', () => {
  it('acepta importes enteros en monedas soportadas', () => {
    const price = Money.create(15_000, ' cop ')

    expect(price.amount).toBe(15_000)
    expect(price.currency).toBe('COP')
    expect(String(price)).toBe('15000 COP')
  })

  it('construye el importe cero', () => {
    expect(Money.zero('USD').isZero()).toBe(true)
    expect(cop(1).isZero()).toBe(false)
  })

  it('suma importes de la misma moneda', () => {
    expect(cop(1_000).plus(cop(500)).amount).toBe(1_500)
  })

  it('rechaza sumar monedas distintas', () => {
    expect(() => cop(1_000).plus(Money.create(500, 'USD'))).toThrow(/monedas distintas/)
  })

  it('multiplica por un factor entero', () => {
    expect(cop(1_500).times(3).amount).toBe(4_500)
    expect(cop(1_500).times(0).isZero()).toBe(true)
  })

  it('compara por importe y moneda', () => {
    expect(cop(100).equals(cop(100))).toBe(true)
    expect(cop(100).equals(cop(200))).toBe(false)
    expect(cop(100).equals(Money.create(100, 'USD'))).toBe(false)
  })

  it.each([
    ['un importe fraccionario', 1_500.5, 'COP'],
    ['un importe negativo', -1, 'COP'],
    ['una moneda no soportada', 100, 'GBP'],
  ])('rechaza %s', (_caso, amount, currency) => {
    expect(() => Money.create(amount, currency)).toThrow(DomainError)
  })

  it.each([[-1], [1.5]])('rechaza el factor %s', (factor) => {
    expect(() => cop(100).times(factor)).toThrow(DomainError)
  })
})

describe('Product', () => {
  it('nace en borrador y no es visible', () => {
    const product = draft()

    expect(product.currentStatus).toBe(ProductStatus.Draft)
    expect(product.isVisible).toBe(false)
    expect(product.isPurchasable).toBe(false)
    expect(product.currentName.value).toBe('Espada de hierro')
    expect(product.currentCategory.value).toBe('armas')
    expect(product.currentPrice.amount).toBe(15_000)
  })

  it('rechaza crearse con precio cero', () => {
    expect(() =>
      Product.draft({
        sku: Sku.create('gratis'),
        name: ProductName.create('Producto gratis'),
        category: Category.create('varios'),
        price: Money.zero('COP'),
      }),
    ).toThrow(/precio cero/)
  })

  it('al publicarse se vuelve visible y emite el evento', () => {
    const product = draft()

    product.publish(AT)

    expect(product.currentStatus).toBe(ProductStatus.Published)
    expect(product.isVisible).toBe(true)
    expect(product.isPurchasable).toBe(true)

    const events = product.pullEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'catalog.product.published',
      aggregateId: 'espada-de-hierro',
      priceAmount: 15_000,
      priceCurrency: 'COP',
    })
    expect(product.pullEvents()).toHaveLength(0)
  })

  it('rechaza publicar dos veces', () => {
    const product = published()

    expect(() => {
      product.publish(AT)
    }).toThrow(/ya esta publicado/)
  })

  it('archiva un producto y deja de ser visible sin desaparecer', () => {
    const product = published()

    product.archive(AT)

    expect(product.currentStatus).toBe(ProductStatus.Archived)
    expect(product.isVisible).toBe(false)
    expect(product.currentPrice.amount).toBe(15_000)
    expect(product.pullEvents()[0]).toMatchObject({ name: 'catalog.product.archived' })
  })

  it('rechaza archivar dos veces', () => {
    const product = published()
    product.archive(AT)

    expect(() => {
      product.archive(AT)
    }).toThrow(/ya esta archivado/)
  })

  it('rechaza publicar un producto archivado', () => {
    const product = published()
    product.archive(AT)

    expect(() => {
      product.publish(AT)
    }).toThrow(/archivado y debe restaurarse/)
  })

  it('devuelve un archivado a borrador, no a publicado', () => {
    const product = published()
    product.archive(AT)

    product.restoreToDraft()

    expect(product.currentStatus).toBe(ProductStatus.Draft)
    expect(product.isVisible).toBe(false)
  })

  it('rechaza restaurar un producto que no esta archivado', () => {
    expect(() => {
      draft().restoreToDraft()
    }).toThrow(/no esta archivado/)
  })

  it('permite renombrar y reclasificar', () => {
    const product = published()

    product.rename(ProductName.create('Espada larga'))
    product.reclassify(Category.create('armas-pesadas'))

    expect(product.currentName.value).toBe('Espada larga')
    expect(product.currentCategory.value).toBe('armas-pesadas')
    expect(product.currentStatus).toBe(ProductStatus.Published)
  })

  it('cambia el precio y emite el evento con importe anterior y nuevo', () => {
    const product = published()

    expect(product.changePrice(cop(18_000), AT)).toBe(true)
    expect(product.currentPrice.amount).toBe(18_000)
    expect(product.pullEvents()[0]).toMatchObject({
      name: 'catalog.product.price-changed',
      previousAmount: 15_000,
      newAmount: 18_000,
      currency: 'COP',
    })
  })

  it('ignora un cambio de precio al mismo importe', () => {
    const product = published()

    expect(product.changePrice(cop(15_000), AT)).toBe(false)
    expect(product.pullEvents()).toHaveLength(0)
  })

  it('rechaza cambiar el precio de un producto archivado', () => {
    const product = published()
    product.archive(AT)

    expect(() => product.changePrice(cop(20_000), AT)).toThrow(/no admite cambios de precio/)
  })

  it('rechaza fijar precio cero', () => {
    const product = published()

    expect(() => product.changePrice(Money.zero('COP'), AT)).toThrow(/precio cero/)
  })

  it('produce una instantanea consistente', () => {
    expect(draft().toSnapshot()).toEqual({
      sku: 'espada-de-hierro',
      name: 'Espada de hierro',
      category: 'armas',
      priceAmount: 15_000,
      priceCurrency: 'COP',
      status: ProductStatus.Draft,
      isPremium: false,
      realMoneyPriceAmount: null,
      realMoneyPriceCurrency: null,
    })
  })

  it('conserva precio en creditos y precio real en un producto Premium', () => {
    const product = Product.draft({
      sku: Sku.create('corona-premium'),
      name: ProductName.create('Corona premium'),
      category: Category.create('accesorios'),
      price: cop(15_000),
      isPremium: true,
      realMoneyPrice: Money.create(999, 'USD'),
    })

    expect(product.toSnapshot()).toMatchObject({
      isPremium: true,
      priceAmount: 15_000,
      priceCurrency: 'COP',
      realMoneyPriceAmount: 999,
      realMoneyPriceCurrency: 'USD',
    })
  })

  it('reconstituye un producto persistido sin emitir eventos', () => {
    const product = Product.restore({
      sku: Sku.create('pocion'),
      name: ProductName.create('Pocion de vida'),
      category: Category.create('consumibles'),
      price: cop(2_000),
      status: ProductStatus.Published,
    })

    expect(product.pullEvents()).toHaveLength(0)
    expect(product.isVisible).toBe(true)
  })
})
