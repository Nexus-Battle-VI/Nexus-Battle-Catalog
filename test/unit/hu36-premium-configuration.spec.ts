import { ConfigureProductPremium } from '../../src/application/use-cases/ConfigureProductPremium'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { CanonicalProductNotFoundError } from '../../src/application/errors/ApplicationError'
import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import { DomainError } from '../../src/domain/errors/DomainError'
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

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUSENTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const ARMA = {
  schemaVersion: '1',
  values: {
    kind: 'ARMA',
    compatibilityScope: 'ALL_HEROES',
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
  },
} as const

const producto = (premium: boolean, realMoneyPrice: Money | null = null): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(ID),
    sku: Sku.create('corona-del-master-eterno'),
    name: ProductName.create('Corona del Master Eterno'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
    description: ProductDescription.create('Descripcion valida.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(ARMA, ProductType.Weapon),
    printRun: PrintRun.create(1),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium,
      realMoneyPrice,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })

describe('HU-36: producto premium y precio en moneda real', () => {
  describe('el agregado', () => {
    it('activa premium con un precio real valido', () => {
      const nuevo = producto(false).configurePremium(
        ProductPricing.create({
          creditsPrice: CreditsPrice.create(0),
          premium: true,
          realMoneyPrice: Money.create(999, 'USD'),
        }),
        new Date(),
      )

      expect(nuevo.premium).toBe(true)
      expect(nuevo.realMoneyPrice?.amount).toBe(999)
      expect(nuevo.realMoneyPrice?.currency).toBe('USD')
    })

    it('actualiza el precio real de un producto ya premium', () => {
      const actualizado = producto(true, Money.create(499, 'USD')).configurePremium(
        ProductPricing.create({
          creditsPrice: CreditsPrice.create(0),
          premium: true,
          realMoneyPrice: Money.create(999, 'USD'),
        }),
        new Date(),
      )

      expect(actualizado.realMoneyPrice?.amount).toBe(999)
    })

    it('CA-02: premium sin precio real es invalido en el objeto de valor', () => {
      expect(() =>
        ProductPricing.create({
          creditsPrice: CreditsPrice.create(0),
          premium: true,
          realMoneyPrice: null,
        }),
      ).toThrow(/requiere un precio en moneda real positivo/u)
    })

    it('retirar premium NO esta soportado todavia (HU-36.6 sin resolver)', () => {
      const premiumComprado = producto(true, Money.create(999, 'USD'))

      expect(() =>
        premiumComprado.configurePremium(
          ProductPricing.create({
            creditsPrice: CreditsPrice.create(0),
            premium: false,
            realMoneyPrice: null,
          }),
          new Date(),
        ),
      ).toThrow(/no esta soportado todavia/u)
    })

    it('marcar como no-premium un producto que ya era no-premium es un no-op valido', () => {
      const sinCambios = producto(false).configurePremium(
        ProductPricing.create({
          creditsPrice: CreditsPrice.create(0),
          premium: false,
          realMoneyPrice: null,
        }),
        new Date(),
      )

      expect(sinCambios.premium).toBe(false)
    })

    it('avanza la version, que es lo que sostiene la concurrencia', () => {
      const original = producto(false)
      const configurado = original.configurePremium(
        ProductPricing.create({
          creditsPrice: CreditsPrice.create(0),
          premium: true,
          realMoneyPrice: Money.create(999, 'USD'),
        }),
        new Date(),
      )

      expect(configurado.version).toBe(original.version + 1)
    })
  })

  describe('el caso de uso de configuracion', () => {
    const construir = (): {
      uso: ConfigureProductPremium
      products: InMemoryCanonicalProductRepository
      audit: InMemoryProductAuditRepository
      outbox: InMemoryProductOutboxRepository
    } => {
      const products = new InMemoryCanonicalProductRepository()
      const audit = new InMemoryProductAuditRepository()
      const outbox = new InMemoryProductOutboxRepository()

      return {
        products,
        audit,
        outbox,
        uso: new ConfigureProductPremium({
          products,
          clock: { now: (): Date => new Date('2026-09-03T10:00:00.000Z') },
          idGenerator: { generate: (): string => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          audit,
          outbox,
        }),
      }
    }

    it('CA-01: activa premium y registra el cambio con los dos valores', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto(false))

      const dto = await uso.execute(
        ID,
        { premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } },
        { subject: 'admin-1' },
      )

      expect(dto.premium).toBe(true)
      expect(dto.realMoneyPrice).toEqual({ amount: 999, currency: 'USD' })

      const registros = await audit.findByAggregateId(ID)

      expect(registros).toHaveLength(1)
      expect(registros[0]?.action).toBe('PRODUCT_PREMIUM_CONFIGURED')
      expect(registros[0]?.delta).toEqual({
        premium: { valorAnterior: false, valorNuevo: true },
        realMoneyPrice: { valorAnterior: null, valorNuevo: { amount: 999, currency: 'USD' } },
      })
    })

    it('CA-02: premium sin precio real es 422 (DomainError) y conserva el producto', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto(false))

      await expect(uso.execute(ID, { premium: true }, { subject: 'admin-1' })).rejects.toThrow(
        DomainError,
      )

      const sinCambios = await products.findById(ProductId.create(ID))

      expect(sinCambios?.premium).toBe(false)
      await expect(audit.findByAggregateId(ID)).resolves.toHaveLength(0)
    })

    it('retirar premium responde con DomainError, no con exito silencioso', async () => {
      const { uso, products } = construir()
      await products.create(producto(true, Money.create(999, 'USD')))

      await expect(uso.execute(ID, { premium: false }, { subject: 'admin-1' })).rejects.toThrow(
        /no esta soportado todavia/u,
      )

      const sinCambios = await products.findById(ProductId.create(ID))

      expect(sinCambios?.premium).toBe(true)
    })

    it('un producto inexistente es 404, no 422', async () => {
      const { uso } = construir()

      await expect(
        uso.execute(
          AUSENTE,
          { premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } },
          {
            subject: 'admin-1',
          },
        ),
      ).rejects.toThrow(CanonicalProductNotFoundError)
    })

    it('rechaza campos no declarados en el cuerpo', async () => {
      const { uso, products } = construir()
      await products.create(producto(false))

      await expect(
        uso.execute(ID, { premium: true, creditsPrice: 999 }, { subject: 'admin-1' }),
      ).rejects.toThrow(DomainError)
    })

    it('deja el evento de configuracion en el outbox', async () => {
      const { uso, products, outbox } = construir()
      await products.create(producto(false))

      await uso.execute(
        ID,
        { premium: true, realMoneyPrice: { amount: 999, currency: 'USD' } },
        { subject: 'admin-1' },
      )

      const pendientes = await outbox.claim('prueba', 10, 1_000)

      expect(pendientes.map((e) => e.eventType)).toContain('catalog.product.premium.configured')
    })
  })
})
