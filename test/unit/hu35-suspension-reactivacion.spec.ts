import { UpdateProductLifecycleStatus } from '../../src/application/use-cases/UpdateProductLifecycleStatus'
import { AcquireProductUnit } from '../../src/application/use-cases/AcquireProductUnit'
import { StockReservationConflictError } from '../../src/application/use-cases/StockReservations'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAcquisitionRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAcquisitionRepository'
import { InMemoryProductAuditRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import { CanonicalProductNotFoundError } from '../../src/application/errors/ApplicationError'
import { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import { DomainError } from '../../src/domain/errors/DomainError'
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

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AUSENTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const MOTIVO_VALIDO = 'Rebalanceo pendiente de estadísticas'

const ARMA = {
  schemaVersion: '1',
  values: {
    kind: 'ARMA',
    compatibilityScope: 'ALL_HEROES',
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
  },
} as const

const producto = (printRun = 300): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(ID),
    sku: Sku.create('mago-hielo'),
    name: ProductName.create('Mago Hielo'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
    description: ProductDescription.create('Descripcion valida.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(ARMA, ProductType.Weapon),
    printRun: PrintRun.create(printRun),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium: false,
      realMoneyPrice: null,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })

describe('HU-35: suspension y reactivacion de producto', () => {
  describe('el agregado', () => {
    it('CA-01: suspende un producto activo y avanza la version', () => {
      const original = producto()
      const suspendido = original.suspend(new Date())

      expect(suspendido.lifecycleStatus).toBe(LifecycleStatus.Suspended)
      expect(suspendido.version).toBe(original.version + 1)
    })

    it('caso adicional de idempotencia: suspender un producto ya suspendido es un no-op', () => {
      const suspendido = producto().suspend(new Date('2026-09-02T00:00:00.000Z'))
      const segundaVez = suspendido.suspend(new Date('2026-09-03T00:00:00.000Z'))

      expect(segundaVez).toBe(suspendido)
      expect(segundaVez.version).toBe(suspendido.version)
    })

    it('CA-03: reactivar cambia el estado a activo sin tocar la disponibilidad', () => {
      const suspendido = producto().suspend(new Date())
      const reactivado = suspendido.reactivate(new Date())

      expect(reactivado.lifecycleStatus).toBe(LifecycleStatus.Active)
      expect(reactivado.availableUnits).toBe(suspendido.availableUnits)
      expect(reactivado.version).toBe(suspendido.version + 1)
    })

    it('CA-03: un producto agotado sigue agotado tras reactivarse, sin restituir unidades', () => {
      const agotado = producto(1).reserveUnits(1, new Date('2026-09-02T00:00:00.000Z'))

      expect(agotado.isSoldOut).toBe(true)

      const suspendido = agotado.suspend(new Date('2026-09-03T00:00:00.000Z'))
      const reactivado = suspendido.reactivate(new Date('2026-09-04T00:00:00.000Z'))

      expect(reactivado.isSoldOut).toBe(true)
      expect(reactivado.availableUnits).toBe(0)
    })

    it('reactivar un producto ya activo es un no-op', () => {
      const activo = producto()
      const segundaVez = activo.reactivate(new Date())

      expect(segundaVez).toBe(activo)
    })

    it('regresion: un producto suspendido rechaza reservar unidades (guarda ya existente)', () => {
      const suspendido = producto().suspend(new Date())

      expect(() => suspendido.reserveUnits(1, new Date())).toThrow(/está suspendido/u)
    })

    it('la suspension no elimina ni modifica el resto del agregado', () => {
      const original = producto()
      const suspendido = original.suspend(new Date())

      expect(suspendido.productId.equals(original.productId)).toBe(true)
      expect(suspendido.sku.value).toBe(original.sku.value)
      expect(suspendido.printRun.value).toBe(original.printRun.value)
    })
  })

  describe('el caso de uso de actualizacion de estado', () => {
    const construir = (): {
      uso: UpdateProductLifecycleStatus
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
        uso: new UpdateProductLifecycleStatus({
          products,
          clock: { now: (): Date => new Date('2026-09-05T10:00:00.000Z') },
          idGenerator: { generate: (): string => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          audit,
          outbox,
        }),
      }
    }

    it('CA-01: suspende y registra auditoria con actor, motivo y timestamp', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto())

      const dto = await uso.execute(
        ID,
        { status: 'SUSPENDED', reason: MOTIVO_VALIDO },
        { subject: 'admin-1' },
      )

      expect(dto.lifecycleStatus).toBe(LifecycleStatus.Suspended)

      const registros = await audit.findByAggregateId(ID)

      expect(registros).toHaveLength(1)
      expect(registros[0]?.action).toBe('PRODUCT_SUSPENDED')
      expect(registros[0]?.actor).toEqual({ subject: 'admin-1' })
      expect(registros[0]?.delta).toEqual({ reason: MOTIVO_VALIDO })
      expect(registros[0]?.timestamp).toEqual(new Date('2026-09-05T10:00:00.000Z'))
    })

    it('deja el evento de suspension en el outbox con el productId esperado (contrato del productor para HU-038)', async () => {
      const { uso, products, outbox } = construir()
      await products.create(producto())

      await uso.execute(ID, { status: 'SUSPENDED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })

      const [evento] = await outbox.claim('prueba', 10, 1_000)

      expect(evento).toMatchObject({
        aggregateId: ID,
        aggregateType: 'CanonicalProduct',
        eventType: 'catalog.product.suspended',
      })
    })

    it('deja el evento de reactivacion en el outbox con el productId esperado', async () => {
      const { uso, products, outbox } = construir()
      await products.create(producto())
      await uso.execute(ID, { status: 'SUSPENDED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })
      await outbox.claim('prueba', 10, 1_000)

      await uso.execute(
        ID,
        { status: 'ACTIVE', reason: 'Rebalanceo completado, producto listo' },
        { subject: 'admin-1' },
      )

      const [evento] = await outbox.claim('prueba', 10, 1_000)

      expect(evento).toMatchObject({
        aggregateId: ID,
        aggregateType: 'CanonicalProduct',
        eventType: 'catalog.product.reactivated',
      })
    })

    it('la suspension NO elimina el documento: sigue siendo recuperable por su id', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await uso.execute(ID, { status: 'SUSPENDED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })

      const encontrado = await products.findById(ProductId.create(ID))

      expect(encontrado).not.toBeNull()
      expect(encontrado?.sku.value).toBe('mago-hielo')
      expect(encontrado?.lifecycleStatus).toBe(LifecycleStatus.Suspended)
    })

    it('idempotencia: suspender un producto ya suspendido no genera un segundo evento', async () => {
      const { uso, products, audit, outbox } = construir()
      await products.create(producto())

      await uso.execute(ID, { status: 'SUSPENDED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })
      const segunda = await uso.execute(
        ID,
        { status: 'SUSPENDED', reason: MOTIVO_VALIDO },
        { subject: 'admin-2' },
      )

      expect(segunda.lifecycleStatus).toBe(LifecycleStatus.Suspended)
      await expect(audit.findByAggregateId(ID)).resolves.toHaveLength(1)

      const pendientes = await outbox.claim('prueba', 10, 1_000)

      expect(pendientes).toHaveLength(1)
    })

    it('CA-03: reactiva un producto suspendido y registra auditoria de reactivacion', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto())
      await uso.execute(ID, { status: 'SUSPENDED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })

      const dto = await uso.execute(
        ID,
        { status: 'ACTIVE', reason: 'Rebalanceo completado, producto listo' },
        { subject: 'admin-1' },
      )

      expect(dto.lifecycleStatus).toBe(LifecycleStatus.Active)

      const registros = await audit.findByAggregateId(ID)

      expect(registros).toHaveLength(2)
      expect(registros[1]?.action).toBe('PRODUCT_REACTIVATED')
    })

    it('idempotencia: reactivar un producto ya activo no genera un segundo evento', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto())

      await uso.execute(ID, { status: 'ACTIVE', reason: MOTIVO_VALIDO }, { subject: 'admin-1' })

      await expect(audit.findByAggregateId(ID)).resolves.toHaveLength(0)
    })

    it('CA-02: motivo ausente es rechazado con DomainError (400 en el controlador)', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(ID, { status: 'SUSPENDED' }, { subject: 'admin-1' }),
      ).rejects.toThrow(DomainError)
    })

    it('CA-02: motivo con menos de 10 caracteres es rechazado', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(ID, { status: 'SUSPENDED', reason: 'muy corto' }, { subject: 'admin-1' }),
      ).rejects.toThrow(/al menos 10 caracteres/u)
    })

    it('CA-02: una solicitud rechazada por motivo invalido no modifica el producto', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(ID, { status: 'SUSPENDED', reason: 'corto' }, { subject: 'admin-1' }),
      ).rejects.toThrow(DomainError)

      const sinCambios = await products.findById(ProductId.create(ID))

      expect(sinCambios?.lifecycleStatus).toBe(LifecycleStatus.Active)
    })

    it('un status fuera del enum es rechazado', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(ID, { status: 'ARCHIVED', reason: MOTIVO_VALIDO }, { subject: 'admin-1' }),
      ).rejects.toThrow(DomainError)
    })

    it('rechaza campos no declarados en el cuerpo', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(
          ID,
          { status: 'SUSPENDED', reason: MOTIVO_VALIDO, force: true },
          { subject: 'admin-1' },
        ),
      ).rejects.toThrow(DomainError)
    })

    it('un producto inexistente es 404, no 422', async () => {
      const { uso } = construir()

      await expect(
        uso.execute(
          AUSENTE,
          { status: 'SUSPENDED', reason: MOTIVO_VALIDO },
          { subject: 'admin-1' },
        ),
      ).rejects.toThrow(CanonicalProductNotFoundError)
    })
  })

  describe('HU-35.5: bloqueo de nuevas adquisiciones tras la suspension', () => {
    it('AcquireProductUnit (el mismo camino que usa Commerce) rechaza un producto suspendido', async () => {
      const products = new InMemoryCanonicalProductRepository()
      const acquisitions = new InMemoryProductAcquisitionRepository()
      const audit = new InMemoryProductAuditRepository()
      const outbox = new InMemoryProductOutboxRepository()
      const clock = { now: (): Date => new Date('2026-09-05T10:00:00.000Z') }

      const cambiarEstado = new UpdateProductLifecycleStatus({
        products,
        clock,
        idGenerator: { generate: (): string => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
        audit,
        outbox,
      })
      const adquirir = new AcquireProductUnit({
        products,
        acquisitions,
        clock,
        idGenerator: { generate: (): string => 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
        outbox,
      })

      await products.create(producto())
      await cambiarEstado.execute(
        ID,
        { status: 'SUSPENDED', reason: MOTIVO_VALIDO },
        { subject: 'admin-1' },
      )

      await expect(
        adquirir.execute(ID, {
          acquisitionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          playerId: 'jugador-1',
        }),
      ).rejects.toThrow(StockReservationConflictError)

      const sinCambios = await products.findById(ProductId.create(ID))

      expect(sinCambios?.availableUnits).toBe(producto().availableUnits)
    })
  })
})
