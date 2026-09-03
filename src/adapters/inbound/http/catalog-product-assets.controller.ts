import {
  Controller,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { GET_PRODUCT_ASSET_CONTENT } from './tokens'
import type { GetProductAssetContent } from '../../../application/use-cases/GetProductAssetContent'
import {
  ProductAssetNotFoundError,
  ProductAssetStorageUnavailableError,
} from '../../../application/errors/ApplicationError'

@ApiTags('Catalog Product Assets')
@ApiBearerAuth('bearerAuth')
@Controller('v1/catalog/product-assets')
export class CatalogProductAssetsController {
  constructor(
    @Inject(GET_PRODUCT_ASSET_CONTENT)
    private readonly getContentUseCase: GetProductAssetContent,
  ) {}

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
}
