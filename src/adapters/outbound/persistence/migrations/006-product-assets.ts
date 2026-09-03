import type { Db } from 'mongodb'

/**
 * Migración 006: Almacenamiento y metadatos de recursos visuales de Producto (ADR-016 / HU-33.8).
 *
 * Crea la colección `product_assets` con índices de consulta por intención,
 * clave final inmutable, caducidad y asociación a productos.
 */
export const up = async (db: Db): Promise<void> => {
  const existingCollections = await db.listCollections({ name: 'product_assets' }).toArray()

  if (existingCollections.length === 0) {
    await db.createCollection('product_assets', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            '_id',
            'assetId',
            'purpose',
            'status',
            'contentType',
            'contentLength',
            'checksumSha256',
            'stagingKey',
            'imageUrl',
            'createdAt',
            'expiresAt',
          ],
          properties: {
            _id: { bsonType: 'string' },
            assetId: { bsonType: 'string' },
            purpose: { enum: ['PRIMARY_IMAGE'] },
            status: { enum: ['PENDING', 'READY', 'REJECTED', 'EXPIRED'] },
            contentType: { enum: ['image/jpeg', 'image/png', 'image/webp'] },
            contentLength: { bsonType: ['int', 'long'], minimum: 1, maximum: 5242880 },
            checksumSha256: { bsonType: 'string' },
            stagingKey: { bsonType: 'string' },
            targetKey: { bsonType: 'string' },
            width: { bsonType: 'int', minimum: 256, maximum: 4096 },
            height: { bsonType: 'int', minimum: 256, maximum: 4096 },
            imageUrl: { bsonType: 'string' },
            createdAt: { bsonType: 'date' },
            expiresAt: { bsonType: 'date' },
            finalizedAt: { bsonType: 'date' },
            productId: { bsonType: 'string' },
          },
        },
      },
    })
  }

  const collection = db.collection('product_assets')

  await collection.createIndex({ assetId: 1 }, { unique: true, name: 'ux_product_assets_asset_id' })
  await collection.createIndex({ stagingKey: 1 }, { name: 'ix_product_assets_staging_key' })
  await collection.createIndex(
    { targetKey: 1 },
    {
      name: 'ix_product_assets_target_key',
      partialFilterExpression: { targetKey: { $exists: true } },
    },
  )
  await collection.createIndex(
    { status: 1, expiresAt: 1 },
    { name: 'ix_product_assets_status_expires_at' },
  )
  await collection.createIndex(
    { status: 1, productId: 1 },
    { name: 'ix_product_assets_status_product_id' },
  )
}
