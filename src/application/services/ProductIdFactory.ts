import { ProductId } from '../../domain/value-objects/canonical-product-values'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'

/** Genera la identidad fuera del dominio y valida el resultado como ProductId. */
export class ProductIdFactory {
  constructor(private readonly generator: IdGeneratorPort) {}

  create(): ProductId {
    return ProductId.create(this.generator.generate())
  }
}
