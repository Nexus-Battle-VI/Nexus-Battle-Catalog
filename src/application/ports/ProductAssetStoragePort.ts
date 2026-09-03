export interface UploadIntentResult {
  readonly uploadUrl: string
  readonly fields: Record<string, string>
  readonly expiresAt: Date
  readonly stagingKey: string
}

export interface StoredObjectMetadata {
  readonly contentLength: number
  readonly contentType: string
  readonly checksumSha256?: string
}

export interface ProductAssetStoragePort {
  /**
   * Genera el formulario firmado para carga directa a S3 (10 min de vigencia).
   */
  createUploadIntent(params: {
    assetId: string
    purpose: string
    contentType: string
    contentLength: number
    checksumSha256: string
    expiresInSeconds: number
  }): Promise<UploadIntentResult>

  /**
   * Obtiene el contenido binario del objeto desde el almacenamiento.
   */
  getObject(key: string): Promise<Buffer>

  /**
   * Consulta metadatos del objeto en el almacenamiento.
   */
  getObjectMetadata(key: string): Promise<StoredObjectMetadata | null>

  /**
   * Promociona el objeto de staging/ a assets/ de forma inmutable y elimina staging.
   */
  promoteObject(stagingKey: string, targetKey: string): Promise<void>

  /**
   * Elimina un objeto del almacenamiento (staging huérfano o compensación).
   */
  deleteObject(key: string): Promise<void>

  /**
   * Genera una URL firmada de descarga temporal (máximo 5 minutos).
   */
  getPresignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>

  /**
   * Lista objetos bajo un prefijo dado para reconciliación.
   */
  listObjectsWithPrefix(
    prefix: string,
  ): Promise<{ key: string; lastModified: Date; size: number }[]>
}
