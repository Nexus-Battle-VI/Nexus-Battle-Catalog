import type { Db } from 'mongodb'
import {
  MongoProductAssetRepository,
  type ProductAssetDocument,
} from '../../src/adapters/outbound/persistence/MongoProductAssetRepository'
import { AssetPurpose, ProductAsset } from '../../src/domain/entities/ProductAsset'
import { up as migration006Up } from '../../src/adapters/outbound/persistence/migrations/006-product-assets'

describe('MongoProductAssetRepository & Migration 006', () => {
  let mockDocs: ProductAssetDocument[]
  let mockIndexes: { spec: unknown; opts: unknown }[]
  let createCollectionMock: jest.Mock
  let mockDb: Db
  let repository: MongoProductAssetRepository

  beforeEach(() => {
    mockDocs = []
    mockIndexes = []

    const mockCollection = {
      insertOne: jest.fn((doc: ProductAssetDocument) => {
        mockDocs.push({ ...doc })
        return Promise.resolve({ acknowledged: true })
      }),
      findOne: jest.fn((filter: { _id?: string; stagingKey?: string; targetKey?: string }) => {
        if (filter._id) {
          return Promise.resolve(mockDocs.find((d) => d._id === filter._id) ?? null)
        }
        if (filter.stagingKey) {
          return Promise.resolve(mockDocs.find((d) => d.stagingKey === filter.stagingKey) ?? null)
        }
        if (filter.targetKey) {
          return Promise.resolve(mockDocs.find((d) => d.targetKey === filter.targetKey) ?? null)
        }
        return Promise.resolve(null)
      }),
      replaceOne: jest.fn((filter: { _id: string }, doc: ProductAssetDocument) => {
        const idx = mockDocs.findIndex((d) => d._id === filter._id)
        if (idx >= 0) {
          mockDocs[idx] = { ...doc }
        }
        return Promise.resolve({ acknowledged: true, modifiedCount: 1 })
      }),
      updateOne: jest.fn(
        (filter: { _id: string }, update: { $set?: Partial<ProductAssetDocument> }) => {
          const doc = mockDocs.find((d) => d._id === filter._id)
          if (doc && update.$set) {
            Object.assign(doc, update.$set)
          }
          return Promise.resolve({ acknowledged: true, modifiedCount: 1 })
        },
      ),
      find: jest.fn(
        (filter: {
          status: string
          expiresAt?: { $lte: Date }
          productId?: { $exists: boolean }
          finalizedAt?: { $lte: Date }
        }) => ({
          toArray: () => {
            if (filter.status === 'PENDING' && filter.expiresAt) {
              const lte = filter.expiresAt.$lte
              return Promise.resolve(
                mockDocs.filter((d) => d.status === 'PENDING' && d.expiresAt <= lte),
              )
            }
            if (filter.status === 'READY' && filter.finalizedAt) {
              const lte = filter.finalizedAt.$lte
              return Promise.resolve(
                mockDocs.filter(
                  (d) =>
                    d.status === 'READY' && !d.productId && d.finalizedAt && d.finalizedAt <= lte,
                ),
              )
            }
            return Promise.resolve([])
          },
        }),
      ),
      createIndex: jest.fn((spec: unknown, opts: unknown) => {
        mockIndexes.push({ spec, opts })
        return Promise.resolve('index_name')
      }),
    }

    createCollectionMock = jest.fn(() => Promise.resolve(mockCollection))

    mockDb = {
      collection: jest.fn(() => mockCollection),
      listCollections: jest.fn(() => ({
        toArray: () => Promise.resolve([]),
      })),
      createCollection: createCollectionMock,
    } as unknown as Db

    repository = new MongoProductAssetRepository(mockDb)
  })

  it('guarda, busca por id y actualiza un asset correctamente', async () => {
    const now = new Date('2026-09-02T20:00:00Z')
    const asset = ProductAsset.createPending({
      assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
      purpose: AssetPurpose.PrimaryImage,
      contentType: 'image/webp',
      contentLength: 1024,
      checksumSha256: 'mock-sha',
      stagingKey: 'staging/f293ce6b-98e9-41da-99ef-0ad4e3a95120',
      imageUrl: 'https://test.com/asset.webp',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    })

    await repository.save(asset)

    const found = await repository.findById('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
    expect(found).not.toBeNull()
    expect(found?.assetId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
    expect(found?.status).toBe('PENDING')

    // Actualizar asset a READY
    found?.markFinalized({
      targetKey: 'assets/key.webp',
      width: 512,
      height: 512,
      finalizedAt: new Date(),
    })
    await repository.update(found!)

    const updated = await repository.findById('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
    expect(updated?.status).toBe('READY')
    expect(updated?.width).toBe(512)
  })

  it('busca por stagingKey y targetKey', async () => {
    const now = new Date('2026-09-02T20:00:00Z')
    const asset = ProductAsset.createPending({
      assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
      purpose: AssetPurpose.PrimaryImage,
      contentType: 'image/webp',
      contentLength: 1024,
      checksumSha256: 'mock-sha',
      stagingKey: 'staging/my-staging-key',
      imageUrl: 'https://test.com/asset.webp',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600000),
    })
    asset.markFinalized({
      targetKey: 'assets/my-target-key',
      width: 1024,
      height: 1024,
      finalizedAt: now,
    })
    await repository.save(asset)

    const byStaging = await repository.findByStagingKey('staging/my-staging-key')
    expect(byStaging).not.toBeNull()
    expect(byStaging?.assetId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')

    const byTarget = await repository.findByTargetKey('assets/my-target-key')
    expect(byTarget).not.toBeNull()
    expect(byTarget?.assetId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')

    const missing = await repository.findByTargetKey('assets/not-exists')
    expect(missing).toBeNull()
  })

  it('asocia producto y consulta intenciones vencidas', async () => {
    const past = new Date('2026-09-01T20:00:00Z')
    const expiredAsset = ProductAsset.createPending({
      assetId: 'expired-1',
      purpose: AssetPurpose.PrimaryImage,
      contentType: 'image/webp',
      contentLength: 1024,
      checksumSha256: 'mock-sha',
      stagingKey: 'staging/expired-1',
      imageUrl: 'https://test.com/expired-1',
      createdAt: past,
      expiresAt: past,
    })
    await repository.save(expiredAsset)

    const expiredList = await repository.findExpiredPendingIntents(new Date('2026-09-02T00:00:00Z'))
    expect(expiredList).toHaveLength(1)
    expect(expiredList[0]?.assetId).toBe('expired-1')

    await repository.associateProduct('expired-1', 'prod-123')
    const associated = await repository.findById('expired-1')
    expect(associated?.productId).toBe('prod-123')
  })

  it('migración 006 crea la colección product_assets con sus índices', async () => {
    await migration006Up(mockDb)

    expect(createCollectionMock).toHaveBeenCalledWith('product_assets', expect.any(Object))
    expect(mockIndexes.length).toBeGreaterThanOrEqual(4)
  })
})
