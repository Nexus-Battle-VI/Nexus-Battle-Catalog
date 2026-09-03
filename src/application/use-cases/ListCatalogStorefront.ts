import { DomainError } from '../../domain/errors/DomainError'
import { parseProductType } from '../../domain/value-objects/canonical-product-values'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import { STOREFRONT_PAGE_SIZE, type CatalogStorefrontPort } from '../ports/CatalogStorefrontPort'

export interface ListCatalogStorefrontCommand {
  readonly query?: string
  readonly type?: string
  readonly minPrice?: number
  readonly maxPrice?: number
  readonly currency?: string
  readonly page?: number
}

export interface CatalogStorefrontResult {
  readonly items: readonly CanonicalProductDto[]
  readonly page: number
  readonly pageSize: 16
  readonly total: number
}

export class ListCatalogStorefront {
  constructor(private readonly products: CatalogStorefrontPort) {}

  async execute(command: ListCatalogStorefrontCommand): Promise<CatalogStorefrontResult> {
    const page = command.page ?? 1
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger((page - 1) * STOREFRONT_PAGE_SIZE)
    ) {
      throw new DomainError('page debe ser un entero positivo dentro del rango seguro.')
    }
    for (const amount of [command.minPrice, command.maxPrice]) {
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) {
        throw new DomainError('Los precios deben ser enteros no negativos en unidades menores.')
      }
    }
    if (
      command.minPrice !== undefined &&
      command.maxPrice !== undefined &&
      command.minPrice > command.maxPrice
    ) {
      throw new DomainError('minPrice no puede superar maxPrice.')
    }
    if (command.currency !== undefined && !['COP', 'USD', 'EUR'].includes(command.currency)) {
      throw new DomainError('currency debe ser COP, USD o EUR.')
    }
    if (
      (command.minPrice !== undefined || command.maxPrice !== undefined) &&
      command.currency === undefined
    ) {
      throw new DomainError(
        'currency es obligatoria cuando se filtra por precio; no se convierten divisas.',
      )
    }
    const result = await this.products.listStorefront({
      ...command,
      page,
      type: command.type === undefined ? undefined : parseProductType(command.type),
    })
    return {
      items: result.items.map((product) => toCanonicalProductDto(product.toSnapshot())),
      page,
      pageSize: STOREFRONT_PAGE_SIZE,
      total: result.total,
    }
  }
}
