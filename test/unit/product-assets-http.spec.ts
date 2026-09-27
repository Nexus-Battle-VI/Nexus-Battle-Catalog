import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { createHash } from 'node:crypto'
import type { Response } from 'express'
import { AdminProductAssetsController } from '../../src/adapters/inbound/http/admin-product-assets.controller'
import { CatalogProductAssetsController } from '../../src/adapters/inbound/http/catalog-product-assets.controller'
import { InMemoryProductAssetStorageAdapter } from '../../src/adapters/outbound/storage/InMemoryProductAssetStorageAdapter'
import { InMemoryProductAssetRepository } from '../../src/adapters/outbound/persistence/InMemoryProductAssetRepository'
import { AssetPurpose, ProductAsset } from '../../src/domain/entities/ProductAsset'
import { CreateProductAssetUploadIntent } from '../../src/application/use-cases/CreateProductAssetUploadIntent'
import { FinalizeProductAsset } from '../../src/application/use-cases/FinalizeProductAsset'
import { GetProductAssetContent } from '../../src/application/use-cases/GetProductAssetContent'
import {
  ProductAssetAnimatedContentError,
  ProductAssetChecksumMismatchError,
  ProductAssetConflictError,
  ProductAssetLengthMismatchError,
  ProductAssetStorageUnavailableError,
} from '../../src/application/errors/ApplicationError'
import { DomainError } from '../../src/domain/errors/DomainError'

