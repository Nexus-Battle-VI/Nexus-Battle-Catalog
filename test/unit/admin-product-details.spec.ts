import { UpdateProductDetails } from '../../src/application/use-cases/UpdateProductDetails'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { InMemoryProductAuditRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAuditRepository'
import { InMemoryProductOutboxRepository } from '../../src/adapters/outbound/persistence/InMemoryProductOutboxRepository'
import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductNotFoundError,
} from '../../src/application/errors/ApplicationError'
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

const TRACE: RequestTraceContext = { correlationId: 'req-details-1' }
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

const producto = (
  overrides: { readonly productId?: string; readonly sku?: string; readonly name?: string } = {},
): CanonicalProduct =>
  CanonicalProduct.create({
    productId: ProductId.create(overrides.productId ?? ID),
    sku: Sku.create(overrides.sku ?? 'espada-de-fuego'),
    name: ProductName.create(overrides.name ?? 'Espada de Fuego'),
    imageUrl: ProductImageUrl.create('https://assets.example.test/img.png'),
    description: ProductDescription.create('Descripcion original.'),
    type: ProductType.Weapon,
    attributes: parseProductAttributes(ARMA, ProductType.Weapon),
    printRun: PrintRun.create(300),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(0),
      premium: false,
      realMoneyPrice: null,
    }),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  })

