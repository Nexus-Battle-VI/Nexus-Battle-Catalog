import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoCanonicalProductRepository } from '../../src/adapters/outbound/persistence/MongoCanonicalProductRepository'
import { SearchAdminProducts } from '../../src/application/use-cases/SearchAdminProducts'
import { ListCatalogStorefront } from '../../src/application/use-cases/ListCatalogStorefront'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import {
  STOREFRONT_ORDER_INDEX,
  STOREFRONT_SEARCH_INDEX,
  adminProductSearchMongoQuery,
} from '../../src/adapters/outbound/persistence/storefront-search-projection'
import { catalogFixture } from '../support/storefront-fixtures'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * Busqueda administrativa contra MongoDB de verdad: confirma que reutiliza
 * los MISMOS indices que la vitrina publica (migracion 011) sin heredar su
 * invariante `lifecycleStatus: ACTIVE`.
 */
describe('MongoCanonicalProductRepository.searchAdminProducts', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient
  let db: Db
  let products: MongoCanonicalProductRepository
  let search: SearchAdminProducts

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }
    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    expect((await migrateToLatest(db)).error).toBeUndefined()
    products = new MongoCanonicalProductRepository(db)
  }, 180_000)

  beforeEach(async () => {
    await db.collection('products').deleteMany({})
    search = new SearchAdminProducts(products)
  })

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  it('incluye SUSPENDED sin filtro, y la vitrina publica los sigue excluyendo', async () => {
    const activo = catalogFixture(1, { name: 'Producto Activo Uno' })
    const suspendido = catalogFixture(2, { name: 'Producto Suspendido Dos', suspended: true })
    await products.create(activo)
    await products.create(suspendido)

    const administrativo = await search.execute({})
    expect(administrativo.total).toBe(2)
    expect(administrativo.items.map((item) => item.lifecycleStatus).sort()).toEqual([
      'ACTIVE',
      'SUSPENDED',
    ])

    const vitrina = await new ListCatalogStorefront(products).execute({})
    expect(vitrina.total).toBe(1)
    expect(vitrina.items[0]?.lifecycleStatus).toBe('ACTIVE')
  })

  it('filtra por lifecycleStatus, tipo y busqueda literal combinados', async () => {
    // `catalogFixture` describe TODO producto como "Espada con efecto de
    // fuego." por defecto -de ahi que "Escudo Tres" reciba una `description`
    // explicita sin la palabra "espada": si no, el texto de busqueda
    // coincidiria por la descripcion heredada y no por el nombre, que es
    // justo lo que esta prueba quiere aislar.
    await products.create(catalogFixture(1, { name: 'Espada Uno' }))
    await products.create(catalogFixture(2, { name: 'Espada Dos', suspended: true }))
    await products.create(
      catalogFixture(3, {
        name: 'Escudo Tres',
        suspended: true,
        description: 'Escudo con efecto de hielo.',
      }),
    )

    const resultado = await search.execute({ query: 'espada', lifecycleStatus: 'SUSPENDED' })

    expect(resultado.total).toBe(1)
    expect(resultado.items[0]?.name).toBe('Espada Dos')
  })

  it('pagina en paginas estables de 16, igual que la vitrina publica', async () => {
    for (let n = 1; n <= 17; n++) await products.create(catalogFixture(n))

    const page1 = await search.execute({})
    const page2 = await search.execute({ page: 2 })

    expect(page1).toMatchObject({ page: 1, pageSize: 16, total: 17 })
    expect(page1.items).toHaveLength(16)
    expect(page2.items).toHaveLength(1)
  })

  it('usa el mismo indice de tokens que la vitrina publica cuando hay texto de busqueda', async () => {
    for (let n = 1; n <= 5; n++) await products.create(catalogFixture(n))
    await products.create(catalogFixture(6, { name: 'Ñandú administrativo', suspended: true }))

    const indexado = adminProductSearchMongoQuery({ query: 'ñ', page: 1 })
    const plan = await db
      .collection('products')
      .aggregate(indexado.pipeline, { hint: indexado.hint })
      .explain('executionStats')

    expect(JSON.stringify(plan)).toContain(STOREFRONT_SEARCH_INDEX)
    expect(JSON.stringify(plan)).toContain('IXSCAN')

    const sinTexto = adminProductSearchMongoQuery({ page: 1 })
    const planSinTexto = await db
      .collection('products')
      .aggregate(sinTexto.pipeline, { hint: sinTexto.hint })
      .explain('queryPlanner')

    expect(JSON.stringify(planSinTexto)).toContain(STOREFRONT_ORDER_INDEX)
  })

  it('un lifecycleStatus filtrado no devuelve documentos del otro estado', async () => {
    await products.create(catalogFixture(1, { name: 'Solo Activo' }))
    await products.create(catalogFixture(2, { name: 'Solo Suspendido', suspended: true }))

    const soloActivos = await search.execute({ lifecycleStatus: 'ACTIVE' })
    const soloSuspendidos = await search.execute({ lifecycleStatus: 'SUSPENDED' })

    expect(soloActivos.items.map((item) => item.name)).toEqual(['Solo Activo'])
    expect(soloSuspendidos.items.map((item) => item.name)).toEqual(['Solo Suspendido'])
  })
})
