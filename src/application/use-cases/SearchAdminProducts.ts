import { DomainError } from '../../domain/errors/DomainError'
import {
  LifecycleStatus,
  parseProductType,
} from '../../domain/value-objects/canonical-product-values'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import {
  ADMIN_PRODUCT_SEARCH_PAGE_SIZE,
  type AdminProductSearchPort,
} from '../ports/AdminProductSearchPort'

export interface SearchAdminProductsCommand {
  readonly query?: string
  readonly type?: string
  readonly lifecycleStatus?: string
  readonly page?: number
}

export interface AdminProductSearchResult {
  readonly items: readonly CanonicalProductDto[]
  readonly page: number
  readonly pageSize: number
  readonly total: number
}

const LIFECYCLE_STATUSES: readonly string[] = Object.values(LifecycleStatus)

/**
 * Búsqueda/listado administrativo del catálogo completo (crear, editar,
 * eliminar y buscar productos, HU pedida directamente por el cliente del
 * proyecto).
 *
 * A DIFERENCIA de `ListCatalogStorefront`, no fija `lifecycleStatus: ACTIVE`:
 * un administrador necesita encontrar tambien los productos suspendidos -por
 * ejemplo para reactivarlos-, que es justo lo que la vitrina publica no debe
 * mostrar nunca. `lifecycleStatus` aqui es un FILTRO OPCIONAL, no una
 * invariante del listado.
 *
 * Mismo criterio de validacion de forma que `ListCatalogStorefront`: pagina
 * segura, y aqui ademas `lifecycleStatus` contra el enum del dominio.
 */
export class SearchAdminProducts {
  constructor(private readonly products: AdminProductSearchPort) {}

  async execute(command: SearchAdminProductsCommand): Promise<AdminProductSearchResult> {
    const page = command.page ?? 1

    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger((page - 1) * ADMIN_PRODUCT_SEARCH_PAGE_SIZE)
    ) {
      throw new DomainError('page debe ser un entero positivo dentro del rango seguro.')
    }

    if (
      command.lifecycleStatus !== undefined &&
      !LIFECYCLE_STATUSES.includes(command.lifecycleStatus)
    ) {
      throw new DomainError(`lifecycleStatus debe ser uno de: ${LIFECYCLE_STATUSES.join(', ')}.`)
    }

    const result = await this.products.searchAdminProducts({
      query: command.query,
      type: command.type === undefined ? undefined : parseProductType(command.type),
      lifecycleStatus: command.lifecycleStatus as LifecycleStatus | undefined,
      page,
    })

    return {
      items: result.items.map((product) => toCanonicalProductDto(product.toSnapshot())),
      page,
      pageSize: ADMIN_PRODUCT_SEARCH_PAGE_SIZE,
      total: result.total,
    }
  }
}
