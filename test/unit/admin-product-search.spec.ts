import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { SearchAdminProducts } from '../../src/application/use-cases/SearchAdminProducts'
import { DomainError } from '../../src/domain/errors/DomainError'
import { catalogFixture } from '../support/storefront-fixtures'

/**
 * Busqueda/listado administrativo del catalogo completo: pedido explicito del
 * cliente del proyecto ("buscar productos", incluidos los suspendidos) tras
 * revisar el panel de administracion.
 *
 * A DIFERENCIA de `catalog-storefront-reservations.spec.ts` (vitrina
 * publica), la invariante que se comprueba aqui es la contraria: que un
 * producto SUSPENDIDO aparezca cuando no se filtra por estado, y que
 * `lifecycleStatus` sea un filtro opcional, no una restriccion fija.
 */
describe('SearchAdminProducts', () => {
  let products: InMemoryCanonicalProductRepository
  let search: SearchAdminProducts

  beforeEach(() => {
    products = new InMemoryCanonicalProductRepository()
    search = new SearchAdminProducts(products)
  })

  it('incluye productos SUSPENDED cuando no se filtra por lifecycleStatus (a diferencia de la vitrina publica)', async () => {
    await products.create(catalogFixture(1))
    await products.create(catalogFixture(2, { suspended: true }))

    const result = await search.execute({})

    expect(result.total).toBe(2)
    expect(result.items.map((item) => item.lifecycleStatus).sort()).toEqual(['ACTIVE', 'SUSPENDED'])
  })

  it('filtra por lifecycleStatus cuando se pide explicitamente', async () => {
    await products.create(catalogFixture(1))
    await products.create(catalogFixture(2, { suspended: true }))

    const activos = await search.execute({ lifecycleStatus: 'ACTIVE' })
    const suspendidos = await search.execute({ lifecycleStatus: 'SUSPENDED' })

    expect(activos.total).toBe(1)
    expect(activos.items[0]?.lifecycleStatus).toBe('ACTIVE')
    expect(suspendidos.total).toBe(1)
    expect(suspendidos.items[0]?.lifecycleStatus).toBe('SUSPENDED')
  })

  it('combina busqueda literal, tipo y lifecycleStatus', async () => {
    await products.create(catalogFixture(1, { name: 'Espada de Fuego' }))
    await products.create(catalogFixture(2, { name: 'Espada Suspendida', suspended: true }))
    await products.create(catalogFixture(3, { name: 'Escudo de Hielo' }))

    const result = await search.execute({ query: 'espada', lifecycleStatus: 'SUSPENDED' })

    expect(result.total).toBe(1)
    expect(result.items[0]?.name).toBe('Espada Suspendida')
  })

  it('pagina con el mismo tamaño de pagina que la vitrina publica (16)', async () => {
    for (let n = 1; n <= 17; n++) await products.create(catalogFixture(n))

    const page1 = await search.execute({})
    const page2 = await search.execute({ page: 2 })

    expect(page1).toMatchObject({ page: 1, pageSize: 16, total: 17 })
    expect(page1.items).toHaveLength(16)
    expect(page2.items).toHaveLength(1)
  })

  it('rechaza una pagina invalida y un lifecycleStatus fuera del enum', async () => {
    await expect(search.execute({ page: 0 })).rejects.toThrow(DomainError)
    await expect(search.execute({ lifecycleStatus: 'ARCHIVED' })).rejects.toThrow(DomainError)
  })

  it('rechaza un tipo fuera del enum', async () => {
    await expect(search.execute({ type: 'MASCOTA' })).rejects.toThrow(DomainError)
  })
})
