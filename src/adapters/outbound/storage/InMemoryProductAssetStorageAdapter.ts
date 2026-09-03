import type {
  ProductAssetStoragePort,
  StoredObjectMetadata,
  UploadIntentResult,
} from '../../../application/ports/ProductAssetStoragePort'

interface StoredEntry {
  buffer: Buffer
  contentType: string
  lastModified: Date
}

export class InMemoryProductAssetStorageAdapter implements ProductAssetStoragePort {
  private readonly objects = new Map<string, StoredEntry>()

  createUploadIntent(params: {
    assetId: string
    purpose: string
    contentType: string
    contentLength: number
    checksumSha256: string
    expiresInSeconds: number
  }): Promise<UploadIntentResult> {
    const stagingKey = `staging/${params.assetId}`
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000)

    return Promise.resolve({
      uploadUrl: `https://test-s3.local/upload`,
      fields: {
        key: stagingKey,
        'Content-Type': params.contentType,
        'x-amz-checksum-sha256': params.checksumSha256,
        policy: 'mock-policy-base64',
        'x-amz-algorithm': 'AWS4-HMAC-SHA256',
        'x-amz-credential': 'mock/20260902/us-east-1/s3/aws4_request',
        'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
        'x-amz-signature': 'mock-signature-hex',
      },
      expiresAt,
      stagingKey,
    })
  }

  getObject(key: string): Promise<Buffer> {
    const entry = this.objects.get(key)
    if (!entry) {
      return Promise.reject(new Error(`Objeto no encontrado en almacenamiento: "${key}".`))
    }
    return Promise.resolve(Buffer.from(entry.buffer))
  }

  getObjectMetadata(key: string): Promise<StoredObjectMetadata | null> {
    const entry = this.objects.get(key)
    if (!entry) {
      return Promise.resolve(null)
    }
    return Promise.resolve({
      contentLength: entry.buffer.length,
      contentType: entry.contentType,
    })
  }

  promoteObject(stagingKey: string, targetKey: string): Promise<void> {
    const entry = this.objects.get(stagingKey)
    if (!entry) {
      return Promise.reject(new Error(`Objeto en staging no encontrado: "${stagingKey}".`))
    }

    this.objects.set(targetKey, {
      buffer: Buffer.from(entry.buffer),
      contentType: entry.contentType,
      lastModified: new Date(),
    })
    this.objects.delete(stagingKey)
    return Promise.resolve()
  }

  deleteObject(key: string): Promise<void> {
    this.objects.delete(key)
    return Promise.resolve()
  }

  getPresignedDownloadUrl(key: string): Promise<string> {
    const entry = this.objects.get(key)
    if (!entry) {
      return Promise.reject(new Error(`Objeto no encontrado para descarga: "${key}".`))
    }
    return Promise.resolve(`https://test-s3.local/download/${key}?sig=presigned-mock`)
  }

  listObjectsWithPrefix(
    prefix: string,
  ): Promise<{ key: string; lastModified: Date; size: number }[]> {
    const results: { key: string; lastModified: Date; size: number }[] = []
    for (const [key, entry] of this.objects.entries()) {
      if (key.startsWith(prefix)) {
        results.push({
          key,
          lastModified: entry.lastModified,
          size: entry.buffer.length,
        })
      }
    }
    return Promise.resolve(results)
  }

  // Helper para simular subida en pruebas
  putObjectDirectly(
    key: string,
    buffer: Buffer,
    contentType = 'image/png',
    lastModified = new Date(),
  ): void {
    this.objects.set(key, {
      buffer: Buffer.from(buffer),
      contentType,
      lastModified,
    })
  }

  hasObject(key: string): boolean {
    return this.objects.has(key)
  }
}
