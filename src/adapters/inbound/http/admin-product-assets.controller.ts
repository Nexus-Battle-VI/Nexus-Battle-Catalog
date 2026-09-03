import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Role } from '../../../application/ports/TokenVerifierPort'
import { RequiresMfaEvidence, Roles } from './auth/decorators'
import { CREATE_PRODUCT_ASSET_UPLOAD_INTENT, FINALIZE_PRODUCT_ASSET } from './tokens'
import type { CreateProductAssetUploadIntent } from '../../../application/use-cases/CreateProductAssetUploadIntent'
import type { FinalizeProductAsset } from '../../../application/use-cases/FinalizeProductAsset'
import {
  CreateProductAssetUploadRequest,
  FinalizedProductAssetResponse,
  ProductAssetUploadResponse,
} from './product-assets.dto'
import { DomainError } from '../../../domain/errors/DomainError'
import {
  ProductAssetAnimatedContentError,
  ProductAssetChecksumMismatchError,
  ProductAssetConflictError,
  ProductAssetExpiredError,
  ProductAssetInvalidContentError,
  ProductAssetLengthMismatchError,
  ProductAssetNotFoundError,
  ProductAssetStorageUnavailableError,
} from '../../../application/errors/ApplicationError'

@ApiTags('Admin Product Assets')
@ApiBearerAuth('bearerAuth')
@Controller('v1/admin/product-assets')
export class AdminProductAssetsController {
  constructor(
    @Inject(CREATE_PRODUCT_ASSET_UPLOAD_INTENT)
    private readonly createUploadIntent: CreateProductAssetUploadIntent,
    @Inject(FINALIZE_PRODUCT_ASSET)
    private readonly finalizeAsset: FinalizeProductAsset,
  ) {}

  @Post('uploads')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Administrator, Role.SuperAdministrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'createProductAssetUploadIntentV1',
    summary: 'Crea una intención firmada de carga directa a S3',
  })
  @ApiResponse({
    status: 201,
    description: 'Intención creada; devuelve formulario firmado para carga directa',
    type: ProductAssetUploadResponse,
  })
  @ApiResponse({ status: 400, description: 'JSON o campos inválidos' })
  @ApiResponse({ status: 401, description: 'Token de acceso ausente o inválido' })
  @ApiResponse({ status: 403, description: 'Rol insuficiente o evidencia TOTP ausente' })
  @ApiResponse({ status: 422, description: 'Tipo MIME, propósito o tamaño no admitido' })
  @ApiResponse({
    status: 503,
    description: 'Almacenamiento S3 o servicio de identidad no disponible',
  })
  async createUpload(
    @Body() body: CreateProductAssetUploadRequest,
  ): Promise<ProductAssetUploadResponse> {
    try {
      return await this.createUploadIntent.execute({
        purpose: body.purpose,
        contentType: body.contentType,
        contentLength: body.contentLength,
        checksumSha256: body.checksumSha256,
      })
    } catch (error: unknown) {
      throw this.translate(error)
    }
  }

  @Post(':assetId/finalization')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Administrator, Role.SuperAdministrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'finalizeProductAssetV1',
    summary:
      'Verifica el contenido cargado, valida dimensiones y ausencia de animación y promueve el asset',
  })
  @ApiResponse({
    status: 200,
    description: 'Asset verificado y promovido a READY',
    type: FinalizedProductAssetResponse,
  })
  @ApiResponse({ status: 401, description: 'Token ausente o inválido' })
  @ApiResponse({ status: 403, description: 'Rol o MFA insuficiente' })
  @ApiResponse({ status: 404, description: 'Asset o archivo no encontrado' })
  @ApiResponse({ status: 409, description: 'Intención expirada o conflicto de estado' })
  @ApiResponse({
    status: 422,
    description: 'Contenido inválido, animación detectada o checksum distinto',
  })
  @ApiResponse({ status: 503, description: 'Almacenamiento no disponible' })
  async finalize(@Param('assetId') assetId: string): Promise<FinalizedProductAssetResponse> {
    try {
      return await this.finalizeAsset.execute(assetId)
    } catch (error: unknown) {
      throw this.translate(error)
    }
  }

  private translate(error: unknown): Error {
    if (error instanceof ProductAssetNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof ProductAssetExpiredError || error instanceof ProductAssetConflictError) {
      return new ConflictException(error.message)
    }

    if (
      error instanceof ProductAssetAnimatedContentError ||
      error instanceof ProductAssetChecksumMismatchError ||
      error instanceof ProductAssetInvalidContentError ||
      error instanceof ProductAssetLengthMismatchError
    ) {
      return new UnprocessableEntityException(error.message)
    }

    if (error instanceof ProductAssetStorageUnavailableError) {
      return new ServiceUnavailableException(error.message)
    }

    if (error instanceof DomainError) {
      return new UnprocessableEntityException(error.message)
    }

    if (error instanceof Error && error.message.includes('UUID')) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error(String(error))
  }
}
