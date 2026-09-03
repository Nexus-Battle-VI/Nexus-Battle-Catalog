import { ApiProperty } from '@nestjs/swagger'
import { IsInt } from 'class-validator'

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
