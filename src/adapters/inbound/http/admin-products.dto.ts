import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator'
import { Type } from 'class-transformer'

import { CanonicalProductResponse, RealMoneyPriceRequest } from './canonical-products.dto'

export { CanonicalProductResponse } from './canonical-products.dto'

const PRODUCT_TYPES = ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA'] as const
const LIFECYCLE_STATUSES = ['ACTIVE', 'SUSPENDED'] as const

/**
 * Cuerpo del ajuste de tiraje (HU-34, CA-02).
 *
 * SOLO LLEVA `printRun`. La disponibilidad NO se envia: la calcula el servicio a
 * partir del tiraje nuevo y de las unidades ya entregadas. Dejar que el cliente
 * la fijara permitiria reabrir un producto agotado sin ampliar su tiraje, que es
 * exactamente lo que la HU prohibe.
 *
 * `@IsInt()` es lo unico que se comprueba aqui, y a proposito: es una cuestion
 * de FORMA. Que el entero sea 1 o mas, o exactamente -1, y que no quede por
 * debajo de las unidades entregadas, son reglas de negocio y viven en el
 * dominio, que responde 422. Duplicarlas aqui daria 400 a casos que CA-02 exige
 * que sean 422.
 */
export class AdjustInventoryRequest {
  @ApiProperty({
    description:
      'Nuevo tiraje: un entero mayor o igual a 1 para tiraje limitado, o exactamente -1 para tiraje infinito.',
    example: 350,
  })
  @IsInt()
  printRun!: number
}

/**
 * Cuerpo de la configuracion de tasa de caida Versus (HU-30, Task HU-30.1).
 *
 * SOLO `dropChanceBasisPoints`. Aplica unicamente a productos ARMA, ARMADURA
 * o ITEM -el caso de uso rechaza cualquier otro `type` con 422-; 100 puntos
 * basicos equivalen a 1 %.
 */
export class ConfigureDropChanceRequest {
  @ApiProperty({
    description: 'Tasa de caida Versus en puntos basicos (0-10000; 100 = 1 %).',
    minimum: 0,
    maximum: 10_000,
    example: 500,
  })
  @IsInt()
  @Min(0)
  @Max(10_000)
  dropChanceBasisPoints!: number
}

/**
 * Cuerpo de la configuracion premium (HU-36, CA-01/CA-02).
 *
 * `@IsBoolean()` y la forma anidada de `realMoneyPrice` son las UNICAS
 * comprobaciones de aqui: que premium exija un precio real positivo, o que un
 * producto no premium no lo admita, son reglas de negocio y viven en el
 * dominio (`ProductPricing`), que responde 422.
 *
 * Retirar premium (premium=false sobre un producto ya premium) tambien
 * responde 422: la transicion no esta soportada todavia (HU-36.6, sin
 * resolver). Vease `CanonicalProduct.configurePremium`.
 */
export class ConfigurePremiumRequest {
  @ApiProperty({ description: 'Si es true, realMoneyPrice es obligatorio.' })
  @IsBoolean()
  premium!: boolean

  @ApiPropertyOptional({ type: RealMoneyPriceRequest, nullable: true })
  @ValidateIf(
    (request: ConfigurePremiumRequest) =>
      request.realMoneyPrice !== undefined && request.realMoneyPrice !== null,
  )
  @ValidateNested()
  @Type(() => RealMoneyPriceRequest)
  realMoneyPrice?: RealMoneyPriceRequest | null
}

/**
 * Cuerpo de la suspension/reactivacion (HU-35, CA-01/CA-02/CA-03).
 *
 * `@IsIn`/`@IsString()` son las UNICAS comprobaciones de forma aqui. Que el
 * motivo tenga al menos 10 caracteres es una regla que el propio CA-02 pide
 * que responda 400 (igual que un campo ausente), asi que se valida en el caso
 * de uso con `schema-validation.ts` en vez de aqui, para no duplicar el
 * mensaje en dos capas.
 */
export class UpdateProductStatusRequest {
  @ApiProperty({
    enum: ['SUSPENDED', 'ACTIVE'],
    description: 'Estado destino del producto.',
  })
  @IsIn(['SUSPENDED', 'ACTIVE'])
  status!: 'SUSPENDED' | 'ACTIVE'

