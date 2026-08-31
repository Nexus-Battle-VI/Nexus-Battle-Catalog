import { toProductRef } from '../../src/application/dto/ProductRef'
import { ProductIdFactory } from '../../src/application/services/ProductIdFactory'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  CreditsPrice,
  LifecycleStatus,
  parseProductType,
  PrintRun,
  PrintRunMode,
  ProductId,
  ProductPricing,
  ProductType,
  projectFunctionalStatus,
} from '../../src/domain/value-objects/canonical-product-values'
import { Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'

const PRODUCT_ID = '3f6af5b5-5f43-4dd8-93cb-e8e73355ae42'

describe('ProductId', () => {
  it('normaliza y compara UUID validos', () => {
    const productId = ProductId.create(`  ${PRODUCT_ID.toUpperCase()}  `)

    expect(productId.value).toBe(PRODUCT_ID)
    expect(String(productId)).toBe(PRODUCT_ID)
    expect(productId.equals(ProductId.create(PRODUCT_ID))).toBe(true)
    expect(productId.equals(ProductId.create('f1597d52-a493-4cad-95d1-48a0f788f38f'))).toBe(false)
  })

  it.each([
    '',
    'producto-1',
    '3f6af5b5-5f43-0dd8-93cb-e8e73355ae42',
    '3f6af5b5-5f43-4dd8-03cb-e8e73355ae42',
  ])('rechaza un identificador que no cumple el contrato UUID: %s', (raw) => {
    expect(() => ProductId.create(raw)).toThrow(DomainError)
  })

  it('se genera mediante IdGeneratorPort fuera del dominio', () => {
    const generate = jest.fn(() => PRODUCT_ID)
    const generator: IdGeneratorPort = { generate }

    const generated = new ProductIdFactory(generator).create()

    expect(generated.value).toBe(PRODUCT_ID)
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('rechaza la salida invalida de un generador', () => {
    const generator: IdGeneratorPort = { generate: () => 'no-es-uuid' }

    expect(() => new ProductIdFactory(generator).create()).toThrow(DomainError)
  })
})

describe('ProductType', () => {
  it.each(Object.values(ProductType))('admite el tipo cerrado %s', (type) => {
    expect(parseProductType(` ${type} `)).toBe(type)
  })

  it.each(['arma', 'CONSUMIBLE', '', 'HEROE_EXTRA'])('rechaza el tipo %s', (raw) => {
    expect(() => parseProductType(raw)).toThrow(DomainError)
  })
})

describe('PrintRun', () => {
  it.each([
    [-1, PrintRunMode.Infinite, true],
    [1, PrintRunMode.Unique, false],
    [2, PrintRunMode.Limited, false],
    [150, PrintRunMode.Limited, false],
  ] as const)('deriva %s como %s', (value, mode, infinite) => {
    const printRun = PrintRun.create(value)

    expect(printRun.value).toBe(value)
    expect(printRun.mode).toBe(mode)
    expect(printRun.isInfinite).toBe(infinite)
    expect(String(printRun)).toBe(String(value))
  })

  it.each([-2, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rechaza el tiraje %s', (value) => {
    expect(() => PrintRun.create(value)).toThrow(DomainError)
  })

  it('compara por valor', () => {
    expect(PrintRun.create(10).equals(PrintRun.create(10))).toBe(true)
    expect(PrintRun.create(10).equals(PrintRun.create(20))).toBe(false)
  })

  it.each([
    [LifecycleStatus.Suspended, PrintRunMode.Unique, 'suspendido'],
    [LifecycleStatus.Suspended, PrintRunMode.Infinite, 'suspendido'],
    [LifecycleStatus.Active, PrintRunMode.Unique, 'único'],
    [LifecycleStatus.Active, PrintRunMode.Limited, 'activo'],
    [LifecycleStatus.Active, PrintRunMode.Infinite, 'activo'],
  ] as const)('proyecta %s + %s como %s', (lifecycle, mode, expected) => {
    expect(projectFunctionalStatus(lifecycle, mode)).toBe(expected)
  })
})

describe('CreditsPrice y ProductPricing', () => {
  it.each([0, 1, 40])('acepta %s creditos', (value) => {
    const price = CreditsPrice.create(value)

    expect(price.value).toBe(value)
    expect(String(price)).toBe(String(value))
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rechaza el precio en creditos %s',
    (value) => {
      expect(() => CreditsPrice.create(value)).toThrow(DomainError)
    },
  )

  it('compara el precio en creditos por valor', () => {
    expect(CreditsPrice.create(40).equals(CreditsPrice.create(40))).toBe(true)
    expect(CreditsPrice.create(40).equals(CreditsPrice.create(41))).toBe(false)
  })

  it('admite un producto no premium sin precio real', () => {
    const pricing = ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium: false,
      realMoneyPrice: null,
    })

    expect(pricing.premium).toBe(false)
    expect(pricing.realMoneyPrice).toBeNull()
    expect(pricing.creditsPrice.value).toBe(0)
  })

  it('admite un producto premium con precio real positivo', () => {
    const pricing = ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium: true,
      realMoneyPrice: Money.create(999, 'USD'),
    })

    expect(pricing.premium).toBe(true)
    expect(pricing.realMoneyPrice?.amount).toBe(999)
    expect(pricing.realMoneyPrice?.currency).toBe('USD')
  })

  it('rechaza un producto premium sin precio real positivo', () => {
    expect(() =>
      ProductPricing.create({
        creditsPrice: CreditsPrice.create(0),
        premium: true,
        realMoneyPrice: null,
      }),
    ).toThrow(/premium requiere/)

    expect(() =>
      ProductPricing.create({
        creditsPrice: CreditsPrice.create(0),
        premium: true,
        realMoneyPrice: Money.zero('USD'),
      }),
    ).toThrow(/premium requiere/)
  })

  it('rechaza precio real en un producto no premium', () => {
    expect(() =>
      ProductPricing.create({
        creditsPrice: CreditsPrice.create(20),
        premium: false,
        realMoneyPrice: Money.create(999, 'USD'),
      }),
    ).toThrow(/no premium/)
  })
})

describe('ProductRef', () => {
  it('proyecta identidad canonica y alias obligatorio durante la transicion', () => {
    expect(
      toProductRef({
        productId: ProductId.create(PRODUCT_ID),
        sku: Sku.create('espada-de-fuego'),
      }),
    ).toEqual({ productId: PRODUCT_ID, sku: 'espada-de-fuego' })
  })

  it('incluye datos descriptivos solo cuando la proyeccion los necesita', () => {
    expect(
      toProductRef({
        productId: ProductId.create(PRODUCT_ID),
        sku: Sku.create('espada-de-fuego'),
        name: ProductName.create('Espada de Fuego'),
        type: ProductType.Weapon,
      }),
    ).toEqual({
      productId: PRODUCT_ID,
      sku: 'espada-de-fuego',
      name: 'Espada de Fuego',
      type: ProductType.Weapon,
    })
  })
})
