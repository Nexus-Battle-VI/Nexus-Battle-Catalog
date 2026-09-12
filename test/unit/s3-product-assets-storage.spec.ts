import { S3Client } from '@aws-sdk/client-s3'
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

  describe('createUploadIntent', () => {
    /**
     * `createPresignedPost` firma la politica en el propio proceso -no hace
     * ninguna llamada de red-, asi que basta un `S3Client` con credenciales
     * de mentira para ejercitar la firma real y leer los `fields` que
     * produce. Mockear `client.send` (como el resto de este fichero) no
     * intercepta nada aqui: por eso este metodo se quedo sin cubrir y el
     * bug de abajo llego a produccion sin que ninguna prueba lo detectara.
     */
    const buildRealAdapter = (): S3ProductAssetStorageAdapter =>
      new S3ProductAssetStorageAdapter({
        bucketName: 'nexus-battles-vi-product-assets-test',
        region: 'us-east-1',
        client: new S3Client({
          region: 'us-east-1',
          credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        }),
      })

    /**
     * Regresion: `x-amz-checksum-sha256` es un encabezado NATIVO de S3 que
     * exige el digest base64 crudo. El dominio de Catalog antepone "b64:" a
     * sus propios checksums (vease ImageContentValidator); pasar ese valor
     * TAL CUAL a S3 hace que el bucket rechace la subida entera con
     * "InvalidRequest: Value for x-amz-checksum-sha256 header is invalid" -
     * confirmado subiendo un archivo real contra el bucket de verdad antes
     * de este fix.
     */
    it('quita el prefijo "b64:" del checksum antes de firmarlo como x-amz-checksum-sha256', async () => {
      const realAdapter = buildRealAdapter()

      const intent = await realAdapter.createUploadIntent({
        assetId: 'asset-1',
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 1024,
        checksumSha256: 'b64:QxztaRaiohoVbjhwGv5Vu9f4iWn7v8Vtf+CZ1H8mVGA=',
        expiresInSeconds: 600,
      })

      expect(intent.fields['x-amz-checksum-sha256']).toBe(
        'QxztaRaiohoVbjhwGv5Vu9f4iWn7v8Vtf+CZ1H8mVGA=',
      )
      expect(intent.fields['x-amz-checksum-sha256']).not.toMatch(/^b64:/u)
    })

    it('conserva el checksum tal cual si ya llega sin el prefijo "b64:"', async () => {
      const realAdapter = buildRealAdapter()

      const intent = await realAdapter.createUploadIntent({
        assetId: 'asset-2',
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/jpeg',
        contentLength: 2048,
        checksumSha256: 'QxztaRaiohoVbjhwGv5Vu9f4iWn7v8Vtf+CZ1H8mVGA=',
        expiresInSeconds: 600,
      })

      expect(intent.fields['x-amz-checksum-sha256']).toBe(
        'QxztaRaiohoVbjhwGv5Vu9f4iWn7v8Vtf+CZ1H8mVGA=',
      )
    })

    it('genera la clave de staging y el resto de campos del contrato', async () => {
      const realAdapter = buildRealAdapter()

      const intent = await realAdapter.createUploadIntent({
        assetId: 'asset-3',
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/webp',
        contentLength: 512,
        checksumSha256: 'b64:aaaa',
        expiresInSeconds: 600,
      })

      expect(intent.stagingKey).toBe('staging/asset-3')
      expect(intent.fields.key).toBe('staging/asset-3')
      expect(intent.fields['Content-Type']).toBe('image/webp')
      expect(intent.uploadUrl).toContain('nexus-battles-vi-product-assets-test')
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
