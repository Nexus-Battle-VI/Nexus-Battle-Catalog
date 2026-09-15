import { DomainError } from '../../src/domain/errors/DomainError'
import { CanonicalProductNotFoundError } from '../../src/application/errors/ApplicationError'
import type { CanonicalProductWritePort } from '../../src/application/ports/CanonicalProductPorts'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import { UpdateProductRating } from '../../src/application/use-cases/UpdateProductRating'
import type { ProductId } from '../../src/domain/value-objects/canonical-product-values'
import { catalogFixture } from '../support/storefront-fixtures'

describe('HU-40 (CA-03): agregado de calificaciones en el dominio', () => {
  it('un producto nuevo nace sin calificaciones', () => {
    const producto = catalogFixture(1)

    expect(producto.averageRating).toBeNull()
    expect(producto.reviewCount).toBe(0)
  })

  it('withRating aplica el agregado y avanza la version', () => {
    const producto = catalogFixture(2)

    const calificado = producto.withRating({ averageRating: 4.5, reviewCount: 2 }, new Date())

    expect(calificado.averageRating).toBe(4.5)
    expect(calificado.reviewCount).toBe(2)
    expect(calificado.version).toBe(producto.version + 1)
  })

  it('withRating conserva el resto del agregado sin tocarlo', () => {
    const producto = catalogFixture(3)

    const calificado = producto.withRating({ averageRating: 3, reviewCount: 1 }, new Date())

    expect(calificado.availableUnits).toBe(producto.availableUnits)
    expect(calificado.creditsPrice.value).toBe(producto.creditsPrice.value)
  })

  it('rechaza un promedio cuando no hay calificaciones', () => {
    const producto = catalogFixture(4)

    expect(() => producto.withRating({ averageRating: 4, reviewCount: 0 }, new Date())).toThrow(
      DomainError,
    )
  })

  it('rechaza la ausencia de promedio cuando SI hay calificaciones', () => {
    const producto = catalogFixture(5)

    expect(() => producto.withRating({ averageRating: null, reviewCount: 3 }, new Date())).toThrow(
      DomainError,
    )
  })

  it.each([0.99, 5.01])('rechaza un promedio fuera de 1-5: %s', (averageRating) => {
    const producto = catalogFixture(6)

    expect(() => producto.withRating({ averageRating, reviewCount: 1 }, new Date())).toThrow(
      DomainError,
    )
  })

  it('rechaza un conteo negativo', () => {
    const producto = catalogFixture(7)

    expect(() => producto.withRating({ averageRating: 3, reviewCount: -1 }, new Date())).toThrow(
      DomainError,
    )
  })
})

describe('HU-40 (CA-03): caso de uso UpdateProductRating', () => {
  const FIXED_NOW = new Date('2026-09-03T10:00:00.000Z')
  const clock: ClockPort = { now: () => FIXED_NOW }
  const PRODUCT_ID = '11111111-1111-4111-8111-111111111111'

  const buildDeps = (updateRating: jest.Mock): CanonicalProductWritePort =>
    ({
      updateRating,
    }) as unknown as CanonicalProductWritePort

  it('parsea el comando y aplica el agregado con la hora del reloj', async () => {
    const updateRating = jest.fn().mockResolvedValue(true)
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await useCase.execute(PRODUCT_ID, { averageRating: 4.5, reviewCount: 2 })

    expect(updateRating).toHaveBeenCalledWith(
      expect.objectContaining({ value: PRODUCT_ID }) as ProductId,
      { averageRating: 4.5, reviewCount: 2 },
      FIXED_NOW,
    )
  })

  it('acepta un promedio null cuando el conteo es cero', async () => {
    const updateRating = jest.fn().mockResolvedValue(true)
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await useCase.execute(PRODUCT_ID, { averageRating: null, reviewCount: 0 })

    expect(updateRating).toHaveBeenCalledWith(
      expect.anything(),
      { averageRating: null, reviewCount: 0 },
      FIXED_NOW,
    )
  })

  it('lanza CanonicalProductNotFoundError si el repositorio no encuentra el producto', async () => {
    const updateRating = jest.fn().mockResolvedValue(false)
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await expect(
      useCase.execute(PRODUCT_ID, { averageRating: 5, reviewCount: 1 }),
    ).rejects.toBeInstanceOf(CanonicalProductNotFoundError)
  })

  it('rechaza un comando con una propiedad desconocida', async () => {
    const updateRating = jest.fn()
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await expect(
      useCase.execute(PRODUCT_ID, { averageRating: 5, reviewCount: 1, extra: true }),
    ).rejects.toThrow(DomainError)
    expect(updateRating).not.toHaveBeenCalled()
  })

  it('rechaza un reviewCount no entero', async () => {
    const updateRating = jest.fn()
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await expect(
      useCase.execute(PRODUCT_ID, { averageRating: 5, reviewCount: 1.5 }),
    ).rejects.toThrow(DomainError)
    expect(updateRating).not.toHaveBeenCalled()
  })

  it('rechaza un averageRating que no es numero ni null', async () => {
    const updateRating = jest.fn()
    const useCase = new UpdateProductRating({ products: buildDeps(updateRating), clock })

    await expect(
      useCase.execute(PRODUCT_ID, { averageRating: 'alto', reviewCount: 1 }),
    ).rejects.toThrow(DomainError)
    expect(updateRating).not.toHaveBeenCalled()
  })
})
