import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'
import type {
  LifecycleStatus,
  ProductType,
} from '../../domain/value-objects/canonical-product-values'
import { STOREFRONT_PAGE_SIZE } from './CatalogStorefrontPort'

/**
 * Tamaño de página de la búsqueda administrativa.
 *
 * Se reutiliza el mismo valor que `ListCatalogStorefront` (16) a propósito: es
 * la misma convención de paginación estable, solo que sin restringir a
 * `lifecycleStatus: ACTIVE`. Dos convenciones distintas de paginación para dos
 * listados tan parecidos solo confundiría a quien integra ambos.
 */
export const ADMIN_PRODUCT_SEARCH_PAGE_SIZE = STOREFRONT_PAGE_SIZE

export interface AdminProductSearchQuery {
  readonly query?: string
  readonly type?: ProductType
  /** Ignorado si `type` tambien viene informado. Vease AdminProductSearchRequest.excludeType. */
  readonly excludeType?: ProductType
  /** Sin filtro, incluye TODOS los estados (ACTIVE y SUSPENDED). */
  readonly lifecycleStatus?: LifecycleStatus
  readonly page: number
}

/**
 * Búsqueda administrativa del catálogo completo (crear/editar/eliminar/buscar
 * productos, pedido explícito del cliente del proyecto).
 *
 * Se declara SEPARADA de `CatalogStorefrontPort`, aunque ambas comparten
 * implementación de infraestructura: la vitrina pública tiene la invariante
 * `lifecycleStatus: ACTIVE` grabada en su contrato (CA de HU-34/HU-35), y este
 * puerto existe justamente para no tener esa invariante. Fusionarlos detrás de
 * un único método con un flag opcional dejaría a cualquier consumidor futuro
 * de la vitrina pública un parámetro con el que podría, por error, filtrar
 * productos suspendidos hacia jugadores.
 */
export interface AdminProductSearchPort {
  searchAdminProducts(query: AdminProductSearchQuery): Promise<{
    readonly items: readonly CanonicalProduct[]
    readonly total: number
  }>
}
