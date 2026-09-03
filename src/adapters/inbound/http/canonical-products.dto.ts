import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const PRODUCT_TYPES = ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'] as const

export class RealMoneyPriceRequest {
  @ApiProperty({ minimum: 1, example: 999 })
  @IsInt()
  @Min(1)
  amount!: number

  @ApiProperty({ enum: ['COP', 'USD', 'EUR'], example: 'USD' })
  @IsIn(['COP', 'USD', 'EUR'])
  currency!: string
}

/**
 * Forma de transporte de POST /api/v1/catalog/products.
 *
 * Las variantes cerradas de attributes se validan por el parser de dominio,
 * que conoce su discriminador `kind`; los campos derivados no se declaran aquí
 * y por tanto el ValidationPipe los rechaza antes de ejecutar el caso de uso.
 */
export class CreateCanonicalProductRequest {
  @ApiPropertyOptional({
    deprecated: true,
    pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
    description: 'Alias temporal. Catalog lo genera si se omite.',
  })
  @IsOptional()
  @IsString()
  @Matches(KEBAB)
  sku?: string

  @ApiProperty({ minLength: 3, maxLength: 80, example: 'Espada de Fuego' })
  @IsString()
  @Length(3, 80)
  name!: string

  @ApiProperty({ format: 'uri', example: 'https://assets.example.test/catalog/espada.webp' })
  @IsString()
  @IsUrl({ require_protocol: true })
  imageUrl!: string

  @ApiProperty({ minLength: 1, example: 'Espada de dos manos con daño de fuego.' })
  @IsString()
  @Length(1, 10_000)
  description!: string

  @ApiProperty({ enum: ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'] })
  @IsIn(['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'])
  type!: string

  @ApiProperty({
    description: 'Sobre versionado y variante discriminada por attributes.values.kind.',
  })
  @IsObject()
  attributes!: object

  @ApiProperty({ description: '-1 infinito; 1 único; >= 2 limitado.', example: 150 })
  @IsInt()
  printRun!: number

  @ApiProperty({ minimum: 0, example: 40 })
  @IsInt()
  @Min(0)
  creditsPrice!: number

  @ApiProperty({ description: 'Si es true, realMoneyPrice es obligatorio.' })
  @IsBoolean()
  premium!: boolean

  @ApiPropertyOptional({ type: RealMoneyPriceRequest, nullable: true })
  @ValidateIf(
    (request: CreateCanonicalProductRequest) =>
      request.realMoneyPrice !== undefined && request.realMoneyPrice !== null,
  )
  @ValidateNested()
  @Type(() => RealMoneyPriceRequest)
  realMoneyPrice?: RealMoneyPriceRequest | null
}

export class CanonicalProductResponse {
  @ApiProperty({ format: 'uuid', readOnly: true })
  productId!: string

  @ApiProperty({ deprecated: true, readOnly: true })
  sku!: string

  @ApiProperty()
  name!: string

  @ApiProperty({ format: 'uri' })
  imageUrl!: string

  @ApiProperty()
  description!: string

  @ApiProperty({ enum: ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'] })
  type!: string

  @ApiProperty({ type: 'object', additionalProperties: true })
  attributes!: object

  @ApiProperty()
  printRun!: number

  @ApiProperty({ enum: ['UNIQUE', 'LIMITED', 'INFINITE'], readOnly: true })
  printRunMode!: string

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'], readOnly: true })
  lifecycleStatus!: string

  @ApiProperty()
  creditsPrice!: number

  @ApiProperty()
  premium!: boolean

  @ApiPropertyOptional({ type: RealMoneyPriceRequest, nullable: true })
  realMoneyPrice!: RealMoneyPriceRequest | null

  @ApiProperty({ format: 'date-time', readOnly: true })
  createdAt!: string

  @ApiProperty({ format: 'date-time', readOnly: true })
  updatedAt!: string

  @ApiProperty({ example: 0, readOnly: true })
  version!: number
}

/**
 * Cuerpo de POST /api/v1/catalog/products/lookup.
 *
 * Es una CONSULTA (no muta): resuelve muchas referencias en una sola llamada
 * para que un consumidor —Player/Inventory en HU-27— evite un N+1. `references`
 * casa cada valor contra `productId` (UUID) o contra el alias `sku`.
 */
export class LookupCanonicalProductsRequest {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 500,
    description: 'productId (UUID) o sku alias de cada producto poseído por el consumidor.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Length(1, 128, { each: true })
  references!: string[]

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 80,
    description: 'Filtra por substring del nombre normalizado (NFKC + minúsculas).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  query?: string

  @ApiPropertyOptional({ enum: PRODUCT_TYPES })
  @IsOptional()
  @IsIn(PRODUCT_TYPES)
  type?: string
}

export class LookupCanonicalProductsResponse {
  @ApiProperty({ type: CanonicalProductResponse, isArray: true })
  items!: CanonicalProductResponse[]
}
