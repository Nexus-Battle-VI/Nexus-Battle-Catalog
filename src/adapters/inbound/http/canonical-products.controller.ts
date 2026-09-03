import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductIdentityAlreadyExistsError,
  CanonicalProductNotFoundError,
  CanonicalProductSkuAlreadyExistsError,
  HeroSubtypeBranchMismatchError,
  InvalidAbilityReferenceError,
  InvalidHeroSubtypeError,
  OutboxPayloadTooLargeError,
  ProductAssetInvalidContentError,
} from '../../../application/errors/ApplicationError'
import type { CanonicalProductDto } from '../../../application/dto/CanonicalProductDto'
import type { CreateCanonicalProduct } from '../../../application/use-cases/CreateCanonicalProduct'
import type {
  GetCanonicalProduct,
  LookupCanonicalProducts,
  LookupCanonicalProductsResult,
} from '../../../application/use-cases/CanonicalProductQueries'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import {
  CREATE_CANONICAL_PRODUCT,
  GET_CANONICAL_PRODUCT,
  LOOKUP_CANONICAL_PRODUCTS,
} from './tokens'
import { CurrentIdentity, Public, RequiresMfaEvidence, Roles } from './auth/decorators'
import {
  CanonicalProductResponse,
  CreateCanonicalProductRequest,
  LookupCanonicalProductsRequest,
  LookupCanonicalProductsResponse,
} from './canonical-products.dto'

/** Entrada HTTP de la creación y la LECTURA canónica de producto (ADR-013). */
@ApiTags('Catalog Products')
@ApiBearerAuth('bearerAuth')
@Controller('v1/catalog/products')
export class CanonicalProductsController {
  constructor(
    @Inject(CREATE_CANONICAL_PRODUCT)
    private readonly createCanonicalProduct: CreateCanonicalProduct,
    @Inject(GET_CANONICAL_PRODUCT)
    private readonly getCanonicalProduct: GetCanonicalProduct,
    @Inject(LOOKUP_CANONICAL_PRODUCTS)
    private readonly lookupCanonicalProducts: LookupCanonicalProducts,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'createCatalogProductV1',
    summary: 'Crea y deja disponible un producto canónico',
  })
  @ApiResponse({
    status: 201,
    description: 'Producto creado y disponible',
    type: CanonicalProductResponse,
  })
  @ApiResponse({ status: 400, description: 'JSON, tipo o campos no declarados inválidos' })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, inválido o vencido' })
  @ApiResponse({
    status: 403,
    description: 'Rol no autorizado o TOTP de aplicacion autenticadora ausente',
  })
  @ApiResponse({ status: 409, description: 'Nombre + tipo activo o SKU ya existente' })
  @ApiResponse({ status: 422, description: 'Regla de negocio incumplida' })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async create(
    @Body() body: CreateCanonicalProductRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<CanonicalProductDto> {
    try {
      const actor = {
        subject: identity.subject,
        email: identity.email ?? undefined,
        role: [...identity.roles][0] ?? undefined,
      }
      return await this.createCanonicalProduct.execute(body, actor)
    } catch (error: unknown) {
      throw CanonicalProductsController.translate(error)
    }
  }

  @Public()
  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'lookupCatalogProductsV1',
    summary: 'Resuelve varios productos canónicos por referencia en una sola consulta',
  })
  @ApiResponse({
    status: 200,
    description: 'Productos resueltos',
    type: LookupCanonicalProductsResponse,
  })
  @ApiResponse({ status: 400, description: 'Lista de referencias inválida' })
  async lookup(
    @Body() body: LookupCanonicalProductsRequest,
  ): Promise<LookupCanonicalProductsResult> {
    try {
      return await this.lookupCanonicalProducts.execute(body)
    } catch (error: unknown) {
      throw CanonicalProductsController.translate(error)
    }
  }

  @Public()
  @Get(':reference')
  @ApiOperation({
    operationId: 'getCatalogProductV1',
    summary: 'Recupera un producto canónico por productId (UUID) o por su alias sku',
  })
  @ApiResponse({ status: 200, description: 'Producto encontrado', type: CanonicalProductResponse })
  @ApiResponse({ status: 404, description: 'No existe un producto canónico con esa referencia' })
  async getByReference(@Param('reference') reference: string): Promise<CanonicalProductDto> {
    try {
      return await this.getCanonicalProduct.execute(reference)
    } catch (error: unknown) {
      throw CanonicalProductsController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof CanonicalProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (
      error instanceof CanonicalProductAlreadyExistsError ||
      error instanceof CanonicalProductSkuAlreadyExistsError ||
      error instanceof CanonicalProductIdentityAlreadyExistsError ||
      error instanceof CanonicalProductConcurrencyConflictError
    ) {
      return new ConflictException(error.message)
    }

    if (error instanceof OutboxPayloadTooLargeError) {
      return new BadRequestException(error.message)
    }

    if (error instanceof DomainError) {
      if (CanonicalProductsController.isRequestShapeError(error)) {
        return new BadRequestException(error.message)
      }

      return new UnprocessableEntityException(error.message)
    }

    if (
      error instanceof InvalidHeroSubtypeError ||
      error instanceof HeroSubtypeBranchMismatchError ||
      error instanceof InvalidAbilityReferenceError ||
      error instanceof ProductAssetInvalidContentError
    ) {
      return new UnprocessableEntityException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }

  /** El parser de dominio conserva la forma de entrada cerrada; HTTP traduce
   * esos fallos sintácticos a 400 y deja las invariantes de negocio en 422. */
  private static isRequestShapeError(error: DomainError): boolean {
    return /no es una propiedad admitida|debe ser (un objeto|texto|un entero|booleano|una lista)\.|tiene un formato invalido|debe ser uno de/u.test(
      error.message,
    )
  }
}
