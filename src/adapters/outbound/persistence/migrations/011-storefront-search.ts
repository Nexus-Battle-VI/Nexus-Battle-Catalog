import type { Db } from 'mongodb'
import { toCanonicalSnapshot, type CanonicalProductDocument } from '../canonical-mapping'
import {
  SEARCH_BUCKETS,
  STOREFRONT_SEARCH_INDEX,
  storefrontProjection,
} from '../storefront-search-projection'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const canonicalSchema = (value: unknown): Record<string, unknown> | null => {
  const node = record(value)
  if (node === null) return null
  const schema = record(node.$jsonSchema)
  const properties = record(schema?.properties)
  if (schema !== null && properties?.normalizedName !== undefined && properties.type !== undefined)
    return schema
  for (const child of Object.values(node)) {
    for (const branch of Array.isArray(child) ? child : [child]) {
      const found = canonicalSchema(branch)
      if (found !== null) return found
    }
  }
  return null
}

/** Maintenance-window migration: old canonical writers must stop before backfill. */
export const up = async (db: Db): Promise<void> => {
  const info = await db.listCollections({ name: 'products' }).next()
  if (info === null || !('options' in info)) throw new Error('Products collection is missing.')
  const validator: unknown = structuredClone(info.options?.validator)
  const schema = canonicalSchema(validator)
  const properties = record(schema?.properties)
  if (schema === null || properties === null)
    throw new Error('Canonical products validator is missing.')
  properties.storefrontSearchText = { bsonType: 'string' }
  properties.storefrontSearchTokens = {
    bsonType: 'array',
    maxItems: SEARCH_BUCKETS,
    uniqueItems: true,
    items: { bsonType: 'int', minimum: 0, maximum: SEARCH_BUCKETS - 1 },
  }
  const apply = () =>
    db.command({
      collMod: 'products',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    })
  await apply()
  const products = db.collection<CanonicalProductDocument>('products')
  for await (const product of products.find({ type: { $exists: true } })) {
    await products.updateOne(
      { _id: product._id },
      { $set: storefrontProjection(toCanonicalSnapshot(product)) },
    )
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field: unknown): field is string => typeof field === 'string')
    : []
  schema.required = [...new Set([...required, 'storefrontSearchText', 'storefrontSearchTokens'])]
  await apply()
  await products.createIndex(
    { storefrontSearchTokens: 1, lifecycleStatus: 1 },
    { name: STOREFRONT_SEARCH_INDEX, partialFilterExpression: { type: { $exists: true } } },
  )
}
