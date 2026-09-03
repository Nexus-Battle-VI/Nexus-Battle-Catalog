import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoCanonicalProductRepository } from '../../src/adapters/outbound/persistence/MongoCanonicalProductRepository'
import { MongoCanonicalProductUnitOfWork } from '../../src/adapters/outbound/persistence/MongoCanonicalProductUnitOfWork'
import { MongoProductAcquisitionRepository } from '../../src/adapters/outbound/persistence/MongoProductAcquisitionRepository'
import { MongoProductOutboxRepository } from '../../src/adapters/outbound/persistence/MongoProductOutboxRepository'
import { AcquireProductUnit } from '../../src/application/use-cases/AcquireProductUnit'
import { ProductSoldOutError } from '../../src/application/errors/ApplicationError'
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
import { ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * HU-34, CA-01 y CA-03 contra un MongoDB real.
 *
 * ESTA SUITE ES LA QUE RESPONDE A CA-01, y no puede sustituirse por una unitaria
 * con dobles: la garantia que se comprueba no esta en el codigo de la
 * aplicacion, esta en que MongoDB resuelva `findOneAndUpdate` condicionado sin
 * soltar el documento. Un doble en memoria diria que si sin haber probado nada.
 */

const ARMA = {
  schemaVersion: '1',
  values: {
    kind: 'ARMA',
    compatibilityScope: 'ALL_HEROES',
    effects: [{ kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } }],
  },
} as const

let contador = 0

const nuevoProducto = (tiraje: number): CanonicalProduct => {
  contador += 1
  const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(contador).padStart(12, '0')}`

  return CanonicalProduct.create({
    productId: ProductId.create(id),
    sku: Sku.create(`producto-${String(contador)}`),
    name: ProductName.create(`Producto ${String(contador)}`),
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
}

const uuid = (n: number): string => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, '0')}`

