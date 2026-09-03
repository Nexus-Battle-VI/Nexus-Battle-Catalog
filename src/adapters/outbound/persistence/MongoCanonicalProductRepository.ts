import { Long, MongoServerError, type ClientSession, type Collection, type Db } from 'mongodb'

import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductSkuAlreadyExistsError,
} from '../../../application/errors/ApplicationError'
import type {
  CanonicalProductRepositoryPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'
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
