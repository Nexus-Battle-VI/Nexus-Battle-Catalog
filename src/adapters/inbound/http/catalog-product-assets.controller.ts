import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { ApiExcludeEndpoint, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { GET_PRODUCT_ASSET_CONTENT, PRODUCT_ASSET_STORAGE_PORT } from './tokens'
import type { GetProductAssetContent } from '../../../application/use-cases/GetProductAssetContent'
import type { ProductAssetStoragePort } from '../../../application/ports/ProductAssetStoragePort'
import {
  ProductAssetNotFoundError,
  ProductAssetStorageUnavailableError,
} from '../../../application/errors/ApplicationError'
import { Public } from './auth/decorators'

/** Forma minima del archivo que entrega `multer` -sin `@types/multer` de por medio-. */
interface UploadedMulterFile {
  readonly buffer: Buffer
  readonly mimetype: string
}

/**
 * Duck-typing deliberado: `putObjectDirectly`/`hasObject` solo existen en
 * `InMemoryProductAssetStorageAdapter` (vease ese archivo), nunca en
 * `ProductAssetStoragePort` -un adaptador S3 real no los necesita, S3 acepta
 * la subida directamente-. Los dos endpoints de esta clase son opacos en
 * produccion (ASSETS_STORAGE_DRIVER=s3): `storage` ahi nunca los expone, asi
 * que ambos responden 503 sin tocar nada.
 */
interface MockObjectStorage {
  putObjectDirectly(key: string, buffer: Buffer, contentType?: string): void
  getObject(key: string): Promise<Buffer>
  getObjectMetadata(key: string): Promise<{ contentType: string } | null>
}

const asMockObjectStorage = (storage: ProductAssetStoragePort): MockObjectStorage | null => {
  if (
    'putObjectDirectly' in storage &&
    typeof (storage as Partial<MockObjectStorage>).putObjectDirectly === 'function'
  ) {
    return storage as unknown as MockObjectStorage
  }
  return null
}

@ApiTags('Catalog Product Assets')
@Controller('v1/catalog/product-assets')
export class CatalogProductAssetsController {
  constructor(
    @Inject(GET_PRODUCT_ASSET_CONTENT)
    private readonly getContentUseCase: GetProductAssetContent,
    @Inject(PRODUCT_ASSET_STORAGE_PORT)
    private readonly storage: ProductAssetStoragePort,
  ) {}

  @Public()
  @Get(':assetId/content')
  @ApiOperation({
    operationId: 'getProductAssetContentV1',
    summary: 'Redirige temporalmente al contenido firmado del asset (HTTP 307)',
  })
  @ApiResponse({
    status: 307,
    description: 'Redirección temporal hacia la URL firmada de S3 (vigencia máxima 5 minutos)',
  })
  @ApiResponse({ status: 404, description: 'Asset no encontrado o no disponible' })
  @ApiResponse({ status: 503, description: 'Almacenamiento no disponible' })
  async getContent(@Param('assetId') assetId: string, @Res() res: Response): Promise<void> {
    try {
      const downloadUrl = await this.getContentUseCase.execute(assetId)
      res.setHeader('Cache-Control', 'private, max-age=240')
      res.redirect(HttpStatus.TEMPORARY_REDIRECT, downloadUrl)
    } catch (error: unknown) {
      if (error instanceof ProductAssetNotFoundError) {
        throw new NotFoundException(error.message)
      }
      if (error instanceof ProductAssetStorageUnavailableError) {
        throw new ServiceUnavailableException(error.message)
      }
      throw error
    }
  }

  /**
   * Sustituto local de "POST a S3" para `ASSETS_STORAGE_DRIVER=memory` (stack
   * de Docker sin AWS). Un navegador real -a diferencia de las pruebas
   * automatizadas, que mockean `fetch`- SI intenta resolver por DNS la URL de
   * subida; sin esta ruta, `InMemoryProductAssetStorageAdapter` devolvia
   * `https://test-s3.local/upload`, un host que no existe, y el navegador
   * fallaba con "Failed to fetch" al crear cualquier producto con imagen.
   *
   * `@Public()`: mimetiza el propio POST firmado de S3, que tampoco exige
   * sesion -la "firma" aqui es cosmetica, ver InMemoryProductAssetStorageAdapter-.
   * Solo hace algo cuando el adaptador activo es el de memoria (ninguna otra
   * implementacion expone `putObjectDirectly`); en produccion (driver s3) esta
   * ruta no se usa -`uploadUrl` ya apunta al S3 real- y responde 503 si alguien
   * la llama de todas formas.
   */
  @Public()
  @Post('mock-uploads')
  @ApiExcludeEndpoint()
  @UseInterceptors(FileInterceptor('file'))
  mockUpload(
    @UploadedFile() file: UploadedMulterFile | undefined,
    @Body('key') key: string | undefined,
    @Body('Content-Type') contentType: string | undefined,
  ): { ok: true } {
    const mock = asMockObjectStorage(this.storage)
    if (mock === null) {
      throw new ServiceUnavailableException(
        'Esta ruta solo existe con ASSETS_STORAGE_DRIVER=memory.',
      )
    }
    if (file === undefined) {
      throw new BadRequestException('Falta el campo "file".')
    }
    if (key === undefined || key === '') {
      throw new BadRequestException('Falta el campo "key".')
    }

    mock.putObjectDirectly(key, file.buffer, contentType ?? file.mimetype)
    return { ok: true }
  }

  /** Contraparte de descarga de `mockUpload` -mismo alcance y misma razon de ser-. */
  @Public()
  @Get('mock-downloads/:key')
  @ApiExcludeEndpoint()
  async mockDownload(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const mock = asMockObjectStorage(this.storage)
    if (mock === null) {
      throw new ServiceUnavailableException(
        'Esta ruta solo existe con ASSETS_STORAGE_DRIVER=memory.',
      )
    }

    const metadata = await mock.getObjectMetadata(key)
    if (metadata === null) {
      throw new NotFoundException(`Objeto no encontrado: "${key}".`)
    }

    const buffer = await mock.getObject(key)
    res.setHeader('Content-Type', metadata.contentType)
    res.setHeader('Cache-Control', 'private, max-age=240')
    res.send(buffer)
  }
}
