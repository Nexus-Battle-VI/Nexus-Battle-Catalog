import {
  Long,
  MongoServerError,
  type ClientSession,
  type Collection,
  type Db,
  type Filter,
} from 'mongodb'

import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
} from '../../../application/errors/ApplicationError'
import type {
  CanonicalProductLookupQuery,
  CanonicalProductRepositoryPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'
import { normalizeProductName } from '../../../domain/entities/CanonicalProduct'
import type { CanonicalProduct } from '../../../domain/entities/CanonicalProduct'
import type { ProductId, ProductType } from '../../../domain/value-objects/canonical-product-values'
import {
  toCanonicalDocument,
  toCanonicalProduct,
  type CanonicalProductDocument,
} from './canonical-mapping'

/** Escritura canónica aditiva sobre la misma colección que conserva el legado. */
export class MongoCanonicalProductRepository implements CanonicalProductRepositoryPort {
  private readonly products: Collection<CanonicalProductDocument>

  constructor(db: Db) {
    this.products = db.collection<CanonicalProductDocument>('products')
  }

  async existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean> {
    const found = await this.products.findOne(
      { normalizedName, type, lifecycleStatus: 'ACTIVE' },
      { projection: { _id: 1 } },
    )

    return found !== null
  }

  async create(product: CanonicalProduct, context?: TransactionContext): Promise<void> {
    const document = toCanonicalDocument(product)

    try {
      const session = context?.session ? (context.session as ClientSession) : undefined
      await this.products.insertOne(document, { session })
    } catch (error: unknown) {
      this.translateDuplicate(error, product)
    }
  }

  async update(
    product: CanonicalProduct,
    expectedVersion: number,
    context?: TransactionContext,
  ): Promise<void> {
    const document = toCanonicalDocument(product)
    const session = context?.session ? (context.session as ClientSession) : undefined

    try {
      const result = await this.products.replaceOne(
        { _id: product.productId.value, version: Long.fromNumber(expectedVersion) },
        document,
        { session },
      )

      if (result.matchedCount === 0) {
        throw new CanonicalProductConcurrencyConflictError(product.productId.value, expectedVersion)
      }
    } catch (error: unknown) {
      if (error instanceof CanonicalProductConcurrencyConflictError) throw error
      this.translateDuplicate(error, product)
    }
  }

  async findTypeById(productId: ProductId): Promise<ProductType | null> {
    const document = await this.products.findOne(
      { _id: productId.value, type: { $exists: true } },
      { projection: { type: 1 } },
    )

    return document?.type ?? null
  }

  async findById(productId: ProductId): Promise<CanonicalProduct | null> {
    const document = await this.products.findOne({
      _id: productId.value,
      type: { $exists: true },
    })

    return document === null ? null : toCanonicalProduct(document)
  }

  /**
   * Resuelve un producto canónico por `productId` (`_id`) o por su alias `sku`.
   * `type: { $exists: true }` deja fuera los documentos heredados que comparten
   * la colección. El `$or` por igualdad exacta es elegible para los índices
   * `_id` y `uniq_products_sku` existentes; no hace falta ninguno nuevo.
   */
  async findByReference(reference: string): Promise<CanonicalProduct | null> {
    const document = await this.products.findOne({
      type: { $exists: true },
      $or: [{ _id: reference }, { sku: reference }],
    })

    return document === null ? null : toCanonicalProduct(document)
  }

  /**
   * Resuelve muchas referencias en UNA consulta.
   *
   * La consulta a Mongo es un lookup PURO por referencia (`_id` o `sku` en la
   * lista): es elegible para los índices `_id` y `uniq_products_sku` y acota el
   * universo a lo que el consumidor posee (Inventory tiene como máximo 200
   * ranuras). El filtrado por nombre y por tipo se hace DESPUÉS, en memoria,
   * sobre ese conjunto ya pequeño: no es un índice de texto y no se describe
   * como tal. Así la búsqueda nunca puede devolver un producto fuera del
   * conjunto pedido y no se añade infraestructura de búsqueda para 200
   * referencias.
   */
  async findByReferences(query: CanonicalProductLookupQuery): Promise<readonly CanonicalProduct[]> {
    const references = [...query.references]

    const filter: Filter<CanonicalProductDocument> = {
      type: { $exists: true },
      $or: [{ _id: { $in: references } }, { sku: { $in: references } }],
    }

    const documents = await this.products.find(filter).toArray()

    // Substring literal sobre el nombre normalizado; `String.includes` no
    // interpreta metacaracteres, así que no hace falta escapar nada.
    const wantedName =
      query.nameQuery === undefined ? undefined : normalizeProductName(query.nameQuery)

    return documents
      .filter((document) => {
        if (query.type !== undefined && document.type !== query.type) {
          return false
        }
        if (wantedName !== undefined && !document.normalizedName.includes(wantedName)) {
          return false
        }
        return true
      })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((document) => toCanonicalProduct(document))
  }

  private translateDuplicate(error: unknown, product: CanonicalProduct): never {
    if (!(error instanceof MongoServerError) || error.code !== 11000) {
      throw error
    }

    const keyPattern = error.keyPattern as Record<string, unknown> | undefined

    if (keyPattern?.sku !== undefined) {
      throw new CanonicalProductSkuAlreadyExistsError(product.sku.value)
    }

    if (keyPattern?.normalizedName !== undefined || keyPattern?.type !== undefined) {
      throw new CanonicalProductAlreadyExistsError(product.name.value, product.type)
    }

    if (keyPattern?._id !== undefined) {
      throw new CanonicalProductIdentityAlreadyExistsError(product.productId.value)
    }

    // Una nueva restricción única no debe convertirse silenciosamente en el
    // error equivocado. Si no reconocemos el índice, conservamos el error real.
    throw error
  }
}
