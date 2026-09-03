import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { CanonicalProductResponse } from './canonical-products.dto'

export class CatalogStorefrontRequest {
  @ApiPropertyOptional({
    description: 'Búsqueda literal en nombre, descripción, SKU, tipo, atributos y precios.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string

  @ApiPropertyOptional({ enum: ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'] })
  @IsOptional()
  @IsIn(['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'])
  type?: string

  @ApiPropertyOptional({
    description: 'Importe mínimo en unidades menores de currency; requiere currency.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  minPrice?: number

  @ApiPropertyOptional({
    description: 'Importe máximo en unidades menores de currency; requiere currency.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  maxPrice?: number

  @ApiPropertyOptional({
    enum: ['COP', 'USD', 'EUR'],
    description: 'Moneda exacta del precio real; no implica conversión geográfica.',
  })
  @IsOptional()
  @IsIn(['COP', 'USD', 'EUR'])
  currency?: string

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 16))
  page?: number
}

export class CatalogStorefrontResponse {
  @ApiProperty({ type: CanonicalProductResponse, isArray: true })
  items!: CanonicalProductResponse[]

  @ApiProperty({ minimum: 1 })
  page!: number

  @ApiProperty({ enum: [16] })
  pageSize!: 16

  @ApiProperty({ minimum: 0 })
  total!: number
}
