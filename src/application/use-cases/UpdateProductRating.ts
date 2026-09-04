import { ProductId } from '../../domain/value-objects/canonical-product-values'
import {
  asStrictObject,
  parseInteger,
  parseNumber,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import { CanonicalProductNotFoundError } from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { CanonicalProductWritePort } from '../ports/CanonicalProductPorts'

export interface UpdateProductRatingDependencies {
  readonly products: CanonicalProductWritePort
  readonly clock: ClockPort
}

/**
 * Aplica sobre el producto canónico el promedio y el conteo de
 * calificaciones ya calculados por Community (HU-40, CA-03).
 *
 * Quien llama es el contrato interno `POST
 * /internal/v1/catalog/products/:id/rating` (ver
 * `InternalProductRatingController`): la petición ya llegó autenticada por
 * `InternalServiceGuard`, así que este caso de uso no vuelve a comprobar
 * identidad, solo forma y consistencia del comando.
 *
 * NO ES UN INCREMENTO. `averageRating`/`reviewCount` son el agregado final
 * que Community ya calculó sobre SUS propias calificaciones; un reintento con
 * el mismo par de valores dos veces produce el mismo resultado, sin volver a
 * sumar nada aquí.
 */
export class UpdateProductRating {
  constructor(private readonly deps: UpdateProductRatingDependencies) {}

  async execute(rawProductId: string, rawCommand: unknown): Promise<void> {
    const productId = ProductId.create(rawProductId)
    const record = asStrictObject(rawCommand, 'command', ['averageRating', 'reviewCount'])

    const rawAverage = requiredValue(record, 'averageRating', 'command')
    const averageRating =
      rawAverage === null
        ? null
        : parseNumber(rawAverage, 'command.averageRating', { minimum: 1, maximum: 5 })
    const reviewCount = parseInteger(
      requiredValue(record, 'reviewCount', 'command'),
      'command.reviewCount',
      {
        minimum: 0,
      },
    )

    const matched = await this.deps.products.updateRating(
      productId,
      { averageRating, reviewCount },
      this.deps.clock.now(),
    )

    if (!matched) {
      throw new CanonicalProductNotFoundError(productId.value)
    }
  }
}
