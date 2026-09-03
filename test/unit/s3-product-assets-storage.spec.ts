import type { S3Client } from '@aws-sdk/client-s3'
import { S3ProductAssetStorageAdapter } from '../../src/adapters/outbound/storage/S3ProductAssetStorageAdapter'
import { ProductAssetStorageUnavailableError } from '../../src/application/errors/ApplicationError'

describe('S3ProductAssetStorageAdapter', () => {
  let mockClient: { send: jest.Mock }
  let adapter: S3ProductAssetStorageAdapter

  beforeEach(() => {
    mockClient = {
      send: jest.fn(),
    }
    adapter = new S3ProductAssetStorageAdapter({
      bucketName: 'nexus-battles-vi-product-assets-test',
      region: 'us-east-1',
      client: mockClient as unknown as S3Client,
    })
  })

  it('promociona un objeto de staging a assets llamando Copy y Delete', async () => {
    mockClient.send.mockResolvedValue({})

    await adapter.promoteObject('staging/asset-1', 'assets/asset-1/hash.png')

    expect(mockClient.send).toHaveBeenCalledTimes(2)
  })

  it('elimina un objeto llamando DeleteObjectCommand', async () => {
    mockClient.send.mockResolvedValue({})

    await adapter.deleteObject('staging/asset-1')

    expect(mockClient.send).toHaveBeenCalledTimes(1)
  })

  it('obtiene metadatos de un objeto existente', async () => {
    mockClient.send.mockResolvedValue({
      ContentLength: 2048,
      ContentType: 'image/png',
      ChecksumSHA256: 'mock-sha',
    })

    const meta = await adapter.getObjectMetadata('assets/asset-1/hash.png')

    expect(meta).not.toBeNull()
    expect(meta?.contentLength).toBe(2048)
    expect(meta?.contentType).toBe('image/png')
  })

  it('devuelve null cuando el objeto no existe en S3 (NotFound)', async () => {
    const error = new Error('NoSuchKey')
    error.name = 'NoSuchKey'
    mockClient.send.mockRejectedValue(error)

    const meta = await adapter.getObjectMetadata('assets/asset-non-existent.png')

    expect(meta).toBeNull()
  })

  it('envuelve fallos de S3 en ProductAssetStorageUnavailableError', async () => {
    mockClient.send.mockRejectedValue(new Error('Network connection timeout'))

    await expect(adapter.deleteObject('staging/asset-1')).rejects.toThrow(
      ProductAssetStorageUnavailableError,
    )
  })

  it('lista objetos bajo un prefijo', async () => {
    mockClient.send.mockResolvedValue({
      Contents: [
        { Key: 'staging/obj1', LastModified: new Date('2026-09-01T00:00:00Z'), Size: 100 },
        { Key: 'staging/obj2', LastModified: new Date('2026-09-02T00:00:00Z'), Size: 200 },
      ],
    })

    const list = await adapter.listObjectsWithPrefix('staging/')

    expect(list).toHaveLength(2)
    expect(list[0]?.key).toBe('staging/obj1')
    expect(list[1]?.size).toBe(200)
  })
})
