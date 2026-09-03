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
  AvailabilityDecrement,
  CanonicalProductLookupQuery,
  CanonicalProductRepositoryPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'
import { normalizeProductName } from '../../../domain/entities/CanonicalProduct'
import type { CanonicalProduct } from '../../../domain/entities/CanonicalProduct'
import type { ProductId, ProductType } from '../../../domain/value-objects/canonical-product-values'
import {
  STOREFRONT_PAGE_SIZE,
  type CatalogStorefrontPort,
  type CatalogStorefrontQuery,
} from '../../../application/ports/CatalogStorefrontPort'
import { storefrontMatches } from '../../../domain/services/storefront-search'
import {
  toCanonicalDocument,
  toCanonicalProduct,
  toCanonicalSnapshot,
  type CanonicalProductDocument,
} from './canonical-mapping'

/** Escritura canónica aditiva sobre la misma colección que conserva el legado. */
export class MongoCanonicalProductRepository
  implements CanonicalProductRepositoryPort, CatalogStorefrontPort
{
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

  async listStorefront(
    query: CatalogStorefrontQuery,
  ): Promise<{ items: readonly CanonicalProduct[]; total: number }> {
    const filter: Filter<CanonicalProductDocument> = {
      lifecycleStatus: 'ACTIVE',
      type: query.type ?? { $exists: true },
    }
    if (query.currency !== undefined) filter['realMoneyPrice.currency'] = query.currency
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      filter['realMoneyPrice.amount'] = {
        ...(query.minPrice === undefined ? {} : { $gte: Long.fromNumber(query.minPrice) }),
        ...(query.maxPrice === undefined ? {} : { $lte: Long.fromNumber(query.maxPrice) }),
      }
    }
    // One cursor over the server-filtered, stable ordering. Literal matching also
    // covers nested attributes and prices without JavaScript in MongoDB or regex
    // injection. Retain only one page in memory; total counts the complete match.
    // This is not a full-text index: broad text queries scan the filtered set.
    const cursor = this.products.find(filter).sort({ normalizedName: 1, _id: 1 })
    const items: CanonicalProduct[] = []
    const offset = (query.page - 1) * STOREFRONT_PAGE_SIZE
    let total = 0
    try {
      for await (const document of cursor) {
        const product = toCanonicalProduct(document)
        if (!storefrontMatches(product.toSnapshot(), query.query)) continue
        if (total >= offset && items.length < STOREFRONT_PAGE_SIZE) items.push(product)
        total += 1
      }
    } finally {
      await cursor.close()
    }
    return { items, total }
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

  /**
   * Resta UNA unidad en una sola operacion condicionada (HU-34, CA-01).
   *
   * LA CONDICION VIAJA DENTRO DE LA ESCRITURA. `availableUnits: { $gt: 0 }`
   * forma parte del filtro, asi que MongoDB decide y escribe sin soltar el
   * documento. Dos peticiones simultaneas por la ultima unidad: una encuentra
   * documento y la otra no. Leer primero y escribir despues -aunque fuera
   * dentro de una transaccion- dejaria una ventana en la que las dos ven la
   * misma unidad disponible.
   *
   * NO hace falta transaccion para esto. La atomicidad de documento de MongoDB
   * ya lo garantiza, y una transaccion solo anadiria reintentos por conflicto
   * de escritura justo en el punto de mayor contencion.
   *
   * TIRAJE INFINITO NO ESCRIBE NADA. El filtro exige `printRunMode` distinto de
   * `INFINITE`; si no hubo coincidencia se comprueba si el producto es infinito
   * y se devuelve disponibilidad `null` sin haberlo tocado, que es lo que pide
   * CA-03.
   *
   * `null` significa «no habia nada que restar»: el producto no existe o esta
   * agotado. Quien llama traduce eso a 404 o a 409.
   */
  async decrementAvailability(
    productId: ProductId,
    context?: TransactionContext,
  ): Promise<AvailabilityDecrement | null> {
    const session = context?.session ? (context.session as ClientSession) : undefined

    const actualizado = await this.products.findOneAndUpdate(
      {
        _id: productId.value,
        lifecycleStatus: 'ACTIVE',
        printRunMode: { $ne: 'INFINITE' },
        availableUnits: { $gt: Long.fromNumber(0) },
      },
      {
        $inc: { availableUnits: Long.fromNumber(-1), version: Long.fromNumber(1) },
        $set: { updatedAt: new Date() },
      },
      { session, returnDocument: 'after' },
    )

    if (actualizado !== null) {
      const restantes = toCanonicalSnapshot(actualizado).availableUnits

      return { availableUnits: restantes, depleted: restantes === 0 }
    }

    // Sin coincidencia hay tres causas posibles y NO son la misma respuesta:
    // el producto no existe, es infinito -y entonces la adquisicion es valida
    // sin tocar nada- o esta agotado.
    const documento = await this.products.findOne(
      { _id: productId.value, type: { $exists: true } },
      { session },
    )

    if (documento === null) {
      return null
    }

    return documento.lifecycleStatus === 'ACTIVE' && documento.printRunMode === 'INFINITE'
      ? { availableUnits: null, depleted: false }
      : null
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
