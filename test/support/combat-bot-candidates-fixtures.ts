import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import {
  CreditsPrice,
  LifecycleStatus,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  type ProductType,
} from '../../src/domain/value-objects/canonical-product-values'
import { Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'

export const combatProductId = (sequence: number): string =>
  `10000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`

export const fixedMagnitude = (amount: number): object => ({ mode: 'FIXED', amount })

export const damageEffect = (amount: number): object => ({
  kind: 'DAMAGE',
  target: 'OPPONENT',
  magnitude: fixedMagnitude(amount),
})

export const healingEffect = (amount: number): object => ({
  kind: 'HEALING',
  target: 'ALLY',
  magnitude: fixedMagnitude(amount),
})

export const combatCatalogProduct = (
  sequence: number,
  type: ProductType,
  values: object,
  options: { readonly suspended?: boolean } = {},
): CanonicalProduct => {
  const createdAt = new Date('2026-10-04T12:00:00.000Z')
  const productId = ProductId.create(combatProductId(sequence))
  const base = {
    productId,
    sku: Sku.create(`combat-${String(sequence).padStart(3, '0')}`),
    name: ProductName.create(`Producto comercial secreto ${String(sequence)}`),
    imageUrl: ProductImageUrl.create(`https://assets.example.test/combat-${String(sequence)}.png`),
    description: ProductDescription.create('Descripción comercial que no debe salir del contrato.'),
    type,
    attributes: parseProductAttributes({ schemaVersion: '1', values }, type),
    printRun: PrintRun.create(99),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(9876),
      premium: true,
      realMoneyPrice: Money.create(2500, 'COP'),
    }),
    createdAt,
  }

  if (options.suspended !== true) return CanonicalProduct.create(base)

  return CanonicalProduct.restore({
    ...base,
    availableUnits: 77,
    lifecycleStatus: LifecycleStatus.Suspended,
    updatedAt: createdAt,
    averageRating: 4.8,
    reviewCount: 23,
    hasRealMoneyPurchase: true,
    version: 7,
  })
}
