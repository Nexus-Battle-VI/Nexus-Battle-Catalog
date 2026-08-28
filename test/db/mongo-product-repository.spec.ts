import 'reflect-metadata'

import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Long, type Collection, type Db, type MongoClient } from 'mongodb'

/** Documento suelto, con el SKU como clave, para escribir saltandose el dominio. */
type DocumentoDePrueba = Record<string, unknown> & { _id: string }

import { describeError } from '../../src/infrastructure/observability/describe-error'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { MongoProductRepository } from '../../src/adapters/outbound/persistence/MongoProductRepository'
import { up as createProductsCollection } from '../../src/adapters/outbound/persistence/migrations/001-products'
import { up as addPremiumFields } from '../../src/adapters/outbound/persistence/migrations/002-premium-products'
import { Product, ProductStatus } from '../../src/domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * Adaptador de MongoDB contra un motor REAL, en contenedor.
 *
 * Estas pruebas viven aparte de la suite por defecto porque necesitan Docker.
 * Lo que comprueban no se puede comprobar de otra forma: que el validador
 * exista de verdad, que el documento tenga la forma que se cree, y que el tipo
 * del importe sea el que se declaro. Un doble de prueba habria pasado con un
 * esquema equivocado.
 */
describe('MongoProductRepository', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db
  let repository: MongoProductRepository

  const AT = new Date('2026-08-25T10:00:00.000Z')
  let contador = 0

  const buildProduct = (category = 'armas', amount = 150_000): Product => {
    contador += 1

    return Product.draft({
      sku: Sku.create(`sku-producto-${String(contador)}`),
      name: ProductName.create(`Producto numero ${String(contador)}`),
      category: Category.create(category),
      price: Money.create(amount, 'COP'),
    })
  }

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()

    // `directConnection` porque Testcontainers levanta un conjunto de replicas
    // de un solo nodo: sin esto el driver intentaria descubrir la topologia y
    // se quedaria esperando a miembros que no existen.
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  beforeEach(() => {
    repository = new MongoProductRepository(db)
  })

  /**
   * Acceso directo a la coleccion, tipado con el SKU como clave. Sin el
   * parametro de tipo, el driver asume `_id: ObjectId`, que es su valor por
   * defecto pero no lo que este modelo usa.
   */
  const productos = (): Collection<Record<string, unknown> & { _id: string }> =>
    db.collection<Record<string, unknown> & { _id: string }>('products')

  it('guarda y recupera un producto por su referencia', async () => {
    const product = buildProduct()
    await repository.save(product)

    const found = await repository.findBySku(product.sku)

    expect(found?.toSnapshot()).toEqual(product.toSnapshot())
  })

  it('crea un SKU una sola vez sin sobrescribir el documento existente', async () => {
    const original = buildProduct('armas', 100)
    const duplicate = Product.draft({
      sku: original.sku,
      name: ProductName.create('Producto duplicado'),
      category: Category.create('armaduras'),
      price: Money.create(200, 'COP'),
    })

    expect(await repository.create(original)).toBe(true)
    expect(await repository.create(duplicate)).toBe(false)
    expect((await repository.findBySku(original.sku))?.toSnapshot()).toEqual(original.toSnapshot())
  })

  it('admite exactamente una de dos creaciones concurrentes del mismo SKU', async () => {
    const first = buildProduct('armas', 100)
    const second = Product.draft({
      sku: first.sku,
      name: ProductName.create('Segundo candidato'),
      category: Category.create('armaduras'),
      price: Money.create(200, 'COP'),
    })

    const results = await Promise.all([repository.create(first), repository.create(second)])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await repository.exists(first.sku)).toBe(true)
  })

  it('devuelve null cuando el producto no existe', async () => {
    expect(await repository.findBySku(Sku.create('sku-inexistente'))).toBeNull()
  })

  it('responde sobre la existencia sin traerse el documento', async () => {
    const product = buildProduct()
    await repository.save(product)

    expect(await repository.exists(product.sku)).toBe(true)
    expect(await repository.exists(Sku.create('sku-inexistente'))).toBe(false)
  })

  it('comprueba la disponibilidad mediante una operacion real del motor', async () => {
    expect(await repository.isAvailable()).toBe(true)
  })

  /**
   * El mismo contrato que cumple el repositorio en memoria: una mutacion que no
   * se guarda NO debe filtrarse al almacen. Es lo que hace que una prueba falle
   * cuando un caso de uso olvida llamar a `save`.
   */
  it('no filtra al almacen una mutacion sin guardar', async () => {
    const product = buildProduct()
    await repository.save(product)

    product.publish(AT)

    const found = await repository.findBySku(product.sku)

    expect(found?.toSnapshot().status).toBe(ProductStatus.Draft)
  })

  it('actualiza el producto existente en lugar de duplicarlo', async () => {
    const product = buildProduct()
    await repository.save(product)

    product.publish(AT)
    await repository.save(product)

    const found = await repository.findBySku(product.sku)

    expect(found?.toSnapshot().status).toBe(ProductStatus.Published)
    expect(await productos().countDocuments({ _id: product.sku.value })).toBe(1)
  })

  /**
   * `replaceOne` y no `$set`: el agregado es la autoridad sobre TODO su
   * contenido. Con `$set`, un campo sobrante de una version anterior del
   * servicio sobreviviria indefinidamente al guardado.
   */
  it('reemplaza el documento entero y no deja campos sobrantes', async () => {
    const product = buildProduct()
    await repository.save(product)

    // Se escribe un campo de mas saltandose el validador, que es lo que haria
    // una version anterior del servicio con otro modelo.
    await productos().updateOne(
      { _id: product.sku.value },
      { $set: { sobrante: 'basura' } },
      { bypassDocumentValidation: true },
    )

    await repository.save(product)

    const documento = await productos().findOne({ _id: product.sku.value })

    expect(documento).not.toBeNull()
    expect(Object.keys(documento!)).not.toContain('sobrante')
  })

  /**
   * El importe se guarda como entero de 64 bits. Si el driver lo guardara como
   * `double` —que es lo que hace con un `number` de JavaScript— el dia que
   * alguien sumara desde una agregacion el resultado podria dejar de ser entero.
   */
  it('guarda el importe como entero de 64 bits, no como doble', async () => {
    const product = buildProduct('armas', 5_000_000_000)
    await repository.save(product)

    // Se le pregunta al MOTOR por el tipo BSON almacenado, en vez de mirar el
    // valor que devuelve el driver: eso ultimo dependeria de como este
    // configurada la promocion de enteros, que es precisamente lo que no debe
    // decidir si la prueba pasa.
    const comoLong = await productos().countDocuments({
      _id: product.sku.value,
      priceAmount: { $type: 'long' },
    })

    expect(comoLong).toBe(1)

    const found = await repository.findBySku(product.sku)

    expect(found?.toSnapshot().priceAmount).toBe(5_000_000_000)
  })

  describe('Busqueda', () => {
    /**
     * Por defecto NO devuelve borradores ni archivados. Un borrador no es
     * catalogo, y que aparezca salvo peticion explicita es la clase de fuga que
     * nadie prueba.
     */
    it('devuelve solo los publicados salvo peticion explicita', async () => {
      const publicado = buildProduct('pociones')
      publicado.publish(AT)
      const borrador = buildProduct('pociones')

      await repository.save(publicado)
      await repository.save(borrador)

      const visibles = await repository.search({ category: Category.create('pociones') })
      const todos = await repository.search({
        category: Category.create('pociones'),
        includeHidden: true,
      })

      expect(visibles.map((entry) => entry.sku.value)).toEqual([publicado.sku.value])
      expect(todos.map((entry) => entry.sku.value).sort()).toEqual(
        [publicado.sku.value, borrador.sku.value].sort(),
      )
    })

    it('filtra por categoria', async () => {
      const arma = buildProduct('armaduras')
      arma.publish(AT)
      await repository.save(arma)

      const otra = await repository.search({ category: Category.create('monturas') })

      expect(otra.map((entry) => entry.sku.value)).not.toContain(arma.sku.value)
    })

    it('devuelve una lista vacia cuando no hay nada en la categoria', async () => {
      expect(await repository.search({ category: Category.create('categoria-vacia') })).toEqual([])
    })
  })

  /**
   * Una coleccion de MongoDB acepta documentos de cualquier forma salvo que se
   * declare un validador. Estas pruebas escriben directamente en la coleccion,
   * sin pasar por el agregado: es la unica forma de demostrar que la proteccion
   * esta en el motor.
   */
  describe('El validador vive en el motor, no solo en el codigo', () => {
    // Escribe SIN pasar por el agregado. Es la unica forma de demostrar que la
    // proteccion esta en el motor: a traves del dominio, el documento invalido
    // no llegaria nunca.
    const escribir = (documento: DocumentoDePrueba): Promise<unknown> =>
      productos().insertOne(documento)

    const valido = (): DocumentoDePrueba => {
      contador += 1

      return {
        _id: `sku-validador-${String(contador)}`,
        name: 'Nombre valido',
        category: 'armas',
        priceAmount: Long.fromNumber(1000),
        priceCurrency: 'COP',
        status: ProductStatus.Published,
      }
    }

    it('admite un documento legado sin campos Premium', async () => {
      await expect(escribir(valido())).resolves.toBeDefined()
    })

    it('admite un producto explicitamente no Premium sin precio real', async () => {
      await expect(escribir({ ...valido(), isPremium: false })).resolves.toBeDefined()
    })

    it('admite un producto Premium con precio real positivo y moneda valida', async () => {
      await expect(
        escribir({
          ...valido(),
          isPremium: true,
          realMoneyPriceAmount: Long.fromNumber(999),
          realMoneyPriceCurrency: 'USD',
        }),
      ).resolves.toBeDefined()
    })

    it.each([
      ['Premium sin precio real', { isPremium: true }],
      [
        'Premium con importe real cero',
        {
          isPremium: true,
          realMoneyPriceAmount: Long.fromNumber(0),
          realMoneyPriceCurrency: 'USD',
        },
      ],
      [
        'no Premium con precio real',
        {
          isPremium: false,
          realMoneyPriceAmount: Long.fromNumber(999),
          realMoneyPriceCurrency: 'USD',
        },
      ],
      ['solo con importe real', { realMoneyPriceAmount: Long.fromNumber(999) }],
      ['solo con moneda real', { realMoneyPriceCurrency: 'USD' }],
    ])('rechaza una configuracion %s', async (_caso, premium) => {
      await expect(escribir({ ...valido(), ...premium })).rejects.toThrow()
    })

    it('rechaza un estado que no pertenece al vocabulario', async () => {
      await expect(escribir({ ...valido(), status: 'DESCATALOGADO' })).rejects.toThrow()
    })

    it('rechaza una moneda que no pertenece al vocabulario', async () => {
      await expect(escribir({ ...valido(), priceCurrency: 'XYZ' })).rejects.toThrow()
    })

    /**
     * Esta es la que justifica usar `long` en el validador: sin ella, un importe
     * fraccionario entraria como `double` y el dominio lo rechazaria despues, al
     * leerlo, en lugar de impedirse al escribirlo.
     */
    it('rechaza un importe que no es entero de 64 bits', async () => {
      await expect(escribir({ ...valido(), priceAmount: 1500.5 })).rejects.toThrow()
    })

    it('rechaza un importe negativo', async () => {
      await expect(escribir({ ...valido(), priceAmount: Long.fromNumber(-1) })).rejects.toThrow()
    })

    it.each([
      ['en mayusculas', 'SKU-MAYUSCULAS'],
      ['con espacios', 'sku con espacios'],
      ['que empieza por guion', '-sku'],
    ])('rechaza una referencia %s', async (_caso, sku) => {
      await expect(escribir({ ...valido(), _id: sku })).rejects.toThrow()
    })

    it('rechaza un nombre mas corto que el minimo del dominio', async () => {
      await expect(escribir({ ...valido(), name: 'ab' })).rejects.toThrow()
    })

    /**
     * `additionalProperties: false`. Un documento con campos que el dominio no
     * conoce es basura que alguien leera algun dia como si significara algo.
     */
    it('rechaza un campo que el modelo no declara', async () => {
      await expect(escribir({ ...valido(), inventado: 'valor' })).rejects.toThrow()
    })

    it('rechaza un documento al que le falta un campo obligatorio', async () => {
      const incompleto = valido()
      delete incompleto.priceCurrency

      await expect(escribir(incompleto)).rejects.toThrow()
    })

    it('aplica la correccion a una base que ya registro las migraciones 001 y 002', async () => {
      const upgradeDb = client!.db('catalog-upgrade-bug-275')
      const upgradeProducts = upgradeDb.collection<DocumentoDePrueba>('products')
      const upgradeMigrations = upgradeDb.collection<{
        _id: string
        startedAt: Date
        completedAt: Date
      }>('_migrations')
      const completedAt = new Date()

      try {
        await createProductsCollection(upgradeDb)
        await addPremiumFields(upgradeDb)
        await upgradeMigrations.insertMany([
          { _id: '001-products', startedAt: completedAt, completedAt },
          { _id: '002-premium-products', startedAt: completedAt, completedAt },
        ])

        const invalidPremium = { ...valido(), isPremium: true }

        await expect(upgradeProducts.insertOne(invalidPremium)).resolves.toBeDefined()
        await upgradeProducts.deleteOne({ _id: invalidPremium._id })

        const { applied, error } = await migrateToLatest(upgradeDb)

        expect(error).toBeUndefined()
        expect(applied).toEqual(['003-premium-product-validation'])
        await expect(upgradeProducts.insertOne(invalidPremium)).rejects.toThrow()
      } finally {
        await upgradeDb.dropDatabase()
      }
    })
  })

  it('la migracion es idempotente: volver a aplicarla no cambia nada', async () => {
    const { applied, error } = await migrateToLatest(db)

    expect(error).toBeUndefined()
    expect(applied).toEqual([])
  })

  /**
   * Una reclamacion sin completar significa que una ejecucion anterior murio a
   * medias. Seguir escribiendo encima de un esquema en estado desconocido lo
   * empeora, asi que el migrador falla y dice cual.
   */
  it('se niega a continuar si una migracion anterior quedo a medias', async () => {
    const registro = db.collection<{ _id: string; completedAt?: Date }>('_migrations')
    const original = await registro.findOne({ _id: '001-products' })

    await registro.updateOne({ _id: '001-products' }, { $unset: { completedAt: '' } })

    try {
      const { error } = await migrateToLatest(db)

      expect(describeError(error)).toContain('quedo a medias')
    } finally {
      await registro.updateOne(
        { _id: '001-products' },
        { $set: { completedAt: original?.completedAt ?? new Date() } },
      )
    }
  })
})
