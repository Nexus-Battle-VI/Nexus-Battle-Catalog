import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
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
  CanonicalProductSkuAlreadyExistsError,
  HeroSubtypeBranchMismatchError,
  InvalidAbilityReferenceError,
  InvalidHeroSubtypeError,
  OutboxPayloadTooLargeError,
} from '../../../application/errors/ApplicationError'
import type { CanonicalProductDto } from '../../../application/dto/CanonicalProductDto'
import type { CreateCanonicalProduct } from '../../../application/use-cases/CreateCanonicalProduct'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import { CREATE_CANONICAL_PRODUCT } from './tokens'
import { CurrentIdentity, RequiresMfaEvidence, Roles } from './auth/decorators'
import { CanonicalProductResponse, CreateCanonicalProductRequest } from './canonical-products.dto'

/** Entrada HTTP de la creación canónica acordada en ADR-013. */
@ApiTags('Catalog Products')
@ApiBearerAuth('bearerAuth')
@Controller('v1/catalog/products')
export class CanonicalProductsController {
  constructor(
    @Inject(CREATE_CANONICAL_PRODUCT)
    private readonly createCanonicalProduct: CreateCanonicalProduct,
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

  private static translate(error: unknown): Error {
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
      error instanceof InvalidAbilityReferenceError
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
