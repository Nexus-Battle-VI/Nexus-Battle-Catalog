import { ConfigureProductDropChance } from '../../src/application/use-cases/ConfigureProductDropChance'
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
import { ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import type { RequestTraceContext } from '../../src/application/ports/RequestTraceContext'

const TRACE: RequestTraceContext = { correlationId: 'req-drop-chance-1' }
const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const AUSENTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const ARMA_ATTRS = {
  schemaVersion: '1',
  values: {
    kind: 'ARMA',
    compatibilityScope: 'ALL_HEROES',
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
  },
} as const

const HEROE_ATTRS = {
  schemaVersion: '1',
  values: {
    kind: 'HEROE',
    heroSubtype: 'GUERRERO_ARMAS',
    basePower: 10,
    baseHealth: 100,
    baseDefense: 5,
    baseAttack: { mode: 'FIXED', amount: 2 },
    baseDamage: { mode: 'DICE', count: 2, sides: 6 },
    abilities: [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ],
  },
} as const

const producto = (
  type: (typeof ProductType)[keyof typeof ProductType],
  attrs: unknown,
): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(ID),
    sku: Sku.create('hacha-historica'),
    name: ProductName.create('Hacha Historica'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
    description: ProductDescription.create('Producto creado antes de HU-30.'),
    type,
    attributes: parseProductAttributes(attrs, type),
    printRun: PrintRun.create(1),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium: false,
      realMoneyPrice: null,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })

describe('HU-30 (Task HU-30.1): tasa de caida Versus de un producto existente', () => {
  describe('el agregado', () => {
    it('fija la tasa en un ARMA sin tasa previa, conservando efectos y compatibilidad', () => {
      const original = producto(ProductType.Weapon, ARMA_ATTRS)
      const configurado = original.configureDropChance(750, new Date())

      const values = configurado.attributes.values as unknown as {
        dropChanceBasisPoints?: number
        effects: unknown
      }
      const originalValues = original.attributes.values as unknown as { effects: unknown }
      expect(values.dropChanceBasisPoints).toBe(750)
      expect(values.effects).toEqual(originalValues.effects)
      expect(configurado.version).toBe(original.version + 1)
    })

    it('rechaza un producto HEROE: solo ARMA/ARMADURA/ITEM tienen tasa de caida', () => {
      const heroe = producto(ProductType.Hero, HEROE_ATTRS)
      expect(() => heroe.configureDropChance(500, new Date())).toThrow(DomainError)
    })

    it('rechaza una tasa fuera de 0..10000', () => {
      const arma = producto(ProductType.Weapon, ARMA_ATTRS)
      expect(() => arma.configureDropChance(-1, new Date())).toThrow(DomainError)
      expect(() => arma.configureDropChance(10_001, new Date())).toThrow(DomainError)
      expect(() => arma.configureDropChance(1.5, new Date())).toThrow(DomainError)
    })
  })

  describe('el caso de uso', () => {
    const construir = (): {
      uso: ConfigureProductDropChance
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
        uso: new ConfigureProductDropChance({
          products,
          clock: { now: (): Date => new Date('2026-10-01T10:00:00.000Z') },
          idGenerator: { generate: (): string => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
          audit,
          outbox,
        }),
      }
    }

    it('configura la tasa, registra auditoria con antes/despues y un evento de outbox', async () => {
      const { uso, products, audit, outbox } = construir()
      await products.create(producto(ProductType.Weapon, ARMA_ATTRS))

      const dto = await uso.execute(
        ID,
        { dropChanceBasisPoints: 500 },
        { subject: 'admin-1' },
        TRACE,
      )

      const values = dto.attributes.values as { dropChanceBasisPoints?: number }
      expect(values.dropChanceBasisPoints).toBe(500)

      const entradas = await audit.findByAggregateId(ID)
      expect(entradas).toHaveLength(1)
      expect(entradas[0]?.action).toBe('PRODUCT_DROP_CHANCE_CONFIGURED')
      expect(entradas[0]?.delta).toEqual({
        dropChanceBasisPoints: { valorAnterior: null, valorNuevo: 500 },
      })

      expect(outbox.entries).toHaveLength(1)
      expect(outbox.entries[0]?.eventType).toBe('catalog.product.drop-chance.configured')
    })

    it('un segundo ajuste registra el valor anterior correcto en el delta', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto(ProductType.Weapon, ARMA_ATTRS))
      await uso.execute(ID, { dropChanceBasisPoints: 500 }, { subject: 'admin-1' }, TRACE)
      await uso.execute(ID, { dropChanceBasisPoints: 900 }, { subject: 'admin-1' }, TRACE)

      const entradas = await audit.findByAggregateId(ID)
      expect(entradas).toHaveLength(2)
      expect(entradas[1]?.delta).toEqual({
        dropChanceBasisPoints: { valorAnterior: 500, valorNuevo: 900 },
      })
    })

    it('producto inexistente: 404 de dominio', async () => {
      const { uso } = construir()
      await expect(
        uso.execute(AUSENTE, { dropChanceBasisPoints: 500 }, { subject: 'admin-1' }, TRACE),
      ).rejects.toBeInstanceOf(CanonicalProductNotFoundError)
    })

    it('rechaza un campo no declarado en el cuerpo', async () => {
      const { uso, products } = construir()
      await products.create(producto(ProductType.Weapon, ARMA_ATTRS))
      await expect(
        uso.execute(
          ID,
          { dropChanceBasisPoints: 500, type: 'EPICA' },
          { subject: 'admin-1' },
          TRACE,
        ),
      ).rejects.toBeInstanceOf(DomainError)
    })

    it('producto HEROE: 422 de dominio (no shape error)', async () => {
      const { uso, products } = construir()
      await products.create(producto(ProductType.Hero, HEROE_ATTRS))
      await expect(
        uso.execute(ID, { dropChanceBasisPoints: 500 }, { subject: 'admin-1' }, TRACE),
      ).rejects.toBeInstanceOf(DomainError)
    })
  })
})
