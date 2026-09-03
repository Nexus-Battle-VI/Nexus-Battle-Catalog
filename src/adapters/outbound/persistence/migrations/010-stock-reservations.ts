import type { Db } from 'mongodb'

/** Durable reservation identities have no TTL: Commerce explicitly completes or releases them. */
export const up = async (db: Db): Promise<void> => {
  const existing = await db.listCollections({ name: 'stock_reservations' }).toArray()
  if (existing.length === 0) {
    await db.createCollection('stock_reservations', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: false,
          required: ['_id', 'playerId', 'lines', 'state', 'createdAt', 'updatedAt'],
          properties: {
            _id: { bsonType: 'string' },
            playerId: { bsonType: 'string', minLength: 1 },
            state: { enum: ['RESERVED', 'CONFIRMED', 'RELEASED', 'REJECTED'] },
            rejection: {
              bsonType: 'object',
              additionalProperties: false,
              required: ['kind', 'message'],
              properties: {
                kind: { enum: ['MISSING_PRODUCT', 'UNAVAILABLE'] },
                message: { bsonType: 'string' },
              },
            },
            createdAt: { bsonType: 'date' },
            updatedAt: { bsonType: 'date' },
            lines: {
              bsonType: 'array',
              minItems: 1,
              items: {
                bsonType: 'object',
                additionalProperties: false,
                required: ['productId', 'quantity'],
                properties: {
                  productId: { bsonType: 'string' },
                  quantity: { bsonType: 'long', minimum: 1, maximum: 9999 },
                },
              },
            },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }
  await db
    .collection('stock_reservations')
    .createIndex({ state: 1, updatedAt: 1 }, { name: 'idx_stock_reservations_recovery' })
  await db
    .collection('products')
    .createIndex(
      { lifecycleStatus: 1, normalizedName: 1, _id: 1 },
      { name: 'idx_products_storefront_order' },
    )
}
