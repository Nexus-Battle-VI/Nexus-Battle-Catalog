import { randomUUID } from 'node:crypto'
import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { MongoClient, type Db } from 'mongodb'
import { MongoProductAssetRepository } from '../../src/adapters/outbound/persistence/MongoProductAssetRepository'
import { up } from '../../src/adapters/outbound/persistence/migrations/006-product-assets'
import { AssetPurpose, ProductAsset } from '../../src/domain/entities/ProductAsset'

/** Ejerce BSON y el validador reales: un mock de insertOne no reproduce undefined -> null. */
describe('Metadatos opcionales de imágenes en MongoDB', () => {
  let container: StartedMongoDBContainer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined
  let repository: MongoProductAssetRepository
  const pending = (): ProductAsset =>
    ProductAsset.createPending({
      assetId: randomUUID(),
      purpose: AssetPurpose.PrimaryImage,
      contentType: 'image/png',
      contentLength: 1024,
      checksumSha256: 'b64:test',
      stagingKey: `staging/${randomUUID()}`,
      imageUrl: 'https://nexus.example/api/v1/catalog/product-assets/test/content',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 600000),
    })
  beforeAll(async () => {
    let uri = process.env.CATALOG_TEST_MONGODB_URI
    if (!uri) {
      container = await new MongoDBContainer('mongo:8.0').start()
      uri = `${container.getConnectionString()}/?directConnection=true`
    }
    client = new MongoClient(uri)
    await client.connect()
    db = client.db(`catalog_asset_test_${randomUUID().replaceAll('-', '')}`)
    await up(db)
    repository = new MongoProductAssetRepository(db)
  }, 180000)
  afterAll(async () => {
    await db?.dropDatabase()
    await client?.close()
    await container?.stop()
  })
  it('persiste una intención pendiente sin metadatos nulos y permite expirar la intención', async () => {
    const asset = pending()
    await repository.save(asset)
    const stored = await db!.collection('product_assets').findOne({ assetId: asset.assetId })
    for (const field of ['targetKey', 'width', 'height', 'finalizedAt', 'productId'])
      expect(stored).not.toHaveProperty(field)
    expect((await repository.findById(asset.assetId))?.status).toBe('PENDING')
    asset.markExpired()
    await repository.update(asset)
    expect((await repository.findById(asset.assetId))?.status).toBe('EXPIRED')
  })
  it('finaliza, encuentra imágenes huérfanas y conserva la asociación al producto', async () => {
    const asset = pending()
    await repository.save(asset)
    asset.markFinalized({
      targetKey: `assets/${asset.assetId}/image.png`,
      width: 512,
      height: 512,
      finalizedAt: new Date(),
    })
    await repository.update(asset)
    expect(
      (await repository.findUnassociatedReadyAssets(new Date(Date.now() + 1000))).map(
        (a) => a.assetId,
      ),
    ).toContain(asset.assetId)
    const productId = randomUUID()
    await repository.associateProduct(asset.assetId, productId)
    const associated = await repository.findById(asset.assetId)
    expect(associated?.toSnapshot()).toMatchObject({
      status: 'READY',
      width: 512,
      height: 512,
      productId,
    })
    await repository.update(associated!)
    expect(
      (await repository.findUnassociatedReadyAssets(new Date(Date.now() + 1000))).map(
        (a) => a.assetId,
      ),
    ).not.toContain(asset.assetId)
  })
  it('el esquema real rechaza undefined serializado como null: reproduce el error anterior', async () => {
    const asset = pending()
    await repository.save(asset)
    await expect(
      db!
        .collection('product_assets')
        .updateOne({ assetId: asset.assetId }, { $set: { width: undefined } }),
    ).rejects.toMatchObject({ code: 121 })
  })
})
