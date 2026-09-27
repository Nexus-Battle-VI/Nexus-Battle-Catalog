import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Query,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  CanonicalProductAlreadyExistsError,
  CanonicalProductConcurrencyConflictError,
  CanonicalProductNotFoundError,
  ProductPremiumPurchaseConflictError,
} from '../../../application/errors/ApplicationError'
import type { CanonicalProductDto } from '../../../application/dto/CanonicalProductDto'
import type { AdjustProductInventory } from '../../../application/use-cases/AdjustProductInventory'
import type { ConfigureProductPremium } from '../../../application/use-cases/ConfigureProductPremium'
import type { GetCanonicalProduct } from '../../../application/use-cases/GetCanonicalProduct'
import type { UpdateProductLifecycleStatus } from '../../../application/use-cases/UpdateProductLifecycleStatus'
import type {
  AdminProductSearchResult,
  SearchAdminProducts,
} from '../../../application/use-cases/SearchAdminProducts'
import type { UpdateProductDetails } from '../../../application/use-cases/UpdateProductDetails'
import { Role, type VerifiedIdentity } from '../../../application/ports/TokenVerifierPort'
import type { AuditActor } from '../../../application/ports/CanonicalProductPorts'
import type { RequestTraceContext } from '../../../application/ports/RequestTraceContext'
import { resolveCorrelationId } from './correlation-id'
import {
  ADJUST_PRODUCT_INVENTORY,
  CONFIGURE_PRODUCT_PREMIUM,
  GET_CANONICAL_PRODUCT,
  SEARCH_ADMIN_PRODUCTS,
  UPDATE_PRODUCT_DETAILS,
  UPDATE_PRODUCT_LIFECYCLE_STATUS,
} from './tokens'
import { CurrentIdentity, RequiresMfaEvidence, Roles } from './auth/decorators'
import {
  AdjustInventoryRequest,
  AdminProductSearchRequest,
  AdminProductSearchResponse,
  CanonicalProductResponse,
  ConfigurePremiumRequest,
  UpdateProductDetailsRequest,
  UpdateProductStatusRequest,
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
    @Inject(UPDATE_PRODUCT_LIFECYCLE_STATUS)
    private readonly updateProductLifecycleStatus: UpdateProductLifecycleStatus,
    @Inject(SEARCH_ADMIN_PRODUCTS)
    private readonly searchAdminProducts: SearchAdminProducts,
    @Inject(UPDATE_PRODUCT_DETAILS)
    private readonly updateProductDetails: UpdateProductDetails,
  ) {}

  /**
   * Busqueda/listado administrativo del catalogo completo (crear, editar,
   * eliminar y buscar productos: pedido explicito del cliente del proyecto
   * tras revisar el panel de administracion).
   *
   * INCLUYE SUSPENDED. La vitrina publica (`GET /v1/catalog/products`) filtra
   * por `lifecycleStatus: ACTIVE` a proposito -es su invariante de CA-01/
   * CA-03 de HU-34/HU-35-; este listado es exactamente para lo que esa
   * vitrina no sirve: encontrar un producto suspendido para reactivarlo o
   * auditarlo.
   *
   * Es LECTURA: mismo criterio que `GET :id`, no exige evidencia de segundo
   * factor.
   */
  @Get()
  @Roles(Role.Administrator)
  @ApiOperation({
    operationId: 'searchCatalogProductsForAdministrationV1',
    summary: 'Busca y lista el catalogo completo, incluidos los productos suspendidos',
  })
  @ApiResponse({
    status: 200,
    description: 'Pagina de resultados',
    type: AdminProductSearchResponse,
  })
  @ApiResponse({ status: 400, description: 'Filtro invalido' })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado' })
  async search(@Query() query: AdminProductSearchRequest): Promise<AdminProductSearchResult> {
    try {
      return await this.searchAdminProducts.execute(query)
    } catch (error: unknown) {
      // Mismo criterio que `CanonicalProductsController.list` (vitrina
      // publica): es una LECTURA con filtros, no una mutacion sobre un
      // producto. Cualquier `DomainError` aqui es un filtro mal formado -no
      // hay una regla de negocio del producto que pueda fallar al listar-,
      // asi que siempre es 400, sin la distincion 400/422 de las mutaciones.
      if (error instanceof DomainError) throw new BadRequestException(error.message)
      throw error
    }
  }

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
    @Headers('x-correlation-id') rawCorrelationId: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CanonicalProductDto> {
    const trace: RequestTraceContext = { correlationId: resolveCorrelationId(rawCorrelationId) }
    response.setHeader('x-correlation-id', trace.correlationId)

    try {
      return await this.adjustProductInventory.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
        trace,
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
  @ApiResponse({
    status: 409,
    description:
      'Otro ajuste modifico el producto entre medias, o se intento retirar premium de un producto con compras en moneda real ya registradas',
  })
  @ApiResponse({
    status: 422,
    description: 'Precio en moneda real invalido para la condicion premium solicitada',
  })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async configurePremium(
    @Param('id') id: string,
    @Body() body: ConfigurePremiumRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
    @Headers('x-correlation-id') rawCorrelationId: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CanonicalProductDto> {
    const trace: RequestTraceContext = { correlationId: resolveCorrelationId(rawCorrelationId) }
    response.setHeader('x-correlation-id', trace.correlationId)

    try {
      return await this.configureProductPremium.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
        trace,
      )
    } catch (error: unknown) {
      throw AdminProductsController.translate(error)
    }
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'updateCatalogProductStatusV1',
    summary: 'Suspende (borrado logico) o reactiva un producto',
  })
  @ApiParam({ name: 'id', description: 'Identificador del producto canonico' })
  @ApiResponse({
    status: 200,
    description: 'Estado actualizado (o ya se encontraba en el estado solicitado)',
    type: CanonicalProductResponse,
  })
  @ApiResponse({
    status: 400,
    description: 'Cuerpo o campos no declarados invalidos, o motivo ausente/menor a 10 caracteres',
  })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado o segundo factor ausente' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateProductStatusRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
    @Headers('x-correlation-id') rawCorrelationId: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CanonicalProductDto> {
    const trace: RequestTraceContext = { correlationId: resolveCorrelationId(rawCorrelationId) }
    response.setHeader('x-correlation-id', trace.correlationId)

    try {
      return await this.updateProductLifecycleStatus.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
        trace,
      )
    } catch (error: unknown) {
      throw AdminProductsController.translate(error)
    }
  }

  /**
   * Edita los campos de presentacion de un producto ya existente: `name`,
   * `imageUrl`, `description` (pedido explicito del cliente del proyecto:
   * "editar productos" en el panel de administracion).
   *
   * `type` Y `attributes` NO SON EDITABLES. `UpdateProductDetailsRequest` ni
   * siquiera los declara, asi que el `ValidationPipe` global
   * (`whitelist: true`, `forbidNonWhitelisted: true`, `main.ts`) responde 400
   * si alguien los envia, antes de que este metodo se ejecute.
   */
  @Patch(':id/details')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @ApiOperation({
    operationId: 'updateCatalogProductDetailsV1',
    summary: 'Edita nombre, imagen y/o descripcion de un producto canonico',
  })
  @ApiParam({ name: 'id', description: 'Identificador del producto canonico' })
  @ApiResponse({
    status: 200,
    description: 'Detalles actualizados',
    type: CanonicalProductResponse,
  })
  @ApiResponse({
    status: 400,
    description:
      'Cuerpo o campos no declarados invalidos (incluye `type`/`attributes`), o ningun campo editable presente',
  })
  @ApiResponse({ status: 401, description: 'Testimonio ausente, invalido o vencido' })
  @ApiResponse({ status: 403, description: 'Rol no autorizado o segundo factor ausente' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  @ApiResponse({
    status: 409,
    description:
      'Otro ajuste modifico el producto entre medias, o el nuevo nombre ya pertenece a otro producto activo del mismo tipo',
  })
  @ApiResponse({
    status: 422,
    description: 'Regla de forma del dominio incumplida (longitud, URL, etc.)',
  })
  @ApiResponse({ status: 503, description: 'No se pudo comprobar el segundo factor' })
  async updateDetails(
    @Param('id') id: string,
    @Body() body: UpdateProductDetailsRequest,
    @CurrentIdentity() identity: VerifiedIdentity,
    @Headers('x-correlation-id') rawCorrelationId: string | string[] | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CanonicalProductDto> {
    const trace: RequestTraceContext = { correlationId: resolveCorrelationId(rawCorrelationId) }
    response.setHeader('x-correlation-id', trace.correlationId)

    try {
      return await this.updateProductDetails.execute(
        id,
        body,
        AdminProductsController.buildActor(identity),
        trace,
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

    if (
      error instanceof CanonicalProductConcurrencyConflictError ||
      error instanceof ProductPremiumPurchaseConflictError ||
      // Renombrar un producto (`PATCH :id/details`) puede chocar con el mismo
      // indice unico parcial que la creacion (`normalizedName` + `type` +
      // `lifecycleStatus: ACTIVE`): el mismo error, la misma traduccion a 409.
      error instanceof CanonicalProductAlreadyExistsError
    ) {
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
    // "Debe tener al menos N caracteres" entra aqui a proposito: CA-02 de
    // HU-35 exige 400 tanto para el motivo ausente como para uno demasiado
    // corto, tratando ambos como el mismo tipo de defecto (forma de la
    // solicitud), no como una regla de negocio sobre el producto.
    //
    // "Debe incluir al menos un campo editable" (PATCH :id/details) entra por
    // el mismo criterio: un cuerpo sin ningun campo util es un defecto de
    // FORMA de la solicitud, no una regla de negocio sobre el producto.
    return /no es una propiedad admitida|es obligatorio\.|debe ser (un objeto|texto|un entero|booleano|una lista)\.|debe tener al menos \d+ caracteres\.|debe incluir al menos un campo editable|debe ser uno de: /u.test(
      error.message,
    )
  }
}
