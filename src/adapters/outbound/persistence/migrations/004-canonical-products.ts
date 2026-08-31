import type { Db } from 'mongodb'

const SKU_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const CURRENCIES = ['COP', 'USD', 'EUR']
const PRODUCT_TYPES = ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA']

/**
 * Amplía `products` con el documento canónico sin invalidar la forma heredada.
 * Las dos formas son deliberadamente explícitas y cerradas: coexistencia no
 * significa aceptar documentos híbridos.
 */
export const up = async (db: Db): Promise<void> => {
  const legacySchema = {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'name', 'category', 'priceAmount', 'priceCurrency', 'status'],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string', pattern: SKU_PATTERN },
            sku: { bsonType: 'string', pattern: SKU_PATTERN },
            name: { bsonType: 'string', minLength: 3, maxLength: 80 },
            category: { bsonType: 'string', pattern: SKU_PATTERN },
            priceAmount: { bsonType: 'long', minimum: 0 },
            priceCurrency: { enum: CURRENCIES },
            isPremium: { bsonType: 'bool' },
            realMoneyPriceAmount: { bsonType: 'long', minimum: 1 },
            realMoneyPriceCurrency: { enum: CURRENCIES },
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
            realMoneyPriceCurrency: { $in: CURRENCIES },
          },
        ],
      },
    ],
  }

  const canonicalSchema = {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            '_id',
            'sku',
            'name',
            'normalizedName',
            'description',
            'imageUrl',
            'type',
            'attributes',
            'printRun',
            'printRunMode',
            'lifecycleStatus',
            'creditsPrice',
            'premium',
            'realMoneyPrice',
            'createdAt',
            'updatedAt',
          ],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string', pattern: UUID_PATTERN },
            sku: { bsonType: 'string', pattern: SKU_PATTERN },
            name: { bsonType: 'string', minLength: 3, maxLength: 80 },
            normalizedName: { bsonType: 'string', minLength: 3, maxLength: 80 },
            description: { bsonType: 'string', minLength: 1 },
            imageUrl: { bsonType: 'string', minLength: 1 },
            type: { enum: PRODUCT_TYPES },
            attributes: {
              bsonType: 'object',
              required: ['schemaVersion', 'values'],
              additionalProperties: false,
              properties: {
                schemaVersion: { enum: ['1'] },
                values: {
                  bsonType: 'object',
                  required: ['kind'],
                  properties: { kind: { enum: PRODUCT_TYPES } },
                },
              },
            },
            printRun: { bsonType: 'long' },
            printRunMode: { enum: ['UNIQUE', 'LIMITED', 'INFINITE'] },
            lifecycleStatus: { enum: ['ACTIVE', 'SUSPENDED'] },
            creditsPrice: { bsonType: 'long', minimum: 0 },
            premium: { bsonType: 'bool' },
            realMoneyPrice: {
              bsonType: ['object', 'null'],
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { bsonType: 'long', minimum: 1 },
                currency: { enum: CURRENCIES },
              },
            },
            createdAt: { bsonType: 'date' },
            updatedAt: { bsonType: 'date' },
          },
        },
      },
      { $expr: { $eq: ['$type', '$attributes.values.kind'] } },
      {
        $or: [
          { printRun: -1, printRunMode: 'INFINITE' },
          { printRun: 1, printRunMode: 'UNIQUE' },
          { printRun: { $gte: 2 }, printRunMode: 'LIMITED' },
        ],
      },
      {
        $or: [
          { premium: false, realMoneyPrice: null },
          {
            premium: true,
            'realMoneyPrice.amount': { $type: 'long', $gt: 0 },
            'realMoneyPrice.currency': { $in: CURRENCIES },
          },
        ],
      },
    ],
  }

  await db.command({
    collMod: 'products',
    validator: { $or: [legacySchema, canonicalSchema] },
    validationLevel: 'strict',
    validationAction: 'error',
  })

  const products = db.collection('products')

  await products.createIndex(
    { sku: 1 },
    {
      name: 'uniq_products_sku',
      unique: true,
      partialFilterExpression: { sku: { $type: 'string' } },
    },
  )
  await products.createIndex(
    { normalizedName: 1, type: 1 },
    {
      name: 'uniq_active_product_name_type',
      unique: true,
      partialFilterExpression: {
        normalizedName: { $type: 'string' },
        type: { $type: 'string' },
        lifecycleStatus: 'ACTIVE',
      },
    },
  )
}
