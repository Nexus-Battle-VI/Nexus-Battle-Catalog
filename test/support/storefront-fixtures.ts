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
import { Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'

export const catalogFixture = (
  sequence: number,
  options: {
    printRun?: number
    availableUnits?: number
    suspended?: boolean
    currency?: string
    amount?: number
    name?: string
    description?: string
  } = {},
): CanonicalProduct => {
  const suffix = String(sequence).padStart(12, '0')
  const printRun = PrintRun.create(options.printRun ?? 5)
  return CanonicalProduct.restore({
    productId: ProductId.create(`00000000-0000-4000-8000-${suffix}`),
    sku: Sku.create(`producto-${suffix}`),
    name: ProductName.create(options.name ?? `Producto ${suffix}`),
    imageUrl: ProductImageUrl.create(
      'https://catalog.example.test/api/v1/catalog/product-assets/00000000-0000-4000-8000-000000000001/content',
    ),
    description: ProductDescription.create(options.description ?? 'Espada con efecto de fuego.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(
      {
        schemaVersion: '1',
        values: {
          kind: 'ARMA',
          compatibilityScope: 'ALL_HEROES',
          effects: [
            { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 7 } },
          ],
        },
      },
      ProductType.Weapon,
    ),
    printRun,
    availableUnits: printRun.isInfinite ? null : (options.availableUnits ?? printRun.value),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(42),
      premium: options.currency !== undefined,
      realMoneyPrice:
        options.currency === undefined
          ? null
          : Money.create(options.amount ?? 999, options.currency),
    }),
    lifecycleStatus: options.suspended ? LifecycleStatus.Suspended : LifecycleStatus.Active,
    createdAt: new Date('2026-09-03T00:00:00Z'),
    updatedAt: new Date('2026-09-03T00:00:00Z'),
    averageRating: null,
    reviewCount: 0,
    version: 0,
  })
}
