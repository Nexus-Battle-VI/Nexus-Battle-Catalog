import { AdjustProductInventory } from '../../src/application/use-cases/AdjustProductInventory'
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

const producto = (tiraje: number): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(ID),
    sku: Sku.create('escudo-del-guardian'),
    name: ProductName.create('Escudo del Guardian'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
    description: ProductDescription.create('Descripcion valida.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(ARMA, ProductType.Weapon),
    printRun: PrintRun.create(tiraje),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(500),
      premium: false,
      realMoneyPrice: null,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })

/** Consume `n` unidades, que es lo unico que hace avanzar las entregadas. */
const conEntregadas = (tiraje: number, n: number): CanonicalProduct => {
  let actual = producto(tiraje)

  for (let i = 0; i < n; i += 1) {
    actual = actual.consumeUnit(new Date('2026-09-02T00:00:00.000Z'))
  }

  return actual
}

describe('HU-34: configuracion del tiraje', () => {
  describe('el agregado', () => {
    it('nace con todo su tiraje disponible y nada entregado', () => {
      const nuevo = producto(10)

      expect(nuevo.availableUnits).toBe(10)
      expect(nuevo.deliveredUnits).toBe(0)
      expect(nuevo.isSoldOut).toBe(false)
    })

    it('tiraje infinito no lleva contador ni se agota nunca', () => {
      const infinito = producto(-1)

      expect(infinito.availableUnits).toBeNull()
      expect(infinito.deliveredUnits).toBeNull()
      expect(infinito.isSoldOut).toBe(false)
      // CA-03: consumir no cambia nada.
      expect(infinito.consumeUnit(new Date()).availableUnits).toBeNull()
      expect(infinito.consumeUnit(new Date()).version).toBe(infinito.version)
    })

    it('las unidades entregadas se derivan del tiraje y la disponibilidad', () => {
      const usado = conEntregadas(10, 3)

      expect(usado.availableUnits).toBe(7)
      expect(usado.deliveredUnits).toBe(3)
    })

    it('CA-02: no admite reducir el tiraje por debajo de lo ya entregado', () => {
      const usado = conEntregadas(10, 4)

      expect(() => usado.adjustPrintRun(PrintRun.create(3), new Date())).toThrow(DomainError)
      expect(() => usado.adjustPrintRun(PrintRun.create(3), new Date())).toThrow(
        /no puede ser inferior a las unidades ya entregadas \(4\)/u,
      )
    })

    it('admite reducirlo hasta exactamente lo entregado, y eso lo deja agotado', () => {
      const ajustado = conEntregadas(10, 4).adjustPrintRun(PrintRun.create(4), new Date())

      expect(ajustado.availableUnits).toBe(0)
      expect(ajustado.isSoldOut).toBe(true)
      // Agotado no es suspendido.
      expect(ajustado.lifecycleStatus).toBe('ACTIVE')
    })

    it('ampliar el tiraje reabre la disponibilidad', () => {
      // El caso del enunciado: 200 agotadas, se amplia a 350.
      const agotado = conEntregadas(200, 200)

      expect(agotado.isSoldOut).toBe(true)

      const ampliado = agotado.adjustPrintRun(PrintRun.create(350), new Date())

      expect(ampliado.availableUnits).toBe(150)
      expect(ampliado.isSoldOut).toBe(false)
    })

    it('de limitado a infinito se permite en cualquier momento', () => {
      const infinito = conEntregadas(10, 6).adjustPrintRun(PrintRun.create(-1), new Date())

      expect(infinito.availableUnits).toBeNull()
      expect(infinito.printRun.isInfinite).toBe(true)
    })

    it('de infinito a limitado NO, y lo dice explicitamente', () => {
      expect(() => producto(-1).adjustPrintRun(PrintRun.create(50), new Date())).toThrow(
        /no esta soportado/u,
      )
    })

    it('cada ajuste avanza la version, que es lo que sostiene la concurrencia', () => {
      const original = producto(10)
      const ajustado = original.adjustPrintRun(PrintRun.create(20), new Date())

      expect(ajustado.version).toBe(original.version + 1)
    })

    it('no admite un tiraje de 0 ni negativos distintos de -1', () => {
      expect(() => PrintRun.create(0)).toThrow(DomainError)
      expect(() => PrintRun.create(-3)).toThrow(/entero positivo o -1/u)
      expect(() => PrintRun.create(2.5)).toThrow(DomainError)
    })
  })

  describe('el caso de uso de ajuste', () => {
    const construir = (): {
      uso: AdjustProductInventory
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
        uso: new AdjustProductInventory({
          products,
          clock: { now: (): Date => new Date('2026-09-03T10:00:00.000Z') },
          idGenerator: { generate: (): string => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          audit,
          outbox,
        }),
      }
    }

    it('recalcula la disponibilidad y registra el ajuste con los dos valores', async () => {
      const { uso, products, audit } = construir()
      await products.create(conEntregadas(200, 200))

      const dto = await uso.execute(ID, { printRun: 350 }, { subject: 'admin-1' })

      expect(dto.printRun).toBe(350)
      expect(dto.availableUnits).toBe(150)

      const registros = await audit.findByAggregateId(ID)

      expect(registros).toHaveLength(1)
      expect(registros[0]?.action).toBe('PRODUCT_PRINT_RUN_ADJUSTED')
      // RNF-06: la auditoria debe poder responder que habia antes.
      expect(registros[0]?.delta).toEqual({
        printRun: { valorAnterior: 200, valorNuevo: 350 },
        availableUnits: { valorAnterior: 0, valorNuevo: 150 },
      })
    })

    it('CA-02: ante un ajuste invalido conserva el valor original', async () => {
      const { uso, products, audit } = construir()
      await products.create(conEntregadas(10, 4))

      await expect(uso.execute(ID, { printRun: 3 }, { subject: 'admin-1' })).rejects.toThrow(
        DomainError,
      )

      const sinCambios = await products.findById(ProductId.create(ID))

      expect(sinCambios?.printRun.value).toBe(10)
      expect(sinCambios?.availableUnits).toBe(6)
      // Y no deja rastro de auditoria de algo que no ocurrio.
      await expect(audit.findByAggregateId(ID)).resolves.toHaveLength(0)
    })

    it('un producto inexistente es 404, no 422', async () => {
      const { uso } = construir()

      await expect(uso.execute(AUSENTE, { printRun: 5 }, { subject: 'admin-1' })).rejects.toThrow(
        CanonicalProductNotFoundError,
      )
    })

    it('rechaza campos no declarados en el cuerpo', async () => {
      const { uso, products } = construir()
      await products.create(producto(10))

      await expect(
        uso.execute(ID, { printRun: 20, availableUnits: 999 }, { subject: 'admin-1' }),
      ).rejects.toThrow(DomainError)
    })

    it('deja el evento de ajuste en el outbox', async () => {
      const { uso, products, outbox } = construir()
      await products.create(producto(10))

      await uso.execute(ID, { printRun: 20 }, { subject: 'admin-1' })

      const pendientes = await outbox.claim('prueba', 10, 1_000)

      expect(pendientes.map((e) => e.eventType)).toContain('catalog.product.inventory.adjusted')
    })
  })
})
