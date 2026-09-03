import { createHash } from 'node:crypto'
import { AssetPurpose, ProductAsset, AssetStatus } from '../../src/domain/entities/ProductAsset'
import { ImageContentValidator } from '../../src/domain/services/ImageContentValidator'
import {
  ProductAssetAnimatedContentError,
  ProductAssetChecksumMismatchError,
  ProductAssetExpiredError,
  ProductAssetInvalidContentError,
  ProductAssetLengthMismatchError,
  ProductAssetNotFoundError,
} from '../../src/application/errors/ApplicationError'
import { InMemoryProductAssetStorageAdapter } from '../../src/adapters/outbound/storage/InMemoryProductAssetStorageAdapter'
import { InMemoryProductAssetRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAssetRepository'
import { CreateProductAssetUploadIntent } from '../../src/application/use-cases/CreateProductAssetUploadIntent'
import { FinalizeProductAsset } from '../../src/application/use-cases/FinalizeProductAsset'
import { GetProductAssetContent } from '../../src/application/use-cases/GetProductAssetContent'
import { ReconcileProductAssets } from '../../src/application/use-cases/ReconcileProductAssets'
import { CreateCanonicalProduct } from '../../src/application/use-cases/CreateCanonicalProduct'
import { InMemoryCanonicalProductRepository } from '../../src/adapters/outbound/persistence/InMemoryCanonicalProductRepository'
import { HeroSubtypeRegistryV1 } from '../../src/adapters/outbound/registry/HeroSubtypeRegistryV1'
import type { ClockPort } from '../../src/application/ports/ClockPort'
import type { IdGeneratorPort } from '../../src/application/ports/IdGeneratorPort'

// Fixture helpers for binary images
const createPngBuffer = (options?: {
  width?: number
  height?: number
  withApng?: boolean
}): Buffer => {
  const width = options?.width ?? 512
  const height = options?.height ?? 512
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  // IHDR chunk
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8 // bit depth
  ihdrData[9] = 6 // color type RGBA
  ihdrData[10] = 0 // compression
  ihdrData[11] = 0 // filter
  ihdrData[12] = 0 // interlace

  const ihdrChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]), // length 13
    Buffer.from('IHDR', 'ascii'),
    ihdrData,
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // mock crc
  ])

  const chunks = [signature, ihdrChunk]

  if (options?.withApng) {
    // acTL chunk (animation control)
    const actlData = Buffer.alloc(8)
    actlData.writeUInt32BE(10, 0) // 10 frames
    actlData.writeUInt32BE(0, 4) // loop count
    const actlChunk = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x08]),
      Buffer.from('acTL', 'ascii'),
      actlData,
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
    ])
    chunks.push(actlChunk)
  }

  // IEND chunk
  const iendChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from('IEND', 'ascii'),
    Buffer.from([0xae, 0x42, 0x60, 0x82]),
  ])
  chunks.push(iendChunk)

  return Buffer.concat(chunks)
}

const createJpegBuffer = (options?: { width?: number; height?: number }): Buffer => {
  const width = options?.width ?? 512
  const height = options?.height ?? 512

  const soi = Buffer.from([0xff, 0xd8])
  // SOF0: FF C0, length (17 = 0x0011), precision (8), height (2 bytes), width (2 bytes), components (3), comp specs (9 bytes)
  const sof0 = Buffer.alloc(19)
  sof0[0] = 0xff
  sof0[1] = 0xc0
  sof0.writeUInt16BE(17, 2) // segment length
  sof0[4] = 8 // precision
  sof0.writeUInt16BE(height, 5)
  sof0.writeUInt16BE(width, 7)
  sof0[9] = 3 // 3 components
  // comp details
  sof0[10] = 1
  sof0[11] = 0x11
  sof0[12] = 0
  sof0[13] = 2
  sof0[14] = 0x11
  sof0[15] = 0
  sof0[16] = 3
  sof0[17] = 0x11
  sof0[18] = 0

  const eoi = Buffer.from([0xff, 0xd9])
  return Buffer.concat([soi, sof0, eoi])
}

