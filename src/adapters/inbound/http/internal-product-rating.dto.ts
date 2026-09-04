import { ApiProperty } from '@nestjs/swagger'
import { IsInt, IsNumber, Min, ValidateIf } from 'class-validator'

/**
 * Cuerpo del empuje interno de calificacion (HU-40, CA-03).
 *
 * `averageRating` acepta `null`: es el valor exacto para un producto sin
 * calificaciones, y `ValidateIf` deja pasar ese caso sin exigir el rango
 * numerico que sí aplica cuando hay al menos una.
 */
export class UpdateProductRatingRequest {
  @ApiProperty({ example: 4.5, minimum: 1, maximum: 5, nullable: true })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsNumber()
  averageRating!: number | null

  @ApiProperty({ example: 2, minimum: 0 })
  @IsInt()
  @Min(0)
  reviewCount!: number
}
