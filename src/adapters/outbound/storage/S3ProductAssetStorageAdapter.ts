import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type {
  ProductAssetStoragePort,
  StoredObjectMetadata,
  UploadIntentResult,
} from '../../../application/ports/ProductAssetStoragePort'
import { ProductAssetStorageUnavailableError } from '../../../application/errors/ApplicationError'

export interface S3ProductAssetStorageConfig {
  readonly bucketName: string
  readonly region: string
  readonly client?: S3Client
}

export class S3ProductAssetStorageAdapter implements ProductAssetStoragePort {
  private readonly client: S3Client
  private readonly bucketName: string

  constructor(config: S3ProductAssetStorageConfig) {
    this.bucketName = config.bucketName
    this.client = config.client ?? new S3Client({ region: config.region })
  }

  async createUploadIntent(params: {
    assetId: string
    purpose: string
    contentType: string
    contentLength: number
    checksumSha256: string
    expiresInSeconds: number
  }): Promise<UploadIntentResult> {
    const stagingKey = `staging/${params.assetId}`
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000)

    try {
      const presignedPost = await createPresignedPost(this.client, {
        Bucket: this.bucketName,
        Key: stagingKey,
        Conditions: [
          ['content-length-range', 1, 5 * 1024 * 1024],
          ['eq', '$key', stagingKey],
          ['eq', '$Content-Type', params.contentType],
        ],
        Fields: {
          'Content-Type': params.contentType,
          'x-amz-checksum-sha256': params.checksumSha256,
        },
        Expires: params.expiresInSeconds,
      })

      return {
        uploadUrl: presignedPost.url,
        fields: presignedPost.fields,
        expiresAt,
        stagingKey,
      }
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al generar la intencion de carga en S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async getObject(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      )

      if (!response.Body) {
        throw new Error('Cuerpo de respuesta vacio.')
      }

      const stream = response.Body as NodeJS.ReadableStream
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al obtener objeto "${key}" de S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async getObjectMetadata(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      )

      return {
        contentLength: response.ContentLength ?? 0,
        contentType: response.ContentType ?? 'application/octet-stream',
        checksumSha256: response.ChecksumSHA256,
      }
    } catch (error: unknown) {
      const name = (error as { name?: string }).name
      if (name === 'NotFound' || name === 'NoSuchKey') {
        return null
      }
      throw new ProductAssetStorageUnavailableError(
        `Error al consultar metadatos de "${key}" en S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async promoteObject(stagingKey: string, targetKey: string): Promise<void> {
    try {
      // 1. Copiar de staging a clave final inmutable
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucketName,
          CopySource: `${this.bucketName}/${stagingKey}`,
          Key: targetKey,
        }),
      )

      // 2. Eliminar staging
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: stagingKey,
        }),
      )
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al promocionar objeto de "${stagingKey}" a "${targetKey}" en S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        }),
      )
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al eliminar objeto "${key}" de S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async getPresignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      })
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds })
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al generar URL de descarga firmada en S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  async listObjectsWithPrefix(
    prefix: string,
  ): Promise<{ key: string; lastModified: Date; size: number }[]> {
    try {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
        }),
      )

      if (!response.Contents) {
        return []
      }

      return response.Contents.filter(
        (c): c is typeof c & { Key: string } => typeof c.Key === 'string',
      ).map((c) => ({
        key: c.Key,
        lastModified: c.LastModified ?? new Date(),
        size: c.Size ?? 0,
      }))
    } catch (error: unknown) {
      throw new ProductAssetStorageUnavailableError(
        `Error al listar objetos con prefijo "${prefix}" en S3: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