const createWebpBuffer = (options?: {
  width?: number
  height?: number
  animatedAnimBit?: boolean
  withAnmfChunk?: boolean
}): Buffer => {
  const width = options?.width ?? 512
  const height = options?.height ?? 512

  // VP8X header
  const vp8xData = Buffer.alloc(10)
  // Byte 0: flags
  if (options?.animatedAnimBit) {
    vp8xData[0] = 0x02 // ANIM flag
  }
  // Bytes 4-6: canvas width - 1 (24-bit LE)
  const w = width - 1
  vp8xData[4] = w & 0xff
  vp8xData[5] = (w >> 8) & 0xff
  vp8xData[6] = (w >> 16) & 0xff

  // Bytes 7-9: canvas height - 1 (24-bit LE)
  const h = height - 1
  vp8xData[7] = h & 0xff
  vp8xData[8] = (h >> 8) & 0xff
  vp8xData[9] = (h >> 16) & 0xff

  const vp8xChunk = Buffer.concat([
    Buffer.from('VP8X', 'ascii'),
    Buffer.from([0x0a, 0x00, 0x00, 0x00]), // length 10
    vp8xData,
  ])

  const chunks = [vp8xChunk]

  if (options?.withAnmfChunk) {
    const anmfData = Buffer.alloc(16)
    const anmfChunk = Buffer.concat([
      Buffer.from('ANMF', 'ascii'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]), // length 16
      anmfData,
    ])
    chunks.push(anmfChunk)
  }

  const payload = Buffer.concat(chunks)
  const riffHeader = Buffer.alloc(12)
  riffHeader.write('RIFF', 0, 'ascii')
  riffHeader.writeUInt32LE(payload.length + 4, 4)
  riffHeader.write('WEBP', 8, 'ascii')

  return Buffer.concat([riffHeader, payload])
}

const hashSha256 = (buffer: Buffer): { hex: string; b64: string } => {
  const hex = createHash('sha256').update(buffer).digest('hex')
  const b64 = createHash('sha256').update(buffer).digest('base64')
  return { hex, b64 }
}

