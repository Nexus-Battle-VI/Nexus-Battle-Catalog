import { Long } from 'mongodb'

import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import {
  CreditsPrice,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  ProductType,
} from '../../src/domain/value-objects/canonical-product-values'
import { Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import { PersistenceMappingError } from '../../src/adapters/outbound/persistence/mapping'
import {
  toCanonicalDocument,
  toCanonicalProduct,
  toCanonicalSnapshot,
} from '../../src/adapters/outbound/persistence/canonical-mapping'

const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CREATED_AT = new Date('2026-08-31T20:00:00.000Z')

const buildProduct = (premium = false, creditsPrice = 5_000_000_000): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(PRODUCT_ID),
    sku: Sku.create('arma-canonica'),
    name: ProductName.create('Arma canónica'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/arma.png'),
    description: ProductDescription.create('Arma persistida con el contrato canónico.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(
      {
        schemaVersion: '1',
        values: {
          kind: 'ARMA',
          compatibilityScope: 'ALL_HEROES',
          effects: [
            {
              kind: 'DAMAGE',
              target: 'OPPONENT',
              magnitude: { mode: 'DICE', count: 2, sides: 6 },
            },
          ],
        },
      },
      ProductType.Weapon,
    ),
    printRun: PrintRun.create(10),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(creditsPrice),
      premium,
      realMoneyPrice: premium ? Money.create(999, 'USD') : null,
    }),
    createdAt: CREATED_AT,
  })

describe('Mapeo de persistencia canónica', () => {
  it('usa productId como _id y SKU únicamente como alias', () => {
    const document = toCanonicalDocument(buildProduct())

    expect(document._id).toBe(PRODUCT_ID)
    expect(document.sku).toBe('arma-canonica')
  })

  it('guarda precios y tiraje como enteros BSON de 64 bits', () => {
    const document = toCanonicalDocument(buildProduct(true))

    expect(document.creditsPrice).toBeInstanceOf(Long)
    expect(document.printRun).toBeInstanceOf(Long)
    expect(document.realMoneyPrice?.amount).toBeInstanceOf(Long)
  })

  it('realiza round-trip sin perder atributos derivados ni fechas', () => {
    const product = buildProduct(true)

    expect(toCanonicalSnapshot(toCanonicalDocument(product))).toEqual(product.toSnapshot())
    expect(toCanonicalProduct(toCanonicalDocument(product)).toSnapshot()).toEqual(
      product.toSnapshot(),
    )
  })

  it('rechaza un entero BSON que JavaScript no puede representar exactamente', () => {
    const document = {
      ...toCanonicalDocument(buildProduct()),
      creditsPrice: Long.fromString('9007199254740993'),
    }

    expect(() => toCanonicalSnapshot(document)).toThrow(PersistenceMappingError)
  })

  it('rechaza escribir un importe que ya excede el rango entero seguro', () => {
    expect(() => toCanonicalDocument(buildProduct(false, Number.MAX_SAFE_INTEGER + 1))).toThrow(
      PersistenceMappingError,
    )
  })

  it('rechaza hidratar un campo derivado manipulado', () => {
    const document = toCanonicalDocument(buildProduct())
    const values = structuredClone(document.attributes.values) as unknown as Record<string, unknown>
    const effects = values.effects as Record<string, unknown>[]
    effects[0] = { ...effects[0], stackable: true }

    expect(() =>
      toCanonicalProduct({
        ...document,
        attributes: {
          ...document.attributes,
          values,
        } as unknown as typeof document.attributes,
      }),
    ).toThrow(PersistenceMappingError)
  })

  it('rechaza hidratar un nombre normalizado inconsistente', () => {
    const document = toCanonicalDocument(buildProduct())

    expect(() => toCanonicalProduct({ ...document, normalizedName: 'otro nombre' })).toThrow(
      PersistenceMappingError,
    )
  })
})
