import { ProductId } from '../../domain/value-objects/canonical-product-values'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import { CanonicalProductNotFoundError } from '../errors/ApplicationError'
import type { CanonicalProductWritePort } from '../ports/CanonicalProductPorts'

export interface GetCanonicalProductDependencies {
  readonly products: CanonicalProductWritePort
}

/**
 * Lectura administrativa de un producto canónico (HU-34).
 *
 * EXISTE PARA QUE LA PANTALLA PUEDA MOSTRAR LA DISPONIBILIDAD antes de
 * ajustarla. Sin ella, el formulario de tiraje solo podria enseñar el resultado
 * DESPUES de escribir, que es justo cuando ya no sirve para decidir.
 *
 * NO es la lectura publica del catalogo. Vive bajo `v1/admin`, exige rol
 * administrativo y expone `availableUnits`, que es informacion de gestion: la
 * vitrina no necesita saber cuantas unidades quedan para pintar un producto.
 */
export class GetCanonicalProduct {
  constructor(private readonly deps: GetCanonicalProductDependencies) {}

  async execute(rawProductId: string): Promise<CanonicalProductDto> {
    const productId = ProductId.create(rawProductId)
    const producto = await this.deps.products.findById(productId)

    if (producto === null) {
      throw new CanonicalProductNotFoundError(productId.value)
    }

    return toCanonicalProductDto(producto.toSnapshot())
  }
}