describe('HU-34: disponibilidad bajo concurrencia', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let products: MongoCanonicalProductRepository

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    const { error } = await migrateToLatest(db)
    expect(error).toBeUndefined()

    products = new MongoCanonicalProductRepository(db)
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  describe('CA-01: dos jugadores por la ultima unidad', () => {
    it('solo uno gana, y el contador nunca baja de cero', async () => {
      const producto = nuevoProducto(2)
      await products.create(producto)

      // Se deja en UNA unidad disponible.
      await products.decrementAvailability(producto.productId)

      const [primero, segundo] = await Promise.all([
        products.decrementAvailability(producto.productId),
        products.decrementAvailability(producto.productId),
      ])

      const ganadores = [primero, segundo].filter((r) => r !== null)
      const perdedores = [primero, segundo].filter((r) => r === null)

      expect(ganadores).toHaveLength(1)
      expect(perdedores).toHaveLength(1)
      expect(ganadores[0]?.availableUnits).toBe(0)
      expect(ganadores[0]?.depleted).toBe(true)
    })

    it('con 40 adquisiciones simultaneas sobre 12 unidades, salen exactamente 12', async () => {
      // Es el control de sobreventa. Si el decremento no fuera atomico, este
      // caso daria mas de 12 exitos, que es como se manifiesta el defecto en
      // produccion: el tiraje configurado deja de significar lo que dice.
      const producto = nuevoProducto(12)
      await products.create(producto)

      const resultados = await Promise.all(
        Array.from({ length: 40 }, () => products.decrementAvailability(producto.productId)),
      )

      expect(resultados.filter((r) => r !== null)).toHaveLength(12)

      const final = await products.findById(producto.productId)

      expect(final?.availableUnits).toBe(0)
      expect(final?.isSoldOut).toBe(true)
      // Agotado NO es suspendido: el campo de ciclo de vida no se toca.
      expect(final?.lifecycleStatus).toBe('ACTIVE')
    })
  })

  describe('CA-03: tiraje infinito', () => {
    it('no escribe en el producto y nunca se agota', async () => {
      const producto = nuevoProducto(-1)
      await products.create(producto)

      const antes = await db
        .collection('products')
        .findOne({ _id: producto.productId.value as unknown as never })

      const resultados = await Promise.all(
        Array.from({ length: 30 }, () => products.decrementAvailability(producto.productId)),
      )

      expect(resultados.every((r) => r?.availableUnits === null)).toBe(true)
      expect(resultados.every((r) => r?.depleted === false)).toBe(true)

      const despues = await db
        .collection('products')
        .findOne({ _id: producto.productId.value as unknown as never })

      // El control: `version` y `updatedAt` intactos. Comprobar solo
      // `availableUnits === null` no distinguiria «no se escribio» de «se
      // escribio null», y CA-03 exige lo primero.
      expect(despues?.version?.toString()).toBe(antes?.version?.toString())
      expect(despues?.updatedAt).toEqual(antes?.updatedAt)
    })
  })

  describe('idempotencia del contrato interno', () => {
    const clock = { now: (): Date => new Date('2026-09-03T00:00:00.000Z') }

    const casoDeUso = (): AcquireProductUnit =>
      new AcquireProductUnit({
        products,
        acquisitions: new MongoProductAcquisitionRepository(db),
        clock,
        idGenerator: { generate: (): string => uuid(900 + contador) },
        unitOfWork: new MongoCanonicalProductUnitOfWork(client),
        outbox: new MongoProductOutboxRepository(db),
      })

    it('un reintento con el mismo identificador NO resta una segunda unidad', async () => {
      const producto = nuevoProducto(5)
      await products.create(producto)

      const acquisitionId = uuid(contador)
      const uso = casoDeUso()

      const primera = await uso.execute(producto.productId.value, {
        acquisitionId,
        playerId: 'jugador-1',
      })
      const reintento = await uso.execute(producto.productId.value, {
        acquisitionId,
        playerId: 'jugador-1',
      })

      expect(primera.replayed).toBe(false)
      expect(primera.availableUnits).toBe(4)

      // La respuesta del reintento es la REGISTRADA, no la disponibilidad
      // actual. Dos respuestas distintas a la misma peticion serian peor que
      // un error.
      expect(reintento.replayed).toBe(true)
      expect(reintento.availableUnits).toBe(4)

      const final = await products.findById(producto.productId)

      expect(final?.availableUnits).toBe(4)
    })

    it('cuatro reintentos simultaneos de la misma adquisicion restan UNA unidad', async () => {
      const producto = nuevoProducto(5)
      await products.create(producto)

      const acquisitionId = uuid(500 + contador)
      const uso = casoDeUso()

      const resultados = await Promise.allSettled(
        Array.from({ length: 4 }, () =>
          uso.execute(producto.productId.value, { acquisitionId, playerId: 'jugador-1' }),
        ),
      )

      expect(resultados.every((r) => r.status === 'fulfilled')).toBe(true)

      const final = await products.findById(producto.productId)

      expect(final?.availableUnits).toBe(4)
    })

    it('agotado responde con error de agotamiento y no deja la adquisicion registrada', async () => {
      const producto = nuevoProducto(1)
      await products.create(producto)

      const uso = casoDeUso()

      await uso.execute(producto.productId.value, {
        acquisitionId: uuid(600 + contador),
        playerId: 'jugador-1',
      })

      const idRechazado = uuid(700 + contador)

      await expect(
        uso.execute(producto.productId.value, {
          acquisitionId: idRechazado,
          playerId: 'jugador-2',
        }),
      ).rejects.toBeInstanceOf(ProductSoldOutError)

      // El identificador rechazado NO queda consumido: si el administrador
      // amplia el tiraje, esa misma adquisicion debe poder reintentarse.
      const registro = await new MongoProductAcquisitionRepository(db).findById(idRechazado)

      expect(registro).toBeNull()
    })

    it('al agotarse deja un evento en el outbox', async () => {
      const producto = nuevoProducto(1)
      await products.create(producto)

      await casoDeUso().execute(producto.productId.value, {
        acquisitionId: uuid(800 + contador),
        playerId: 'jugador-1',
      })

      const eventos = await db
        .collection<{ eventType: string; status: string }>('outbox')
        .find({ aggregateId: producto.productId.value })
        .toArray()

      expect(eventos.map((e) => e.eventType)).toContain('catalog.product.stock.depleted')
      // Queda PENDIENTE, y esta bien: no hay transporte que lo despache
      // todavia. Darlo por entregado seria mentir sobre el estado del sistema.
      expect(eventos.every((e) => e.status === 'PENDING')).toBe(true)
    })
  })
})
