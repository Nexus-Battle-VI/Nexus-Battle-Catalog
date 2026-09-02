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
  Post,
  Query,
} from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'

import { DomainError } from '../../../domain/errors/DomainError'
import {
  ProductAlreadyExistsError,
  ProductNotFoundError,
} from '../../../application/errors/ApplicationError'
import type {
  ArchiveProduct,
  ChangeProductPrice,
  CreateProduct,
  GetProduct,
  ListProducts,
  PublishProduct,
} from '../../../application/use-cases/ProductUseCases'
import {
  ARCHIVE_PRODUCT,
  CHANGE_PRICE,
  CREATE_PRODUCT,
  GET_PRODUCT,
  LIST_PRODUCTS,
  PUBLISH_PRODUCT,
} from './tokens'
import { Role } from '../../../application/ports/TokenVerifierPort'
import { Public, RequiresMfaEvidence, Roles } from './auth/decorators'
import { ChangePriceRequest, CreateProductRequest, ProductResponse } from './products.dto'

/**
 * Adaptador de entrada HTTP.
 *
 * Traduce entre el protocolo y los casos de uso. No contiene reglas de negocio:
 * la visibilidad de un producto, el limite de precio y las transiciones de
 * estado viven en el dominio.
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(
    @Inject(CREATE_PRODUCT) private readonly createProduct: CreateProduct,
    @Inject(PUBLISH_PRODUCT) private readonly publishProduct: PublishProduct,
    @Inject(ARCHIVE_PRODUCT) private readonly archiveProduct: ArchiveProduct,
    @Inject(CHANGE_PRICE) private readonly changePrice: ChangeProductPrice,
    @Inject(GET_PRODUCT) private readonly getProduct: GetProduct,
    @Inject(LIST_PRODUCTS) private readonly listProducts: ListProducts,
  ) {}

  // Crear, publicar, archivar y cambiar el precio son operaciones de gestion
  // del catalogo. Antes no exigian nada: cualquiera podia poner a la venta un
  // producto o cambiarle el precio.
  //
  // `@RequiresMfaEvidence()` acompana a `@Roles(...)` en las cuatro. El rol dice
  // quien es; la evidencia dice que ESTE testimonio nacio de un segundo factor.
  // Sin ella, un token administrativo obtenido sin segundo factor abriria las
  // mismas puertas que uno obtenido con el.
  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Crea un producto en borrador' })
  @ApiResponse({ status: 201, description: 'Producto creado', type: ProductResponse })
  @ApiResponse({ status: 400, description: 'Datos invalidos' })
  @ApiResponse({ status: 409, description: 'La referencia ya existe' })
  async create(@Body() body: CreateProductRequest): Promise<ProductResponse> {
    try {
      return await this.createProduct.execute(body)
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Lista los productos publicados' })
  @ApiQuery({ name: 'category', required: false, example: 'armas' })
  @ApiResponse({ status: 200, description: 'Listado', type: ProductResponse, isArray: true })
  async list(@Query('category') category?: string): Promise<readonly ProductResponse[]> {
    try {
      return await this.listProducts.execute(category)
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  @Public()
  @Get(':sku')
  @ApiOperation({ summary: 'Recupera un producto publicado' })
  @ApiResponse({ status: 200, description: 'Producto encontrado', type: ProductResponse })
  @ApiResponse({ status: 404, description: 'El producto no existe o no esta publicado' })
  async findOne(@Param('sku') sku: string): Promise<ProductResponse> {
    try {
      return await this.getProduct.execute(sku)
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @Post(':sku/publication')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publica un producto' })
  @ApiResponse({ status: 200, description: 'Producto publicado', type: ProductResponse })
  @ApiResponse({ status: 400, description: 'El producto no admite publicacion' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  async publish(@Param('sku') sku: string): Promise<ProductResponse> {
    try {
      return await this.publishProduct.execute(sku)
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @Post(':sku/archival')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archiva un producto' })
  @ApiResponse({ status: 200, description: 'Producto archivado', type: ProductResponse })
  @ApiResponse({ status: 400, description: 'El producto ya estaba archivado' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  async archive(@Param('sku') sku: string): Promise<ProductResponse> {
    try {
      return await this.archiveProduct.execute(sku)
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  @Roles(Role.Administrator)
  @RequiresMfaEvidence()
  @Post(':sku/price')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cambia el precio de un producto' })
  @ApiResponse({ status: 200, description: 'Precio actualizado', type: ProductResponse })
  @ApiResponse({ status: 400, description: 'Precio invalido o producto archivado' })
  @ApiResponse({ status: 404, description: 'El producto no existe' })
  async updatePrice(
    @Param('sku') sku: string,
    @Body() body: ChangePriceRequest,
  ): Promise<ProductResponse> {
    try {
      return await this.changePrice.execute({
        sku,
        priceAmount: body.priceAmount,
        priceCurrency: body.priceCurrency,
      })
    } catch (error: unknown) {
      throw ProductsController.translate(error)
    }
  }

  private static translate(error: unknown): Error {
    if (error instanceof ProductAlreadyExistsError) {
      return new ConflictException(error.message)
    }

    if (error instanceof ProductNotFoundError) {
      return new NotFoundException(error.message)
    }

    if (error instanceof DomainError) {
      return new BadRequestException(error.message)
    }

    return error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
  }
}
