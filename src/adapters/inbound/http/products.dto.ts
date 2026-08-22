import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsIn, IsInt, IsString, Length, Matches, Min } from 'class-validator'

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export class CreateProductRequest {
  @ApiProperty({ example: 'espada-de-hierro' })
  @IsString()
  @Matches(KEBAB, { message: 'La referencia debe estar en kebab-case.' })
  sku!: string

  @ApiProperty({ example: 'Espada de hierro', minLength: 3, maxLength: 80 })
  @IsString()
  @Length(3, 80)
  name!: string

  @ApiProperty({ example: 'armas' })
  @IsString()
  @Matches(KEBAB, { message: 'La categoria debe estar en kebab-case.' })
  category!: string

  @ApiProperty({
    example: 15000,
    description: 'Importe entero en la unidad minima de la moneda.',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  priceAmount!: number

  @ApiProperty({ example: 'COP', enum: ['COP', 'USD', 'EUR'] })
  @IsIn(['COP', 'USD', 'EUR'])
  priceCurrency!: string
}

export class ChangePriceRequest {
  @ApiProperty({
    example: 18000,
    description: 'Importe entero en la unidad minima de la moneda.',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  priceAmount!: number

  @ApiProperty({ example: 'COP', enum: ['COP', 'USD', 'EUR'] })
  @IsIn(['COP', 'USD', 'EUR'])
  priceCurrency!: string
}

export class MoneyResponse {
  @ApiProperty({ example: 15000 })
  readonly amount!: number

  @ApiProperty({ example: 'COP' })
  readonly currency!: string
}

export class ProductResponse {
  @ApiProperty({ example: 'espada-de-hierro' })
  readonly sku!: string

  @ApiProperty({ example: 'Espada de hierro' })
  readonly name!: string

  @ApiProperty({ example: 'armas' })
  readonly category!: string

  @ApiProperty({ type: MoneyResponse })
  readonly price!: MoneyResponse

  @ApiProperty({ example: 'DRAFT', enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] })
  readonly status!: string
}

export class ListProductsQuery {
  @ApiPropertyOptional({ example: 'armas' })
  @IsString()
  @Matches(KEBAB, { message: 'La categoria debe estar en kebab-case.' })
  category?: string
}
