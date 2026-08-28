import type { Db } from 'mongodb'

/**
 * Alinea el validador de MongoDB con las invariantes Premium del agregado.
 *
 * Es una migracion nueva, en lugar de modificar 002: los despliegues que ya
 * registraron aquella migracion necesitan ejecutar este `collMod` para recibir
 * la correccion. Los documentos legados siguen siendo validos mientras omitan
 * juntos la bandera y el precio real.
 */
export const up = async (db: Db): Promise<void> => {
  await db.command({
    collMod: 'products',
    validator: {
      $and: [
        {
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
              realMoneyPriceAmount: { bsonType: 'long', minimum: 1 },
              realMoneyPriceCurrency: { enum: ['COP', 'USD', 'EUR'] },
              status: { enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
            },
          },
        },
        {
          $or: [
            {
              isPremium: { $exists: false },
              realMoneyPriceAmount: { $exists: false },
              realMoneyPriceCurrency: { $exists: false },
            },
            {
              isPremium: false,
              realMoneyPriceAmount: { $exists: false },
              realMoneyPriceCurrency: { $exists: false },
            },
            {
              isPremium: true,
              realMoneyPriceAmount: { $type: 'long', $gt: 0 },
              realMoneyPriceCurrency: { $in: ['COP', 'USD', 'EUR'] },
            },
          ],
        },
      ],
    },
    validationLevel: 'strict',
    validationAction: 'error',
  })
}