  @ApiProperty({
    description: 'Motivo de la suspension o reactivacion. Minimo 10 caracteres.',
    minLength: 10,
    example: 'Rebalanceo pendiente de estadísticas',
  })
  @IsString()
  reason!: string
}

/**
 * Cuerpo de la edicion de campos de presentacion.
 *
 * SOLO `name`, `imageUrl`, `description`. `type` y `attributes` NO se
 * declaran aqui a proposito -no es un descuido de la lista blanca-: con
 * `whitelist: true` y `forbidNonWhitelisted: true` en el `ValidationPipe`
 * global (`main.ts`), cualquier cliente que los envie recibe 400 antes de que
 * el caso de uso llegue a verlos. Combat empareja efectos por `type` y
 * Player-Inventory calcula equipo por `attributes`; editarlos aqui rompería
 * un contrato que otros bounded contexts ya consumen.
 *
 * Los TRES campos son opcionales -se admite cualquier subconjunto-, pero al
 * menos uno es obligatorio; esa regla de forma (igual de "forma" que el
 * motivo de HU-35) se valida en el caso de uso con `schema-validation.ts`, no
 * aqui, para no duplicar el mensaje en dos capas.
 *
 * Los mismos limites de longitud/formato que `CreateCanonicalProductRequest`
 * (creacion): el mismo campo no puede aceptar un rango distinto solo porque
 * llega por la ruta de edicion.
 */
export class UpdateProductDetailsRequest {
  @ApiPropertyOptional({ minLength: 3, maxLength: 80, example: 'Espada de Fuego' })
  @IsOptional()
  @IsString()
  @Length(3, 80)
  name?: string

  @ApiPropertyOptional({
    format: 'uri',
    example: 'https://assets.example.test/catalog/espada.webp',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ require_protocol: true, require_tld: false })
  imageUrl?: string

  @ApiPropertyOptional({ minLength: 1, example: 'Espada de dos manos con daño de fuego.' })
  @IsOptional()
  @IsString()
  @Length(1, 10_000)
  description?: string
}

/**
 * Filtros de la busqueda administrativa (crear/editar/eliminar/buscar
 * productos, pedido explicito del cliente del proyecto).
 *
 * A DIFERENCIA de `CatalogStorefrontRequest` (vitrina publica), `type` no es
 * el unico filtro de estado: `lifecycleStatus` permite ver TAMBIEN los
 * productos suspendidos, que la vitrina publica nunca expone. Sin filtro se
 * devuelven ambos estados.
 *
 * Misma convencion de paginacion que `CatalogStorefrontRequest`: pagina 1-based,
 * paginas estables de 16 productos (`ADMIN_PRODUCT_SEARCH_PAGE_SIZE`), para que
 * los dos listados no diverjan en estilo.
 */
export class AdminProductSearchRequest {
  @ApiPropertyOptional({
    description: 'Busqueda literal en nombre, descripcion, SKU, tipo, atributos y precios.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string

  @ApiPropertyOptional({ enum: PRODUCT_TYPES })
  @IsOptional()
  @IsIn(PRODUCT_TYPES)
  type?: string

  @ApiPropertyOptional({
    enum: PRODUCT_TYPES,
    description:
      'Excluye un tipo del listado. Se ignora si `type` tambien viene en la peticion. Pensado para ' +
      'que la vista por defecto no muestre HABILIDAD -no es un producto vendible por separado, va ' +
      'empaquetada con su HEROE-, sin impedir que un administrador la busque explicitamente con `type`.',
  })
  @IsOptional()
  @IsIn(PRODUCT_TYPES)
  excludeType?: string

  @ApiPropertyOptional({
    enum: LIFECYCLE_STATUSES,
    description: 'Sin filtro, incluye productos ACTIVE y SUSPENDED.',
  })
  @IsOptional()
  @IsIn(LIFECYCLE_STATUSES)
  lifecycleStatus?: string

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 16))
  page?: number
}

export class AdminProductSearchResponse {
  @ApiProperty({ type: CanonicalProductResponse, isArray: true })
  items!: CanonicalProductResponse[]

  @ApiProperty({ minimum: 1 })
  page!: number

  @ApiProperty({ enum: [16] })
  pageSize!: 16

  @ApiProperty({ minimum: 0 })
  total!: number
}
