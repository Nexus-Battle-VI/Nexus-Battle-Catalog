import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsBoolean, IsInt, ValidateIf, ValidateNested } from 'class-validator'
import { Type } from 'class-transformer'

import { RealMoneyPriceRequest } from './canonical-products.dto'

export { CanonicalProductResponse } from './canonical-products.dto'

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
