import { Product } from '../../domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../domain/value-objects/catalog-values'
import type { ClockPort } from '../ports/ClockPort'
import type { ProductRepositoryPort } from '../ports/ProductRepositoryPort'
import { ProductAlreadyExistsError, ProductNotFoundError } from '../errors/ApplicationError'
import { type ProductDto, toProductDto } from '../dto/ProductDto'

export interface ProductDependencies {
  readonly products: ProductRepositoryPort
  readonly clock: ClockPort
}

export interface CreateProductCommand {
  readonly sku: string
  readonly name: string
  readonly category: string
  readonly priceAmount: number
  readonly priceCurrency: string
}

export interface ChangePriceCommand {
  readonly sku: string
  readonly priceAmount: number
  readonly priceCurrency: string
}

/**
 * Crea un producto en estado borrador.
 *
 * Publicar es un paso separado y explicito: crear no expone el producto a la
 * venta, lo que evita que un producto a medio definir aparezca en el catalogo.
 */
export class CreateProduct {
  private readonly deps: ProductDependencies

  constructor(deps: ProductDependencies) {
    this.deps = deps
  }

  async execute(command: CreateProductCommand): Promise<ProductDto> {
    const sku = Sku.create(command.sku)

    const product = Product.draft({
      sku,
      name: ProductName.create(command.name),
      category: Category.create(command.category),
      price: Money.create(command.priceAmount, command.priceCurrency),
    })

    if (!(await this.deps.products.create(product))) {
      throw new ProductAlreadyExistsError(sku.value)
    }

    return toProductDto(product.toSnapshot())
  }
}

/**
 * Publica un producto, haciendolo visible y comprable.
 */
export class PublishProduct {
  private readonly deps: ProductDependencies

  constructor(deps: ProductDependencies) {
    this.deps = deps
  }

  async execute(rawSku: string): Promise<ProductDto> {
    const product = await this.load(rawSku)

    product.publish(this.deps.clock.now())
    await this.deps.products.save(product)
    product.pullEvents()

    return toProductDto(product.toSnapshot())
  }

  private async load(rawSku: string): Promise<Product> {
    const sku = Sku.create(rawSku)
    const product = await this.deps.products.findBySku(sku)

    if (product === null) {
      throw new ProductNotFoundError(sku.value)
    }

    return product
  }
}

/**
 * Archiva un producto. Deja de ser visible sin desaparecer, porque los pedidos
 * ya confirmados siguen refiriendose a el.
 */
export class ArchiveProduct {
  private readonly deps: ProductDependencies

  constructor(deps: ProductDependencies) {
    this.deps = deps
  }

  async execute(rawSku: string): Promise<ProductDto> {
    const sku = Sku.create(rawSku)
    const product = await this.deps.products.findBySku(sku)

    if (product === null) {
      throw new ProductNotFoundError(sku.value)
    }

    product.archive(this.deps.clock.now())
    await this.deps.products.save(product)
    product.pullEvents()

    return toProductDto(product.toSnapshot())
  }
}

/**
 * Cambia el precio de un producto no archivado.
 */
export class ChangeProductPrice {
  private readonly deps: ProductDependencies

  constructor(deps: ProductDependencies) {
    this.deps = deps
  }

  async execute(command: ChangePriceCommand): Promise<ProductDto> {
    const sku = Sku.create(command.sku)
    const product = await this.deps.products.findBySku(sku)

    if (product === null) {
      throw new ProductNotFoundError(sku.value)
    }

    product.changePrice(
      Money.create(command.priceAmount, command.priceCurrency),
      this.deps.clock.now(),
    )

    await this.deps.products.save(product)
    product.pullEvents()

    return toProductDto(product.toSnapshot())
  }
}

/**
 * Recupera un producto por su referencia.
 *
 * Un producto no publicado no es visible en la consulta publica: devolverlo
 * expondria informacion comercial que todavia no esta decidida.
 */
export class GetProduct {
  private readonly products: ProductRepositoryPort

  constructor(products: ProductRepositoryPort) {
    this.products = products
  }

  async execute(rawSku: string, includeHidden = false): Promise<ProductDto> {
    const sku = Sku.create(rawSku)
    const product = await this.products.findBySku(sku)

    if (product === null || (!includeHidden && !product.isVisible)) {
      throw new ProductNotFoundError(sku.value)
    }

    return toProductDto(product.toSnapshot())
  }
}

/**
 * Lista los productos publicados, opcionalmente filtrados por categoria.
 */
export class ListProducts {
  private readonly products: ProductRepositoryPort

  constructor(products: ProductRepositoryPort) {
    this.products = products
  }

  async execute(rawCategory?: string): Promise<readonly ProductDto[]> {
    const category = rawCategory === undefined ? undefined : Category.create(rawCategory)
    const found = await this.products.search(category === undefined ? {} : { category })

    return found.map((product) => toProductDto(product.toSnapshot()))
  }
}
