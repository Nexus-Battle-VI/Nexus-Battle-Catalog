import { Long, type Db } from 'mongodb'

const SKU_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const CURRENCIES = ['COP', 'USD', 'EUR']
const PRODUCT_TYPES = ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA']
const OUTBOX_STATUSES = ['PENDING', 'IN_FLIGHT', 'DISPATCHED', 'DEAD']

/**
 * Migración 005: Atomicidad de Producto, auditoría y outbox (ADR-015 / EN-027.6, 7, 8).
 *
 * 1. Añade `version` a los productos canónicos para control de concurrencia optimista.
 * 2. Crea la colección `audit_log` para auditoría insert-only e inmutable.
 * 3. Crea la colección `outbox` para el patrón transactional outbox con reclamación por lease.
 */
export const up = async (db: Db): Promise<void> => {
  // 1. Backfill seguro de `version: 0` en documentos canónicos existentes si los hubiera
  await db.collection('products').updateMany(
    { type: { $exists: true }, version: { $exists: false } },
    { $set: { version: Long.fromNumber(0) } },
  )

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
            'version',
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
            version: { bsonType: 'long', minimum: 0 },
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

  // 2. Creación y validación de `audit_log`
  const collections = await db.listCollections().toArray()
  const collectionNames = new Set(collections.map((c) => c.name))

  if (!collectionNames.has('audit_log')) {
    await db.createCollection('audit_log', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            '_id',
            'eventId',
            'aggregateId',
            'aggregateType',
            'action',
            'actor',
            'timestamp',
            'snapshot',
          ],
          additionalProperties: true,
          properties: {
            _id: { bsonType: 'string', pattern: UUID_PATTERN },
            eventId: { bsonType: 'string', pattern: UUID_PATTERN },
            aggregateId: { bsonType: 'string' },
            aggregateType: { bsonType: 'string' },
            action: { bsonType: 'string' },
            actor: {
              bsonType: 'object',
              required: ['subject'],
              properties: {
                subject: { bsonType: 'string' },
                role: { bsonType: 'string' },
                email: { bsonType: 'string' },
              },
            },
            timestamp: { bsonType: 'date' },
            snapshot: { bsonType: 'object' },
            delta: { bsonType: 'object' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }

  const auditLog = db.collection('audit_log')
  await auditLog.createIndex({ eventId: 1 }, { name: 'uniq_audit_log_event_id', unique: true })
  await auditLog.createIndex(
    { aggregateId: 1, timestamp: -1 },
    { name: 'idx_audit_log_aggregate_timestamp' },
  )

  // 3. Creación y validación de `outbox`
  if (!collectionNames.has('outbox')) {
    await db.createCollection('outbox', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            '_id',
            'eventId',
            'aggregateId',
            'aggregateType',
            'eventType',
            'eventVersion',
            'status',
            'payload',
            'createdAt',
            'updatedAt',
            'attempts',
          ],
          additionalProperties: true,
          properties: {
            _id: { bsonType: 'string', pattern: UUID_PATTERN },
            eventId: { bsonType: 'string', pattern: UUID_PATTERN },
            aggregateId: { bsonType: 'string' },
            aggregateType: { bsonType: 'string' },
            eventType: { bsonType: 'string' },
            eventVersion: { bsonType: 'int', minimum: 1 },
            status: { enum: OUTBOX_STATUSES },
            payload: { bsonType: 'object' },
            createdAt: { bsonType: 'date' },
            updatedAt: { bsonType: 'date' },
            claimedBy: { bsonType: ['string', 'null'] },
            leaseExpiresAt: { bsonType: ['date', 'null'] },
            attempts: { bsonType: 'int', minimum: 0 },
            lastError: { bsonType: ['string', 'null'] },
            dispatchedAt: { bsonType: ['date', 'null'] },
            purgeAt: { bsonType: ['date', 'null'] },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }

  const outbox = db.collection('outbox')
  await outbox.createIndex({ eventId: 1 }, { name: 'uniq_outbox_event_id', unique: true })
  await outbox.createIndex(
    { status: 1, leaseExpiresAt: 1, createdAt: 1 },
    { name: 'idx_outbox_claiming' },
  )
  await outbox.createIndex(
    { purgeAt: 1 },
    { name: 'idx_outbox_purge', partialFilterExpression: { purgeAt: { $type: 'date' } } },
  )
}
