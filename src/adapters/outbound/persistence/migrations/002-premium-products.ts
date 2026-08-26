import type { Db } from 'mongodb'

/**
 * Amplia el documento de producto sin exigir los nuevos campos: los productos
 * creados antes de HU-36 siguen siendo no Premium al reconstituirse.
 */
export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'category', 'priceAmount', 'priceCurrency', 'status'],
        additionalProperties: false,
        properties: {
          _id: { bsonType: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' },
          name: { bsonType: 'string', minLength: 3, maxLength: 80 },
          category: { bsonType: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' },
          priceAmount: { bsonType: 'long', minimum: 0 },
          priceCurrency: { enum: ['COP', 'USD', 'EUR'] },
          isPremium: { bsonType: 'bool' },
          realMoneyPriceAmount: { bsonType: 'long', minimum: 0 },
          realMoneyPriceCurrency: { enum: ['COP', 'USD', 'EUR'] },
          status: { enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
        },
      },
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