describe('edicion de detalles de un producto canonico', () => {
  describe('el agregado (CanonicalProduct.updateDetails)', () => {
    it('actualiza solo los campos recibidos y avanza la version', () => {
      const original = producto()
      const actualizado = original.updateDetails(
        { description: ProductDescription.create('Descripcion nueva.') },
        new Date(),
      )

      expect(actualizado.name.value).toBe(original.name.value)
      expect(actualizado.imageUrl.value).toBe(original.imageUrl.value)
      expect(actualizado.description.value).toBe('Descripcion nueva.')
      expect(actualizado.version).toBe(original.version + 1)
    })

    it('actualiza el nombre y recalcula normalizedName', () => {
      const original = producto()
      const actualizado = original.updateDetails(
        { name: ProductName.create('Espada Renombrada') },
        new Date(),
      )

      expect(actualizado.name.value).toBe('Espada Renombrada')
      expect(actualizado.normalizedName).toBe('espada renombrada')
    })

    it('no toca type, attributes, printRun ni lifecycleStatus', () => {
      const original = producto()
      const actualizado = original.updateDetails(
        { imageUrl: ProductImageUrl.create('https://assets.example.test/otra.png') },
        new Date(),
      )

      expect(actualizado.type).toBe(original.type)
      expect(actualizado.attributes).toEqual(original.attributes)
      expect(actualizado.printRun.value).toBe(original.printRun.value)
      expect(actualizado.lifecycleStatus).toBe(original.lifecycleStatus)
    })
  })

  describe('el caso de uso', () => {
    const construir = (): {
      uso: UpdateProductDetails
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
        uso: new UpdateProductDetails({
          products,
          clock: { now: (): Date => new Date('2026-09-05T10:00:00.000Z') },
          idGenerator: { generate: (): string => 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          audit,
          outbox,
        }),
      }
    }

    it('edita un subconjunto de campos y registra auditoria con el delta correcto', async () => {
      const { uso, products, audit } = construir()
      await products.create(producto())

      const dto = await uso.execute(
        ID,
        { description: 'Descripcion nueva y valida.' },
        { subject: 'admin-1' },
        TRACE,
      )

      expect(dto.description).toBe('Descripcion nueva y valida.')
      expect(dto.name).toBe('Espada de Fuego')

      const registros = await audit.findByAggregateId(ID)
      expect(registros).toHaveLength(1)
      expect(registros[0]?.action).toBe('PRODUCT_DETAILS_UPDATED')
      expect(registros[0]?.delta).toEqual({
        description: {
          valorAnterior: 'Descripcion original.',
          valorNuevo: 'Descripcion nueva y valida.',
        },
      })
    })

    it('edita los tres campos a la vez', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      const dto = await uso.execute(
        ID,
        {
          name: 'Espada Legendaria',
          imageUrl: 'https://assets.example.test/legendaria.png',
          description: 'Nueva descripcion completa.',
        },
        { subject: 'admin-1' },
        TRACE,
      )

      expect(dto).toMatchObject({
        name: 'Espada Legendaria',
        imageUrl: 'https://assets.example.test/legendaria.png',
        description: 'Nueva descripcion completa.',
      })
    })

    it('deja el evento en el outbox con el productId esperado', async () => {
      const { uso, products, outbox } = construir()
      await products.create(producto())

      await uso.execute(ID, { name: 'Nuevo Nombre' }, { subject: 'admin-1' }, TRACE)

      const [evento] = await outbox.claim('prueba', 10, 1_000)
      expect(evento).toMatchObject({
        aggregateId: ID,
        aggregateType: 'CanonicalProduct',
        eventType: 'catalog.product.details.updated',
        correlationId: TRACE.correlationId,
      })
    })

    it('rechaza un cuerpo sin ningun campo editable (400 en el controlador)', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(uso.execute(ID, {}, { subject: 'admin-1' }, TRACE)).rejects.toThrow(
        /al menos un campo editable/u,
      )
    })

    it('rechaza type y attributes: no son campos declarados', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(
        uso.execute(ID, { name: 'Nombre válido', type: 'ITEM' }, { subject: 'admin-1' }, TRACE),
      ).rejects.toThrow(/no es una propiedad admitida/u)

      await expect(
        uso.execute(
          ID,
          { name: 'Nombre válido', attributes: { schemaVersion: '1', values: { kind: 'ITEM' } } },
          { subject: 'admin-1' },
          TRACE,
        ),
      ).rejects.toThrow(/no es una propiedad admitida/u)
    })

    it('una solicitud rechazada por forma no modifica el producto', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      await expect(uso.execute(ID, {}, { subject: 'admin-1' }, TRACE)).rejects.toThrow(DomainError)

      const sinCambios = await products.findById(ProductId.create(ID))
      expect(sinCambios?.name.value).toBe('Espada de Fuego')
      expect(sinCambios?.version).toBe(0)
    })

    it('un producto inexistente es 404 (CanonicalProductNotFoundError), no 422', async () => {
      const { uso } = construir()

      await expect(
        uso.execute(AUSENTE, { name: 'Nombre válido' }, { subject: 'admin-1' }, TRACE),
      ).rejects.toThrow(CanonicalProductNotFoundError)
    })

    it('dos ediciones simultaneas del mismo producto: una choca por concurrencia (409 en el controlador)', async () => {
      const { uso, products } = construir()
      await products.create(producto())

      const resultados = await Promise.allSettled([
        uso.execute(ID, { description: 'Descripcion A.' }, { subject: 'admin-1' }, TRACE),
        uso.execute(ID, { description: 'Descripcion B.' }, { subject: 'admin-2' }, TRACE),
      ])

      expect(resultados.filter((resultado) => resultado.status === 'fulfilled')).toHaveLength(1)
      const rechazo = resultados.find((resultado) => resultado.status === 'rejected')
      expect(rechazo).toMatchObject({
        reason: expect.any(CanonicalProductConcurrencyConflictError),
      })
    })

    it('renombrar a un nombre ya usado por otro producto ACTIVO del mismo tipo es 409', async () => {
      const { uso, products } = construir()
      await products.create(producto())
      await products.create(
        producto({
          productId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sku: 'escudo-de-hielo',
          name: 'Escudo de Hielo',
        }),
      )

      await expect(
        uso.execute(ID, { name: 'Escudo de Hielo' }, { subject: 'admin-1' }, TRACE),
      ).rejects.toThrow(CanonicalProductAlreadyExistsError)
    })

    it('renombrar un producto SUSPENDED no choca con la unicidad de nombre activo', async () => {
      const { uso, products } = construir()
      const suspendido = producto().suspend(new Date('2026-09-04T00:00:00.000Z'))
      await products.create(suspendido)
      await products.create(
        producto({
          productId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          sku: 'escudo-de-hielo',
          name: 'Escudo de Hielo',
        }),
      )

      const dto = await uso.execute(ID, { name: 'Escudo de Hielo' }, { subject: 'admin-1' }, TRACE)

      expect(dto.name).toBe('Escudo de Hielo')
    })
  })
})