describe('Product Assets HTTP Controllers (Admin & Catalog)', () => {
  let storage: InMemoryProductAssetStorageAdapter
  let repository: InMemoryProductAssetRepository
  let createUploadIntent: CreateProductAssetUploadIntent
  let finalizeAsset: FinalizeProductAsset
  let getContent: GetProductAssetContent
  let adminController: AdminProductAssetsController
  let catalogController: CatalogProductAssetsController

  beforeEach(() => {
    storage = new InMemoryProductAssetStorageAdapter()
    repository = new InMemoryProductAssetRepository()

    const clock = { now: () => new Date('2026-09-02T20:00:00.000Z') }
    const idGenerator = { generate: () => 'f293ce6b-98e9-41da-99ef-0ad4e3a95120' }

    createUploadIntent = new CreateProductAssetUploadIntent({
      storage,
      repository,
      idGenerator,
      clock,
      apiBaseUrl: 'https://catalog.nexus-battles.test',
    })

    finalizeAsset = new FinalizeProductAsset({
      storage,
      repository,
      clock,
    })

    getContent = new GetProductAssetContent({
      storage,
      repository,
    })

    adminController = new AdminProductAssetsController(createUploadIntent, finalizeAsset)
    catalogController = new CatalogProductAssetsController(getContent, storage)
  })

  it('POST /uploads genera un formulario firmado 201', async () => {
    const result = await adminController.createUpload({
      purpose: 'PRIMARY_IMAGE',
      contentType: 'image/png',
      contentLength: 1024,
      checksumSha256: 'b64:dummy',
    })

    expect(result.assetId).toBe('f293ce6b-98e9-41da-99ef-0ad4e3a95120')
    expect(result.upload.method).toBe('POST')
    expect(result.upload.fields.key).toBe('staging/f293ce6b-98e9-41da-99ef-0ad4e3a95120')
  })

  it('POST /finalization devuelve 404 si el asset no existe', async () => {
    await expect(adminController.finalize('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      NotFoundException,
    )
  })

  it('GET /content redirige con 307 y fija Cache-Control: private, max-age=240', async () => {
    // Preparar PNG válido de 512x512
    const ihdrData = Buffer.alloc(13)
    ihdrData.writeUInt32BE(512, 0)
    ihdrData.writeUInt32BE(512, 4)
    ihdrData[8] = 8
    ihdrData[9] = 6

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d]),
      Buffer.from('IHDR', 'ascii'),
      ihdrData,
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('IEND', 'ascii'),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
    ])

    const hash = createHash('sha256').update(png).digest('hex')

    const upload = await adminController.createUpload({
      purpose: 'PRIMARY_IMAGE',
      contentType: 'image/png',
      contentLength: png.length,
      checksumSha256: hash,
    })

    storage.putObjectDirectly(upload.upload.fields.key ?? '', png, 'image/png')
    await adminController.finalize(upload.assetId)

    // Probar GET /content
    const headers: Record<string, string> = {}
    let redirectStatus = 0
    let redirectUrl = ''

    const mockResponse = {
      setHeader: (name: string, value: string) => {
        headers[name] = value
      },
      redirect: (status: number, url: string) => {
        redirectStatus = status
        redirectUrl = url
      },
    } as unknown as Response

    await catalogController.getContent(upload.assetId, mockResponse)

    expect(headers['Cache-Control']).toBe('private, max-age=240')
    expect(redirectStatus).toBe(307)
    expect(redirectUrl).toContain('https://test-s3.local/download/assets/')
  })

  it('GET /content devuelve 404 si el asset no está en READY', async () => {
    const mockResponse = {} as unknown as Response
    await expect(
      catalogController.getContent('00000000-0000-0000-0000-000000000000', mockResponse),
    ).rejects.toThrow(NotFoundException)
  })

  it('traduce ProductAssetExpiredError a ConflictException (409)', async () => {
    const asset = ProductAsset.createPending({
      assetId: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120',
      purpose: AssetPurpose.PrimaryImage,
      contentType: 'image/png',
      contentLength: 100,
      checksumSha256: 'sha',
      stagingKey: 'staging/mock',
      imageUrl: 'url',
      createdAt: new Date('2026-09-02T19:00:00.000Z'),
      expiresAt: new Date('2026-09-02T19:10:00.000Z'), // Expirado
    })
    await repository.save(asset)

    await expect(adminController.finalize('f293ce6b-98e9-41da-99ef-0ad4e3a95120')).rejects.toThrow(
      ConflictException,
    )
  })

  it('traduce ProductAssetStorageUnavailableError a ServiceUnavailableException (503)', async () => {
    const faultyStorage = new InMemoryProductAssetStorageAdapter()
    jest
      .spyOn(faultyStorage, 'createUploadIntent')
      .mockRejectedValue(new ProductAssetStorageUnavailableError('S3 down'))

    const faultyUseCase = new CreateProductAssetUploadIntent({
      storage: faultyStorage,
      repository,
      idGenerator: { generate: () => '1' },
      clock: { now: () => new Date() },
      apiBaseUrl: 'http://test.com',
    })
    const controller = new AdminProductAssetsController(faultyUseCase, finalizeAsset)

    await expect(
      controller.createUpload({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
      }),
    ).rejects.toThrow(ServiceUnavailableException)
  })

  it('traduce ProductAssetAnimatedContentError, Checksum, Length y DomainError a UnprocessableEntityException (422)', async () => {
    const mockUploadThrow = (err: Error) => {
      const intent = new CreateProductAssetUploadIntent({
        storage,
        repository,
        idGenerator: { generate: () => '1' },
        clock: { now: () => new Date() },
        apiBaseUrl: 'http://test.com',
      })
      jest.spyOn(intent, 'execute').mockRejectedValue(err)
      return intent
    }

    let ctrl = new AdminProductAssetsController(
      mockUploadThrow(new ProductAssetAnimatedContentError('anim')),
      finalizeAsset,
    )
    await expect(
      ctrl.createUpload({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
      }),
    ).rejects.toThrow(UnprocessableEntityException)

    ctrl = new AdminProductAssetsController(
      mockUploadThrow(new ProductAssetChecksumMismatchError('chk')),
      finalizeAsset,
    )
    await expect(
      ctrl.createUpload({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
      }),
    ).rejects.toThrow(UnprocessableEntityException)

    ctrl = new AdminProductAssetsController(
      mockUploadThrow(new ProductAssetLengthMismatchError('len')),
      finalizeAsset,
    )
    await expect(
      ctrl.createUpload({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
      }),
    ).rejects.toThrow(UnprocessableEntityException)

    ctrl = new AdminProductAssetsController(mockUploadThrow(new DomainError('dom')), finalizeAsset)
    await expect(
      ctrl.createUpload({
        purpose: 'PRIMARY_IMAGE',
        contentType: 'image/png',
        contentLength: 100,
        checksumSha256: 'sha',
      }),
    ).rejects.toThrow(UnprocessableEntityException)

    const finalizeThrow = new FinalizeProductAsset({
      storage,
      repository,
      clock: { now: () => new Date() },
    })
    jest.spyOn(finalizeThrow, 'execute').mockRejectedValue(new ProductAssetConflictError('conf'))

    ctrl = new AdminProductAssetsController(createUploadIntent, finalizeThrow)
    await expect(ctrl.finalize('asset-id')).rejects.toThrow(ConflictException)
  })

  it('CatalogProductAssetsController traduce ProductAssetStorageUnavailableError a ServiceUnavailableException', async () => {
    const getContentThrow = new GetProductAssetContent({ storage, repository })
    jest
      .spyOn(getContentThrow, 'execute')
      .mockRejectedValue(new ProductAssetStorageUnavailableError('down'))

    const ctrl = new CatalogProductAssetsController(getContentThrow, storage)
    const mockRes = {} as unknown as Response

    await expect(ctrl.getContent('asset-id', mockRes)).rejects.toThrow(ServiceUnavailableException)
  })

  describe('POST /mock-uploads y GET /mock-downloads (sustituto local de S3, driver memory)', () => {
    it('sube el archivo y lo deja disponible para descarga', async () => {
      const file = { buffer: Buffer.from('contenido-de-prueba'), mimetype: 'image/png' }

      const uploadResult = catalogController.mockUpload(file, 'staging/mock-key', 'image/png')
      expect(uploadResult).toEqual({ ok: true })
      expect(storage.hasObject('staging/mock-key')).toBe(true)

      const headers: Record<string, string> = {}
      let sentBody: Buffer | undefined
      const mockRes = {
        setHeader: (name: string, value: string) => {
          headers[name] = value
        },
        send: (body: Buffer) => {
          sentBody = body
        },
      } as unknown as Response
      await catalogController.mockDownload('staging/mock-key', mockRes)

      expect(headers['Content-Type']).toBe('image/png')
      expect(sentBody).toEqual(file.buffer)
    })

    it('rechaza la subida sin el campo "file"', () => {
      expect(() => catalogController.mockUpload(undefined, 'staging/mock-key', 'image/png')).toThrow(
        BadRequestException,
      )
    })

    it('rechaza la subida sin el campo "key"', () => {
      const file = { buffer: Buffer.from('x'), mimetype: 'image/png' }
      expect(() => catalogController.mockUpload(file, undefined, 'image/png')).toThrow(
        BadRequestException,
      )
    })

    it('descarga responde 404 si la clave no existe', async () => {
      const mockRes = { setHeader: jest.fn(), send: jest.fn() } as unknown as Response
      await expect(catalogController.mockDownload('staging/no-existe', mockRes)).rejects.toThrow(
        NotFoundException,
      )
    })

    it('ambas rutas responden 503 cuando el almacenamiento activo no es el de memoria (driver s3)', async () => {
      const s3LikeStorage = {
        createUploadIntent: jest.fn(),
        getObject: jest.fn(),
        getObjectMetadata: jest.fn(),
        promoteObject: jest.fn(),
        deleteObject: jest.fn(),
        getPresignedDownloadUrl: jest.fn(),
        listObjectsWithPrefix: jest.fn(),
      }
      const ctrl = new CatalogProductAssetsController(getContent, s3LikeStorage)
      const file = { buffer: Buffer.from('x'), mimetype: 'image/png' }
      const mockRes = { setHeader: jest.fn(), send: jest.fn() } as unknown as Response

      expect(() => ctrl.mockUpload(file, 'staging/mock-key', 'image/png')).toThrow(
        ServiceUnavailableException,
      )
      await expect(ctrl.mockDownload('staging/mock-key', mockRes)).rejects.toThrow(
        ServiceUnavailableException,
      )
    })
  })
})
