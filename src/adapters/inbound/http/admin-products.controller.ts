import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  CanonicalProductConcurrencyConflictError,
  CanonicalProductNotFoundError,
} from '../../../application/errors/ApplicationError'
import type { CanonicalProductDto } from '../../../application/dto/CanonicalProductDto'
import type { AdjustProductInventory } from '../../../application/use-cases/AdjustProductInventory'
import type { ConfigureProductPremium } from '../../../application/use-cases/ConfigureProductPremium'
import type { GetCanonicalProduct } from '../../../application/use-cases/GetCanonicalProduct'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { AuditActor } from '../../../application/ports/CanonicalProductPorts'
import {
  ADJUST_PRODUCT_INVENTORY,
  CONFIGURE_PRODUCT_PREMIUM,
  GET_CANONICAL_PRODUCT,
} from './tokens'
import { CurrentIdentity, RequiresMfaEvidence, Roles } from './auth/decorators'
import {
  AdjustInventoryRequest,
  CanonicalProductResponse,
  ConfigurePremiumRequest,
} from './admin-products.dto'

/**
 * Ajuste administrativo del tiraje (HU-34, CA-02).
 *
 * Ruta separada de `v1/catalog/products` a proposito: aquella es el contrato
 * canonico de creacion y lectura; esta es administracion, y la HU la nombra
 * explicitamente como `PATCH /api/v1/admin/products/{id}/inventory`.
 */
@ApiTags('Admin Products')
@ApiBearerAuth('bearerAuth')
@Controller('v1/admin/products')
export class AdminProductsController {
  constructor(
    @Inject(ADJUST_PRODUCT_INVENTORY)
    private readonly adjustProductInventory: AdjustProductInventory,
    @Inject(CONFIGURE_PRODUCT_PREMIUM)
    private readonly configureProductPremium: ConfigureProductPremium,
    @Inject(GET_CANONICAL_PRODUCT)
    private readonly getCanonicalProduct: GetCanonicalProduct,
  ) {}

  @Get(':id')
  @Roles(Role.Administrator)
  @ApiOperation({
    operationId: 'getCatalogProductForAdministrationV1',
    summary: 'Consulta un producto canonico con su disponibilidad',
  })
  @ApiParam({ name: 'id', description: 'Identificador del producto canonico' })
  @ApiResponse({ status: 200, description: 'Producto', type: CanonicalProductResponse })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  async getOne(@Param('id') id: string): Promise<CanonicalProductDto> {
    try {
      return await this.getCanonicalProduct.execute(id)
    } catch (error: unknown) {
      throw AdminProductsController.translate(error)
    }
  }

  // La LECTURA no exige segundo factor y la MUTACION si. No es un descuido:
  // consultar no cambia nada, y exigir la evidencia en cada lectura ataria la
  // pantalla a una llamada de red por pulsacion sin ganar ninguna proteccion.

  @Patch(':id/inventory')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'adjustCatalogProductInventoryV1',
    summary: 'Ajusta el tiraje de un producto y recalcula su disponibilidad',
  })
  @ApiParam({ name: 'id', description: 'Identificador del producto canonico' })
  @ApiResponse({ status: 200, description: 'Tiraje ajustado', type: CanonicalProductResponse })
  @ApiResponse({ status: 400, description: 'Cuerpo o campos no declarados invalidos' })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado o segundo factor ausente' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  @ApiResponse({ status: 409, description: 'Otro ajuste modifico el producto entre medias' })
  @ApiResponse({ status: 422, description: 'Regla de tiraje incumplida' })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async adjustInventory(
    @Param('id') id: string,
    @Body() body: AdjustInventoryRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<CanonicalProductDto> {
    try {
      return await this.adjustProductInventory.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
      )
    } catch (error: unknown) {
      throw AdminProductsController.translate(error)
    }
  }

  @Patch(':id/premium')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'configureCatalogProductPremiumV1',
    summary: 'Activa o actualiza la condicion premium y el precio en moneda real de un producto',
  })
  @ApiParam({ name: 'id', description: 'Identificador del producto canonico' })
  @ApiResponse({ status: 200, description: 'Premium configurado', type: CanonicalProductResponse })
  @ApiResponse({ status: 400, description: 'Cuerpo o campos no declarados invalidos' })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado o segundo factor ausente' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  @ApiResponse({ status: 409, description: 'Otro ajuste modifico el producto entre medias' })
  @ApiResponse({
    status: 422,
    description:
      'Precio en moneda real invalido para la condicion premium solicitada, o intento de retirar premium (no soportado todavia)',
  })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async configurePremium(
    @Param('id') id: string,
    @Body() body: ConfigurePremiumRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
  ): Promise<CanonicalProductDto> {
    try {
      return await this.configureProductPremium.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
      )
    } catch (error: unknown) {
      throw AdminProductsController.translate(error)
    }
  }

  /**
   * Se OMITEN las claves ausentes en lugar de escribirlas como `undefined`: el
   * controlador de MongoDB serializa `undefined` como null y el validador de
   * `audit_log` exige texto. Un testimonio de acceso de Cognito no lleva
   * `email`.
   */
  private static buildActor(identity: VerifiedIdentity): AuditActor {
    return {
      subject: identity.subject,
      ...(identity.email === null ? {} : { email: identity.email }),
      ...(() => {
        const rol = [...identity.roles][0]

        return rol === undefined ? {} : { role: rol }
      })(),
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof CanonicalProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof CanonicalProductConcurrencyConflictError) {
      return new ConflictException(error.message)
    }

    if (error instanceof DomainError) {
      // El tiraje mal formado es un error de FORMA -400-; que sea inferior a
      // las unidades entregadas es una invariante de negocio -422-. CA-02 pide
      // 422 para los dos casos que enumera, y los dos caen de este lado.
      return AdminProductsController.isRequestShapeError(error)
        ? new BadRequestException(error.message)
        : new UnprocessableEntityException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }

  private static isRequestShapeError(error: DomainError): boolean {
    return /no es una propiedad admitida|es obligatorio\.|debe ser (un objeto|texto|un entero|booleano|una lista)\./u.test(
      error.message,
    )
  }
}
