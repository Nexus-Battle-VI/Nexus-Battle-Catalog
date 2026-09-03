import { parseProductType } from '../../domain/value-objects/canonical-product-values'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import { CanonicalProductNotFoundError } from '../errors/ApplicationError'
import type { CanonicalProductReadPort } from '../ports/CanonicalProductPorts'

/**
 * Número máximo de referencias que `LookupCanonicalProducts` acepta en una sola
 * llamada. Cubre con margen el inventario máximo que el dominio de
 * Player/Inventory admite (200 ranuras) y acota el tamaño de la consulta.
 */
export const MAX_LOOKUP_REFERENCES = 500

/**
 * Recupera un producto canónico por su identidad `productId` (UUID) o por su
 * alias `sku`. Devuelve la información vigente, incluida `lifecycleStatus`, para
 * cualquier estado del ciclo de vida: un producto SUSPENDED sigue siendo
 * consultable porque un jugador puede poseerlo.
 */
export class GetCanonicalProduct {
  private readonly products: CanonicalProductReadPort

  constructor(products: CanonicalProductReadPort) {
    this.products = products
  }

  async execute(reference: string): Promise<CanonicalProductDto> {
    const normalized = reference.trim()
    const product = await this.products.findByReference(normalized)

    if (product === null) {
      throw new CanonicalProductNotFoundError(normalized)
    }

    return toCanonicalProductDto(product.toSnapshot())
  }
}

export interface LookupCanonicalProductsCommand {
  readonly references: readonly string[]
  readonly query?: string
  readonly type?: string
}

export interface LookupCanonicalProductsResult {
  readonly items: readonly CanonicalProductDto[]
}

/**
 * Resuelve varios productos canónicos en UNA sola consulta, restringidos al
 * conjunto de referencias que el consumidor envía. Es la vía sin N+1 para
 * enriquecer un listado y para la búsqueda por nombre de HU-27: la búsqueda
 * nunca puede devolver un producto fuera del conjunto pedido.
 *
 * Las referencias que no existen se omiten del resultado; no es un error.
 */
export class LookupCanonicalProducts {
  private readonly products: CanonicalProductReadPort

  constructor(products: CanonicalProductReadPort) {
    this.products = products
  }

  async execute(command: LookupCanonicalProductsCommand): Promise<LookupCanonicalProductsResult> {
    const references = [
      ...new Set(command.references.map((reference) => reference.trim()).filter(Boolean)),
    ]

    if (references.length === 0) {
      return { items: [] }
    }

    const nameQuery = command.query?.trim()
    const found = await this.products.findByReferences({
      references,
      nameQuery: nameQuery !== undefined && nameQuery.length > 0 ? nameQuery : undefined,
      type: command.type === undefined ? undefined : parseProductType(command.type),
    })

    return { items: found.map((product) => toCanonicalProductDto(product.toSnapshot())) }
  }
}
