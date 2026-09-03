import { ApiProperty } from '@nestjs/swagger'
import { IsIn, IsInt, IsNotEmpty, IsPositive, IsString, Max, Min } from 'class-validator'

export class CreateProductAssetUploadRequest {
  @ApiProperty({
    example: 'PRIMARY_IMAGE',
    description: 'Proposito funcional del asset. En HU-33 solo se admite PRIMARY_IMAGE.',
    enum: ['PRIMARY_IMAGE'],
  })
  @IsString()
  @IsIn(['PRIMARY_IMAGE'], {
    message: 'purpose debe ser "PRIMARY_IMAGE"',
  })
  readonly purpose!: string

  @ApiProperty({
    example: 'image/webp',
    description: 'Tipo MIME del archivo. Se admiten image/jpeg, image/png, image/webp.',
    enum: ['image/jpeg', 'image/png', 'image/webp'],
  })
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'], {
    message: 'contentType debe ser image/jpeg, image/png o image/webp',
  })
  readonly contentType!: string

  @ApiProperty({
    example: 245760,
    description: 'Longitud en bytes del archivo. Maximo 5 MiB (5242880 bytes).',
  })
  @IsInt()
  @IsPositive()
  @Min(1)
  @Max(5 * 1024 * 1024, {
    message: 'contentLength no puede superar los 5 MiB (5242880 bytes)',
  })
  readonly contentLength!: number

  @ApiProperty({
    example: 'b64:ZHVtbXktc2hhMjU2LWVqZW1wbG8=',
    description: 'Checksum SHA-256 en formato b64:... o hexadecimal.',
  })
  @IsString()
  @IsNotEmpty({
    message: 'checksumSha256 es obligatorio',
  })
  readonly checksumSha256!: string
}

export class ProductAssetUploadFieldsResponse {
  @ApiProperty({ example: 'staging/f293ce6b-98e9-41da-99ef-0ad4e3a95120' })
  readonly key!: string

  @ApiProperty({ example: 'image/webp' })
  readonly 'Content-Type'!: string

  @ApiProperty({ example: 'b64:ZHVtbXktc2hhMjU2LWVqZW1wbG8=' })
  readonly 'x-amz-checksum-sha256'!: string

  @ApiProperty({ example: '<policy-base64>' })
  readonly policy!: string

  @ApiProperty({ example: 'AWS4-HMAC-SHA256' })
  readonly 'x-amz-algorithm'!: string

  @ApiProperty({ example: '...' })
  readonly 'x-amz-credential'!: string

  @ApiProperty({ example: '20260902T200000Z' })
  readonly 'x-amz-date'!: string

  @ApiProperty({ example: '...' })
  readonly 'x-amz-signature'!: string
}

export class ProductAssetUploadFormResponse {
  @ApiProperty({ example: 'POST' })
  readonly method!: 'POST'

  @ApiProperty({
    example: 'https://nexus-battles-vi-product-assets-658430303197.s3.us-east-1.amazonaws.com',
  })
  readonly url!: string

  @ApiProperty({ type: Object })
  readonly fields!: Record<string, string>

  @ApiProperty({ example: '2026-09-02T20:10:00.000Z' })
  readonly expiresAt!: string
}

export class ProductAssetUploadResponse {
  @ApiProperty({ example: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120' })
  readonly assetId!: string

  @ApiProperty({ type: ProductAssetUploadFormResponse })
  readonly upload!: ProductAssetUploadFormResponse
}

export class FinalizedProductAssetResponse {
  @ApiProperty({ example: 'f293ce6b-98e9-41da-99ef-0ad4e3a95120' })
  readonly assetId!: string

  @ApiProperty({ example: 'PRIMARY_IMAGE' })
  readonly purpose!: string

  @ApiProperty({ example: 'READY' })
  readonly status!: string

  @ApiProperty({ example: 'image/webp' })
  readonly contentType!: string

  @ApiProperty({ example: 245760 })
  readonly contentLength!: number

  @ApiProperty({ example: 1024 })
  readonly width!: number

  @ApiProperty({ example: 1024 })
  readonly height!: number

  @ApiProperty({ example: 'b64:ZHVtbXktc2hhMjU2LWVqZW1wbG8=' })
  readonly checksumSha256!: string

  @ApiProperty({
    example:
      'https://api.simuladorupbbga.app/api/v1/catalog/product-assets/f293ce6b-98e9-41da-99ef-0ad4e3a95120/content',
  })
  readonly imageUrl!: string
}
