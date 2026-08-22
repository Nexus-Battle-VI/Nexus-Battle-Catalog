import { DomainError } from '../errors/DomainError'
import type { DomainEvent } from '../events/DomainEvent'
import { productArchived, productPriceChanged, productPublished } from '../events/ProductEvents'
import type { Category, Money, ProductName, Sku } from '../value-objects/catalog-values'

/**
 * Ciclo de vida de un producto del catalogo.
 *
 * `Draft` existe pero no es visible; `Published` es visible y comprable;
 * `Archived` deja de ser visible sin desaparecer, porque los pedidos ya
 * confirmados siguen refiriendose a el.
 */
export const ProductStatus = {
  Draft: 'DRAFT',
  Published: 'PUBLISHED',
  Archived: 'ARCHIVED',
} as const

export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus]

export interface ProductSnapshot {
  readonly sku: string
  readonly name: string
  readonly category: string
  readonly priceAmount: number
  readonly priceCurrency: string
  readonly status: ProductStatus
}

/**
 * Raiz de agregado del contexto Catalog.
 *
 * Un producto se crea en borrador y solo pasa a ser visible cuando se publica
 * de forma explicita. Publicar es una decision de negocio, no un efecto
 * colateral de crear: evita que un producto a medio definir aparezca a la
 * venta.
 */
export class Product {
  readonly sku: Sku
  private name: ProductName
  private category: Category
  private price: Money
  private status: ProductStatus
  private readonly events: DomainEvent[] = []

  private constructor(params: {
    sku: Sku
    name: ProductName
    category: Category
    price: Money
    status: ProductStatus
  }) {
    this.sku = params.sku
    this.name = params.name
    this.category = params.category
    this.price = params.price
    this.status = params.status
  }

  /** Crea un producto en borrador. */
  static draft(params: { sku: Sku; name: ProductName; category: Category; price: Money }): Product {
    if (params.price.isZero()) {
      throw new DomainError('Un producto del catalogo no puede tener precio cero.')
    }

    return new Product({ ...params, status: ProductStatus.Draft })
  }

  /** Reconstituye un producto persistido. No emite eventos. */
  static restore(params: {
    sku: Sku
    name: ProductName
    category: Category
    price: Money
    status: ProductStatus
  }): Product {
    return new Product(params)
  }

  get currentName(): ProductName {
    return this.name
  }

  get currentCategory(): Category {
    return this.category
  }

  get currentPrice(): Money {
    return this.price
  }

  get currentStatus(): ProductStatus {
    return this.status
  }

  /** Solo un producto publicado es visible en las consultas publicas. */
  get isVisible(): boolean {
    return this.status === ProductStatus.Published
  }

  get isPurchasable(): boolean {
    return this.status === ProductStatus.Published
  }

  publish(occurredAt: Date): void {
    if (this.status === ProductStatus.Archived) {
      throw new DomainError(
        `El producto ${this.sku.value} esta archivado y debe restaurarse antes de publicarse.`,
      )
    }

    if (this.status === ProductStatus.Published) {
      throw new DomainError(`El producto ${this.sku.value} ya esta publicado.`)
    }

    this.status = ProductStatus.Published
    this.events.push(
      productPublished({
        aggregateId: this.sku.value,
        name: this.name.value,
        category: this.category.value,
        priceAmount: this.price.amount,
        priceCurrency: this.price.currency,
        occurredAt,
      }),
    )
  }

  archive(occurredAt: Date): void {
    if (this.status === ProductStatus.Archived) {
      throw new DomainError(`El producto ${this.sku.value} ya esta archivado.`)
    }

    this.status = ProductStatus.Archived
    this.events.push(productArchived({ aggregateId: this.sku.value, occurredAt }))
  }

  /** Devuelve un producto archivado a borrador, no a publicado. */
  restoreToDraft(): void {
    if (this.status !== ProductStatus.Archived) {
      throw new DomainError(`El producto ${this.sku.value} no esta archivado.`)
    }

    this.status = ProductStatus.Draft
  }

  rename(name: ProductName): void {
    this.name = name
  }

  reclassify(category: Category): void {
    this.category = category
  }

  /**
   * Cambia el precio.
   *
   * Un producto archivado no admite cambios de precio: su precio es el que
   * tenia cuando dejo de venderse, y alterarlo distorsionaria el historico de
   * los pedidos que lo referencian.
   */
  changePrice(price: Money, occurredAt: Date): boolean {
    if (this.status === ProductStatus.Archived) {
      throw new DomainError(
        `El producto ${this.sku.value} esta archivado y no admite cambios de precio.`,
      )
    }

    if (price.isZero()) {
      throw new DomainError('Un producto del catalogo no puede tener precio cero.')
    }

    if (this.price.equals(price)) {
      return false
    }

    const previous = this.price
    this.price = price

    this.events.push(
      productPriceChanged({
        aggregateId: this.sku.value,
        previousAmount: previous.amount,
        newAmount: price.amount,
        currency: price.currency,
        occurredAt,
      }),
    )

    return true
  }

  pullEvents(): readonly DomainEvent[] {
    const pulled = [...this.events]
    this.events.length = 0

    return pulled
  }

  toSnapshot(): ProductSnapshot {
    return {
      sku: this.sku.value,
      name: this.name.value,
      category: this.category.value,
      priceAmount: this.price.amount,
      priceCurrency: this.price.currency,
      status: this.status,
    }
  }
}