describe('Product Assets Management (HU-33.8 / ADR-016)', () => {
  let mockClock: ClockPort
  let mockIdGenerator: IdGeneratorPort
  let currentTime: Date

  beforeEach(() => {
    currentTime = new Date('2026-09-02T20:00:00.000Z')
    mockClock = {
      now: () => new Date(currentTime.getTime()),
    }
    mockIdGenerator = {
      generate: () => 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
    }
  })

  describe('ImageContentValidator - Detección de Contenido y Controles Negativos', () => {
    it('valida exitosamente un PNG estático con dimensiones dentro del rango permitido', () => {
      const buffer = createPngBuffer({ width: 800, height: 600 })
      const hash = hashSha256(buffer)

      const result = ImageContentValidator.validate({
        buffer,
        declaredContentType: 'image/png',
        declaredContentLength: buffer.length,
        declaredChecksumSha256: `b64:${hash.b64}`,
      })

      expect(result.format).toBe('png')
      expect(result.width).toBe(800)
      expect(result.height).toBe(600)
      expect(result.sha256Hex).toBe(hash.hex)
    })

    it('valida exitosamente un JPEG estático', () => {
      const buffer = createJpegBuffer({ width: 1024, height: 1024 })
      const hash = hashSha256(buffer)

      const result = ImageContentValidator.validate({
        buffer,
        declaredContentType: 'image/jpeg',
        declaredContentLength: buffer.length,
        declaredChecksumSha256: hash.hex,
      })

      expect(result.format).toBe('jpeg')
      expect(result.width).toBe(1024)
      expect(result.height).toBe(1024)
    })

    it('valida exitosamente un WebP estático VP8X', () => {
      const buffer = createWebpBuffer({ width: 512, height: 512, animatedAnimBit: false })
      const hash = hashSha256(buffer)

      const result = ImageContentValidator.validate({
        buffer,
        declaredContentType: 'image/webp',
        declaredContentLength: buffer.length,
        declaredChecksumSha256: hash.b64,
      })

      expect(result.format).toBe('webp')
      expect(result.width).toBe(512)
      expect(result.height).toBe(512)
    })

    // Control Negativo 1: APNG (chunk acTL)
    it('CONTROL NEGATIVO 1: rechaza estrictamente APNG cuando contiene el chunk acTL', () => {
      const apngBuffer = createPngBuffer({ width: 512, height: 512, withApng: true })
      const hash = hashSha256(apngBuffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer: apngBuffer,
          declaredContentType: 'image/png',
          declaredContentLength: apngBuffer.length,
          declaredChecksumSha256: `b64:${hash.b64}`,
        }),
      ).toThrow(ProductAssetAnimatedContentError)
    })

    // Control Negativo 2: WebP animado con bit ANIM
    it('CONTROL NEGATIVO 2: rechaza estrictamente WebP animado cuando el bit ANIM está activo', () => {
      const animWebp = createWebpBuffer({ width: 512, height: 512, animatedAnimBit: true })
      const hash = hashSha256(animWebp)

      expect(() =>
        ImageContentValidator.validate({
          buffer: animWebp,
          declaredContentType: 'image/webp',
          declaredContentLength: animWebp.length,
          declaredChecksumSha256: `b64:${hash.b64}`,
        }),
      ).toThrow(ProductAssetAnimatedContentError)
    })

    // Control Negativo 3: WebP animado con chunk ANMF
    it('CONTROL NEGATIVO 3: rechaza estrictamente WebP cuando contiene chunks ANMF', () => {
      const anmfWebp = createWebpBuffer({ width: 512, height: 512, withAnmfChunk: true })
      const hash = hashSha256(anmfWebp)

      expect(() =>
        ImageContentValidator.validate({
          buffer: anmfWebp,
          declaredContentType: 'image/webp',
          declaredContentLength: anmfWebp.length,
          declaredChecksumSha256: `b64:${hash.b64}`,
        }),
      ).toThrow(ProductAssetAnimatedContentError)
    })

    // Control Negativo 4: Formatos no admitidos (SVG y BMP)
    it('CONTROL NEGATIVO 4: rechaza archivos SVG por razones de seguridad', () => {
      const svgBuffer = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="50"/></svg>',
      )
      const hash = hashSha256(svgBuffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer: svgBuffer,
          declaredContentType: 'image/jpeg',
          declaredContentLength: svgBuffer.length,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    it('CONTROL NEGATIVO 5: rechaza archivos BMP', () => {
      const bmpBuffer = Buffer.from('BM' + 'x'.repeat(60))
      const hash = hashSha256(bmpBuffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer: bmpBuffer,
          declaredContentType: 'image/jpeg',
          declaredContentLength: bmpBuffer.length,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    // Control Negativo 6: Checksum SHA-256 no coincide
    it('CONTROL NEGATIVO 6: rechaza cuando el checksum SHA-256 no coincide', () => {
      const buffer = createPngBuffer()

      expect(() =>
        ImageContentValidator.validate({
          buffer,
          declaredContentType: 'image/png',
          declaredContentLength: buffer.length,
          declaredChecksumSha256: 'b64:invalid-checksum-hash',
        }),
      ).toThrow(ProductAssetChecksumMismatchError)
    })

    // Control Negativo 7: Longitud de contenido no coincide
    it('CONTROL NEGATIVO 7: rechaza cuando la longitud no coincide con la declarada', () => {
      const buffer = createPngBuffer()
      const hash = hashSha256(buffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer,
          declaredContentType: 'image/png',
          declaredContentLength: buffer.length + 10,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetLengthMismatchError)
    })

    // Control Negativo 8: Dimensiones menores al mínimo (256px)
    it('CONTROL NEGATIVO 8: rechaza imágenes con ancho menor a 256px', () => {
      const smallBuffer = createPngBuffer({ width: 200, height: 512 })
      const hash = hashSha256(smallBuffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer: smallBuffer,
          declaredContentType: 'image/png',
          declaredContentLength: smallBuffer.length,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    // Control Negativo 9: Dimensiones mayores al máximo (4096px)
    it('CONTROL NEGATIVO 9: rechaza imágenes con ancho superior a 4096px', () => {
      const hugeBuffer = createPngBuffer({ width: 5000, height: 1024 })
      const hash = hashSha256(hugeBuffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer: hugeBuffer,
          declaredContentType: 'image/png',
          declaredContentLength: hugeBuffer.length,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })
  })

  describe('Flujo de Carga y Finalización de Assets', () => {
    let storage: InMemoryProductAssetStorageAdapter
    let repository: InMemoryProductAssetRepository
    let createUploadIntent: CreateProductAssetUploadIntent
    let finalizeAsset: FinalizeProductAsset
    let getContent: GetProductAssetContent
    let reconciler: ReconcileProductAssets

    beforeEach(() => {
      storage = new InMemoryProductAssetStorageAdapter()
      repository = new InMemoryProductAssetRepository()

      createUploadIntent = new CreateProductAssetUploadIntent({
        storage,
        repository,
        idGenerator: mockIdGenerator,
        clock: mockClock,
        apiBaseUrl: 'https://api.test.com',
      })

      finalizeAsset = new FinalizeProductAsset({
        storage,
        repository,
        clock: mockClock,
      })

      getContent = new GetProductAssetContent({
        storage,
        repository,
      })

      reconciler = new ReconcileProductAssets({
        storage,
        repository,
        clock: mockClock,
      })
    })

    it('crea exitosamente una intención de carga con vigencia de 10 minutos', async () => {
      const validPng = createPngBuffer()
      const hash = hashSha256(validPng)

      const response = await createUploadIntent.execute({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: validPng.length,
        checksumSha256: `b64:${hash.b64}`,
      })

      expect(response.assetId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
      expect(response.upload.method).toBe('POST')
      expect(response.upload.fields.key).toBe('staging/f293ce6b-98e9-41da-99ef-0ad4e3a95120')
      expect(response.upload.expiresAt).toBe('2026-09-02T20:10:00.000Z')

      const saved = await repository.findById(response.assetId)
      expect(saved).not.toBeNull()
      expect(saved?.status).toBe(AssetStatus.Pending)
      expect(saved?.imageUrl).toBe(
        'https://api.test.com/api/v1/catalog/product-assets/f293ce6b-98e9-41da-99ef-0ad4e3a95120/content',
      )
    })

    it('finaliza exitosamente el asset, promueve el archivo a assets/ y lo deja en estado READY', async () => {
      const validPng = createPngBuffer({ width: 1024, height: 1024 })
      const hash = hashSha256(validPng)

      const intent = await createUploadIntent.execute({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: validPng.length,
        checksumSha256: hash.hex,
      })

      // Simular la subida del cliente al bucket en staging
      storage.putObjectDirectly(intent.upload.fields.key!, validPng, 'image/png')

      const finalized = await finalizeAsset.execute(intent.assetId)

      expect(finalized.status).toBe(AssetStatus.Ready)
      expect(finalized.width).toBe(1024)
      expect(finalized.height).toBe(1024)

      // Verificar que el objeto fue movido de staging/ a assets/
      expect(storage.hasObject(intent.upload.fields.key!)).toBe(false)
      const expectedTargetKey = `assets/${intent.assetId}/${hash.hex}.png`
      expect(storage.hasObject(expectedTargetKey)).toBe(true)

      // Idempotencia: invocar finalizeAsset por segunda vez no debe fallar ni reprocesar
      const secondCall = await finalizeAsset.execute(intent.assetId)
      expect(secondCall.status).toBe(AssetStatus.Ready)
      expect(secondCall.assetId).toBe(finalized.assetId)
    })

    it('rechaza la finalización si la intención expiró (> 10 min)', async () => {
      const validPng = createPngBuffer()
      const hash = hashSha256(validPng)

      const intent = await createUploadIntent.execute({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: validPng.length,
        checksumSha256: hash.hex,
      })

      storage.putObjectDirectly(intent.upload.fields.key!, validPng, 'image/png')

      // Avanzar el reloj 11 minutos
      currentTime = new Date(currentTime.getTime() + 11 * 60 * 1000)

      await expect(finalizeAsset.execute(intent.assetId)).rejects.toThrow(ProductAssetExpiredError)

      const asset = await repository.findById(intent.assetId)
      expect(asset?.status).toBe(AssetStatus.Expired)
    })

    it('rechaza la finalización con error si el archivo cargado contiene animación APNG', async () => {
      const apng = createPngBuffer({ width: 512, height: 512, withApng: true })
      const hash = hashSha256(apng)

      const intent = await createUploadIntent.execute({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: apng.length,
        checksumSha256: hash.hex,
      })

      storage.putObjectDirectly(intent.upload.fields.key!, apng, 'image/png')

      await expect(finalizeAsset.execute(intent.assetId)).rejects.toThrow(
        ProductAssetAnimatedContentError,
      )

      // Debe permanecer en staging, no promocionado a assets/
      expect(storage.hasObject(intent.upload.fields.key!)).toBe(true)
      const asset = await repository.findById(intent.assetId)
      expect(asset?.status).toBe(AssetStatus.Pending)
    })

    it('obtiene la URL firmada para descarga de un asset en estado READY', async () => {
      const validPng = createPngBuffer({ width: 512, height: 512 })
      const hash = hashSha256(validPng)

      const intent = await createUploadIntent.execute({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: validPng.length,
        checksumSha256: hash.hex,
      })

      storage.putObjectDirectly(intent.upload.fields.key!, validPng, 'image/png')
      await finalizeAsset.execute(intent.assetId)

      const url = await getContent.execute(intent.assetId)
      expect(url).toContain('https://test-s3.local/download/assets/')
      expect(url).toContain('sig=presigned-mock')
    })

    it('falla al solicitar descarga de un asset no existente o no finalizado', async () => {
      await expect(getContent.execute('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
        ProductAssetNotFoundError,
      )
    })

    it('reconciliador: purga objetos de staging huérfanos con más de 24 horas', async () => {
      const oldDate = new Date(currentTime.getTime() - 25 * 60 * 60 * 1000)
      storage.putObjectDirectly('staging/orphan-old', Buffer.from('old-data'), 'image/png', oldDate)

      const recentDate = new Date(currentTime.getTime() - 2 * 60 * 60 * 1000)
      storage.putObjectDirectly(
        'staging/orphan-recent',
        Buffer.from('recent-data'),
        'image/png',
        recentDate,
      )

      const report = await reconciler.execute()
      expect(report.orphanedStagingDeleted).toBe(1)
      expect(storage.hasObject('staging/orphan-old')).toBe(false)
      expect(storage.hasObject('staging/orphan-recent')).toBe(true)
    })
  })

  describe('Integración con CreateCanonicalProduct', () => {
    let productsRepo: InMemoryCanonicalProductRepository
    let assetsRepo: InMemoryProductAssetRepository
    let createCanonicalProduct: CreateCanonicalProduct

    beforeEach(() => {
      productsRepo = new InMemoryCanonicalProductRepository()
      assetsRepo = new InMemoryProductAssetRepository()

      createCanonicalProduct = new CreateCanonicalProduct({
        products: productsRepo,
        heroSubtypes: new HeroSubtypeRegistryV1(),
        productReferences: productsRepo,
        idGenerator: mockIdGenerator,
        clock: mockClock,
        productAssets: assetsRepo,
        assetsEnforceStrict: true,
      })
    })

    it('permite crear producto canónico referenciando un asset READY y lo asocia', async () => {
      // Guardar asset en estado READY
      const asset = ProductAsset.createPending({
        assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
        purpose: AssetPurpose.PrimaryImage,
        contentType: 'image/png',
        contentLength: 1024,
        checksumSha256: 'mock-sha',
        stagingKey: 'staging/mock',
        imageUrl:
          'https://api.test.com/api/v1/catalog/product-assets/f293ce6b-98e9-41da-99ef-0ad4e3a95120/content',
        createdAt: currentTime,
        expiresAt: new Date(currentTime.getTime() + 600000),
      })
      asset.markFinalized({
        targetKey: 'assets/mock/key.png',
        width: 512,
        height: 512,
        finalizedAt: currentTime,
      })
      await assetsRepo.save(asset)

      const command = {
        name: 'Espada Nexus',
        imageUrl:
          'https://api.test.com/api/v1/catalog/product-assets/f293ce6b-98e9-41da-99ef-0ad4e3a95120/content',
        description: 'Arma legendaria del nexo',
        type: 'ARMA',
        printRun: 100,
        creditsPrice: 1500,
        premium: false,
        attributes: {
          schemaVersion: '1',
          values: {
            kind: 'ARMA',
            compatibilityScope: 'ALL_HEROES',
            effects: [
              { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 5 } },
            ],
          },
        },
      }

      const created = await createCanonicalProduct.execute(command)
      expect(created.productId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
      expect(created.name).toBe('Espada Nexus')

      // Verificar que el asset quedó asociado al producto
      const updatedAsset = await assetsRepo.findById('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
      expect(updatedAsset?.productId).toBe(created.productId)
    })

    it('rechaza con ProductAssetInvalidContentError si el asset no está READY o no existe', async () => {
      const command = {
        name: 'Espada Nexus',
        imageUrl:
          'https://api.test.com/api/v1/catalog/product-assets/f293ce6b-98e9-41da-99ef-0ad4e3a95120/content',
        description: 'Arma legendaria del nexo',
        type: 'ARMA',
        printRun: 100,
        creditsPrice: 1500,
        premium: false,
        attributes: {
          schemaVersion: '1',
          values: {
            kind: 'ARMA',
            compatibilityScope: 'ALL_HEROES',
            effects: [
              { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 5 } },
            ],
          },
        },
      }

      await expect(createCanonicalProduct.execute(command)).rejects.toThrow(
        ProductAssetInvalidContentError,
      )
    })

    it('en modo estricto, rechaza URLs que no provengan del gestor de assets', async () => {
      const command = {
        name: 'Espada Nexus',
        imageUrl: 'https://external-cdn.com/image.png',
        description: 'Arma legendaria del nexo',
        type: 'ARMA',
        printRun: 100,
        creditsPrice: 1500,
        premium: false,
        attributes: {
          schemaVersion: '1',
          values: {
            kind: 'ARMA',
            compatibilityScope: 'ALL_HEROES',
            effects: [
              { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 5 } },
            ],
          },
        },
      }

      await expect(createCanonicalProduct.execute(command)).rejects.toThrow(
        ProductAssetInvalidContentError,
      )
    })
  })

  describe('Casos borde y cobertura de ramas', () => {
    it('valida exitosamente WebP con compresión VP8 con pérdidas', () => {
      const vp8Data = Buffer.alloc(18)
      vp8Data[3] = 0x9d
      vp8Data[4] = 0x01
      vp8Data[5] = 0x2a
      vp8Data.writeUInt16LE(512, 6)
      vp8Data.writeUInt16LE(512, 8)
      const vp8Chunk = Buffer.concat([
        Buffer.from('VP8 ', 'ascii'),
        Buffer.from([0x12, 0x00, 0x00, 0x00]),
        vp8Data,
      ])
      const riff = Buffer.alloc(12)
      riff.write('RIFF', 0, 'ascii')
      riff.writeUInt32LE(vp8Chunk.length + 4, 4)
      riff.write('WEBP', 8, 'ascii')
      const buffer = Buffer.concat([riff, vp8Chunk])
      const hash = hashSha256(buffer)

      const result = ImageContentValidator.validate({
        buffer,
        declaredContentType: 'image/webp',
        declaredContentLength: buffer.length,
        declaredChecksumSha256: hash.hex,
      })
      expect(result.format).toBe('webp')
      expect(result.width).toBe(512)
      expect(result.height).toBe(512)
    })

    it('valida exitosamente WebP con compresión VP8L sin pérdidas', () => {
      const vp8lData = Buffer.alloc(14)
      vp8lData[0] = 0x2f
      const w = 512 - 1
      const h = 512 - 1
      vp8lData[1] = w & 0xff
      vp8lData[2] = ((w >> 8) & 0x3f) | ((h & 0x03) << 6)
      vp8lData[3] = (h >> 2) & 0xff
      vp8lData[4] = (h >> 10) & 0x0f

      const vp8lChunk = Buffer.concat([
        Buffer.from('VP8L', 'ascii'),
        Buffer.from([0x0e, 0x00, 0x00, 0x00]),
        vp8lData,
      ])
      const riff = Buffer.alloc(12)
      riff.write('RIFF', 0, 'ascii')
      riff.writeUInt32LE(vp8lChunk.length + 4, 4)
      riff.write('WEBP', 8, 'ascii')
      const buffer = Buffer.concat([riff, vp8lChunk])
      const hash = hashSha256(buffer)

      const result = ImageContentValidator.validate({
        buffer,
        declaredContentType: 'image/webp',
        declaredContentLength: buffer.length,
        declaredChecksumSha256: hash.hex,
      })
      expect(result.format).toBe('webp')
      expect(result.width).toBe(512)
      expect(result.height).toBe(512)
    })

    it('rechaza WebP con chunk desconocido', () => {
      const buffer = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0x20, 0x00, 0x00, 0x00]),
        Buffer.from('WEBP'),
        Buffer.from('VP8?'),
        Buffer.alloc(16),
      ])
      const hash = hashSha256(buffer)

      expect(() =>
        ImageContentValidator.validate({
          buffer,
          declaredContentType: 'image/webp',
          declaredContentLength: buffer.length,
          declaredChecksumSha256: hash.hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    it('rechaza archivos que superan 5 MiB', () => {
      const hugeBuffer = Buffer.alloc(5 * 1024 * 1024 + 1)
      expect(() =>
        ImageContentValidator.validate({
          buffer: hugeBuffer,
          declaredContentType: 'image/png',
          declaredContentLength: hugeBuffer.length,
          declaredChecksumSha256: 'mock',
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    it('rechaza contentType no admitido', () => {
      const buffer = Buffer.alloc(64)
      expect(() =>
        ImageContentValidator.validate({
          buffer,
          declaredContentType: 'image/gif',
          declaredContentLength: buffer.length,
          declaredChecksumSha256: hashSha256(buffer).hex,
        }),
      ).toThrow(ProductAssetInvalidContentError)
    })

    it('rechaza cuando magic bytes no corresponden al contentType declarado', () => {
      const fakeJpeg = Buffer.from([0x00, 0x00, 0x00, 0x00, ...Buffer.alloc(60)])
      expect(() =>
        ImageContentValidator.validate({
          buffer: fakeJpeg,
          declaredContentType: 'image/jpeg',
          declaredContentLength: fakeJpeg.length,
          declaredChecksumSha256: hashSha256(fakeJpeg).hex,
        }),
      ).toThrow('Magic bytes no corresponden a una imagen JPEG valida.')

      const fakePng = Buffer.from([0x00, 0x00, 0x00, 0x00, ...Buffer.alloc(60)])
      expect(() =>
        ImageContentValidator.validate({
          buffer: fakePng,
          declaredContentType: 'image/png',
          declaredContentLength: fakePng.length,
          declaredChecksumSha256: hashSha256(fakePng).hex,
        }),
      ).toThrow('Magic bytes no corresponden a una imagen PNG valida.')

      const fakeWebp = Buffer.from([0x00, 0x00, 0x00, 0x00, ...Buffer.alloc(60)])
      expect(() =>
        ImageContentValidator.validate({
          buffer: fakeWebp,
          declaredContentType: 'image/webp',
          declaredContentLength: fakeWebp.length,
          declaredChecksumSha256: hashSha256(fakeWebp).hex,
        }),
      ).toThrow('Magic bytes no corresponden a una imagen WebP valida.')
    })

    it('rechaza JPEG sin marcador SOF', () => {
      const noSofJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9, ...Buffer.alloc(20)])
      expect(() =>
        ImageContentValidator.validate({
          buffer: noSofJpeg,
          declaredContentType: 'image/jpeg',
          declaredContentLength: noSofJpeg.length,
          declaredChecksumSha256: hashSha256(noSofJpeg).hex,
        }),
      ).toThrow('No se pudo determinar las dimensiones de la imagen JPEG.')
    })

    it('ProductAsset entity valida tamaño y tipo MIME en createPending', () => {
      const now = new Date()
      expect(() =>
        ProductAsset.createPending({
          assetId: '1',
          purpose: AssetPurpose.PrimaryImage,
          contentType: 'image/png',
          contentLength: 0,
          checksumSha256: 'sha',
          stagingKey: 'key',
          imageUrl: 'url',
          createdAt: now,
          expiresAt: now,
        }),
      ).toThrow('El tamano del asset debe estar entre 1 byte y 5 MiB.')

      expect(() =>
        ProductAsset.createPending({
          assetId: '1',
          purpose: AssetPurpose.PrimaryImage,
          contentType: 'image/gif',
          contentLength: 100,
          checksumSha256: 'sha',
          stagingKey: 'key',
          imageUrl: 'url',
          createdAt: now,
          expiresAt: now,
        }),
      ).toThrow('Tipo MIME no permitido')
    })

    it('CreateProductAssetUploadIntent rechaza propósitos distintos a PRIMARY_IMAGE', async () => {
      const storage = new InMemoryProductAssetStorageAdapter()
      const repository = new InMemoryProductAssetRepository()
      const useCase = new CreateProductAssetUploadIntent({
        storage,
        repository,
        idGenerator: mockIdGenerator,
        clock: mockClock,
        apiBaseUrl: 'https://test.com',
      })

      await expect(
        useCase.execute({
          purpose: 'BANNER_IMAGE',
          contentType: 'image/png',
          contentLength: 100,
          checksumSha256: 'sha',
        }),
      ).rejects.toThrow('El proposito "BANNER_IMAGE" no es admitido. Debe ser PRIMARY_IMAGE.')
    })

    it('FinalizeProductAsset rechaza cuando el buffer descargado está vacío', async () => {
      const storage = new InMemoryProductAssetStorageAdapter()
      const repository = new InMemoryProductAssetRepository()
      const finalize = new FinalizeProductAsset({ storage, repository, clock: mockClock })

      const asset = ProductAsset.createPending({
        assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
        purpose: AssetPurpose.PrimaryImage,
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
        stagingKey: 'staging/mock',
        imageUrl: 'url',
        createdAt: currentTime,
        expiresAt: new Date(currentTime.getTime() + 600000),
      })
      await repository.save(asset)
      storage.putObjectDirectly('staging/mock', Buffer.alloc(0))

      await expect(finalize.execute('f293ce6b-98e9-41da-99ef-0ad4e3a95120')).rejects.toThrow(
        ProductAssetNotFoundError,
      )
    })

    it('FinalizeProductAsset rechaza si el asset está en un estado no PENDING', async () => {
      const storage = new InMemoryProductAssetStorageAdapter()
      const repository = new InMemoryProductAssetRepository()
      const finalize = new FinalizeProductAsset({ storage, repository, clock: mockClock })

      const asset = ProductAsset.fromSnapshot({
        assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
        purpose: AssetPurpose.PrimaryImage,
        status: AssetStatus.Rejected,
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
        stagingKey: 'staging/mock',
        imageUrl: 'url',
        createdAt: currentTime,
        expiresAt: new Date(currentTime.getTime() + 600000),
      })
      await repository.save(asset)

      await expect(finalize.execute('f293ce6b-98e9-41da-99ef-0ad4e3a95120')).rejects.toThrow(
        'El asset "f293ce6b-98e9-41da-99ef-0ad4e3a95120" se encuentra en estado "REJECTED".',
      )
    })

    it('ReconcileProductAssets no borra objetos de staging que tienen una intención activa', async () => {
      const storage = new InMemoryProductAssetStorageAdapter()
      const repository = new InMemoryProductAssetRepository()
      const reconciler = new ReconcileProductAssets({ storage, repository, clock: mockClock })

      const oldDate = new Date(currentTime.getTime() - 25 * 60 * 60 * 1000)
      storage.putObjectDirectly('staging/active-asset', Buffer.from('active'), 'image/png', oldDate)

      const activeAsset = ProductAsset.createPending({
        assetId: 'active-asset',
        purpose: AssetPurpose.PrimaryImage,
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
        stagingKey: 'staging/active-asset',
        imageUrl: 'url',
        createdAt: currentTime,
        expiresAt: new Date(currentTime.getTime() + 600000), // Vigente
      })
      await repository.save(activeAsset)

      const report = await reconciler.execute()
      expect(report.orphanedStagingDeleted).toBe(0)
      expect(storage.hasObject('staging/active-asset')).toBe(true)
    })
  })
})
