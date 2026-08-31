import { Long } from 'mongodb'

import {
  CanonicalProduct,
  type CanonicalProductSnapshot,
} from '../../../domain/entities/CanonicalProduct'
import {
  parseProductAttributes,
  type ProductAttributes,
} from '../../../domain/value-objects/product-attributes'
import {
  CreditsPrice,
  LifecycleStatus,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  parseProductType,
  type PrintRunMode,
  type ProductType,
} from '../../../domain/value-objects/canonical-product-values'
import { Money, ProductName, Sku } from '../../../domain/value-objects/catalog-values'
import { PersistenceMappingError } from './mapping'

export interface CanonicalProductDocument {
  readonly _id: string
  readonly sku: string
  readonly name: string
  readonly normalizedName: string
  readonly description: string
  readonly imageUrl: string
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: Long
  readonly printRunMode: PrintRunMode
  readonly lifecycleStatus: LifecycleStatus
  readonly creditsPrice: Long
  readonly premium: boolean
  readonly realMoneyPrice: {
    readonly amount: Long
    readonly currency: string
  } | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

const toExactInteger = (value: Long, field: string, productId: string): number => {
  const raw = value.toString()
  const parsed = Number(raw)

  if (!Number.isSafeInteger(parsed) || String(parsed) !== raw) {
    throw new PersistenceMappingError(
      `El producto ${productId} tiene ${field} fuera del rango entero seguro: "${raw}".`,
    )
  }

  return parsed
}

const toLong = (value: number, field: string, productId: string): Long => {
  if (!Number.isSafeInteger(value)) {
    throw new PersistenceMappingError(
      `El producto ${productId} tiene ${field} fuera del rango entero seguro: ${String(value)}.`,
    )
  }

  return Long.fromNumber(value)
}

/** Traduce explícitamente el agregado canónico a un único documento MongoDB. */
export const toCanonicalDocument = (product: CanonicalProduct): CanonicalProductDocument => {
  const snapshot = product.toSnapshot()

  return {
    _id: snapshot.productId,
    sku: snapshot.sku,
    name: snapshot.name,
    normalizedName: snapshot.normalizedName,
    description: snapshot.description,
    imageUrl: snapshot.imageUrl,
    type: snapshot.type,
    attributes: snapshot.attributes,
    printRun: toLong(snapshot.printRun, 'printRun', snapshot.productId),
    printRunMode: snapshot.printRunMode,
    lifecycleStatus: snapshot.lifecycleStatus,
    creditsPrice: toLong(snapshot.creditsPrice, 'creditsPrice', snapshot.productId),
    premium: snapshot.premium,
    realMoneyPrice:
      snapshot.realMoneyPrice === null
        ? null
        : {
            amount: toLong(
              snapshot.realMoneyPrice.amount,
              'realMoneyPrice.amount',
              snapshot.productId,
            ),
            currency: snapshot.realMoneyPrice.currency,
          },
    createdAt: new Date(snapshot.createdAt),
    updatedAt: new Date(snapshot.updatedAt),
  }
}

/**
 * Proyecta un documento leído sin exponer tipos BSON fuera del adaptador.
 * La reconstrucción de comportamiento del agregado se añadirá cuando exista
 * un caso de uso canónico de lectura; #134 solo requiere escritura y referencias.
 */
export const toCanonicalSnapshot = (
  document: CanonicalProductDocument,
): CanonicalProductSnapshot => ({
  productId: document._id,
  sku: document.sku,
  name: document.name,
  normalizedName: document.normalizedName,
  description: document.description,
  imageUrl: document.imageUrl,
  type: document.type,
  attributes: document.attributes,
  printRun: toExactInteger(document.printRun, 'printRun', document._id),
  printRunMode: document.printRunMode,
  lifecycleStatus: document.lifecycleStatus,
  creditsPrice: toExactInteger(document.creditsPrice, 'creditsPrice', document._id),
  premium: document.premium,
  realMoneyPrice:
    document.realMoneyPrice === null
      ? null
      : {
          amount: toExactInteger(
            document.realMoneyPrice.amount,
            'realMoneyPrice.amount',
            document._id,
          ),
          currency: document.realMoneyPrice.currency,
        },
  createdAt: document.createdAt.toISOString(),
  updatedAt: document.updatedAt.toISOString(),
})

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const withoutDerivedStackable = (raw: unknown, productId: string): unknown => {
  const effect = asRecord(raw)

  if (effect === null) return raw
  if (effect.stackable !== false) {
    throw new PersistenceMappingError(
      `El producto ${productId} no conserva stackable=false en un efecto V1.`,
    )
  }

  const input = { ...effect }
  delete input.stackable

  return input
}

/**
 * El parser de dominio recibe la forma de creación, donde los campos readOnly
 * no existen. Al hidratar se comprueba primero su valor persistido y después se
 * retiran para volver a ejecutar el mismo parser cerrado de schemaVersion 1.
 */
const parsePersistedAttributes = (
  raw: ProductAttributes,
  type: ProductType,
  productId: string,
): ProductAttributes => {
  const candidate = structuredClone(raw) as unknown
  const envelope = asRecord(candidate)
  const values = asRecord(envelope?.values)

  if (values !== null) {
    if (Array.isArray(values.effects)) {
      values.effects = values.effects.map((effect) => withoutDerivedStackable(effect, productId))
    }

    if (values.generalEffect !== undefined) {
      values.generalEffect = withoutDerivedStackable(values.generalEffect, productId)
    }
    if (values.specificEffect !== undefined) {
      values.specificEffect = withoutDerivedStackable(values.specificEffect, productId)
    }

    if (values.kind === 'HABILIDAD') {
      if (values.chargeTurns !== 1) {
        throw new PersistenceMappingError(
          `El producto ${productId} no conserva chargeTurns=1 para HABILIDAD V1.`,
        )
      }
      delete values.chargeTurns
    }

    if (values.kind === 'EPICA') {
      if (values.powerCost !== 0 || values.cooldownTurns !== 2) {
        throw new PersistenceMappingError(
          `El producto ${productId} no conserva powerCost=0 y cooldownTurns=2 para EPICA V1.`,
        )
      }
      delete values.powerCost
      delete values.cooldownTurns
    }
  }

  try {
    return parseProductAttributes(candidate, type)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new PersistenceMappingError(
      `El producto ${productId} contiene atributos persistidos inválidos: ${detail}`,
    )
  }
}

/** Reconstruye el agregado y vuelve a ejecutar sus invariantes al leer MongoDB. */
export const toCanonicalProduct = (document: CanonicalProductDocument): CanonicalProduct => {
  try {
    const snapshot = toCanonicalSnapshot(document)
    const type = parseProductType(snapshot.type)
    const printRun = PrintRun.create(snapshot.printRun)

    if (printRun.mode !== snapshot.printRunMode) {
      throw new PersistenceMappingError(
        `El producto ${snapshot.productId} tiene printRunMode incompatible con printRun.`,
      )
    }

    const lifecycleStatuses: readonly string[] = Object.values(LifecycleStatus)
    if (!lifecycleStatuses.includes(snapshot.lifecycleStatus)) {
      throw new PersistenceMappingError(
        `El producto ${snapshot.productId} tiene lifecycleStatus desconocido.`,
      )
    }

    const createdAt = new Date(snapshot.createdAt)
    const updatedAt = new Date(snapshot.updatedAt)
    if (updatedAt.getTime() < createdAt.getTime()) {
      throw new PersistenceMappingError(
        `El producto ${snapshot.productId} tiene updatedAt anterior a createdAt.`,
      )
    }

    const product = CanonicalProduct.restore({
      productId: ProductId.create(snapshot.productId),
      sku: Sku.create(snapshot.sku),
      name: ProductName.create(snapshot.name),
      imageUrl: ProductImageUrl.create(snapshot.imageUrl),
      description: ProductDescription.create(snapshot.description),
      type,
      attributes: parsePersistedAttributes(document.attributes, type, snapshot.productId),
      printRun,
      pricing: ProductPricing.create({
        creditsPrice: CreditsPrice.create(snapshot.creditsPrice),
        premium: snapshot.premium,
        realMoneyPrice:
          snapshot.realMoneyPrice === null
            ? null
            : Money.create(snapshot.realMoneyPrice.amount, snapshot.realMoneyPrice.currency),
      }),
      lifecycleStatus: snapshot.lifecycleStatus,
      createdAt,
      updatedAt,
    })

    if (product.normalizedName !== snapshot.normalizedName) {
      throw new PersistenceMappingError(
        `El producto ${snapshot.productId} tiene normalizedName inconsistente con name.`,
      )
    }

    return product
  } catch (error: unknown) {
    if (error instanceof PersistenceMappingError) throw error

    const detail = error instanceof Error ? error.message : String(error)
    throw new PersistenceMappingError(
      `No se pudo reconstruir el producto canónico ${document._id}: ${detail}`,
    )
  }
}
