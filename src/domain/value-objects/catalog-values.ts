import { DomainError } from '../errors/DomainError'

/**
 * Referencia comercial de un producto.
 *
 * Es el identificador natural del catalogo y el que usan los demas contextos
 * (Player/Inventory y Commerce) para referirse a un producto sin conocer su
 * modelo interno.
 */
export class Sku {
  private static readonly PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): Sku {
    const normalized = raw.trim().toLowerCase()

    if (!Sku.PATTERN.test(normalized)) {
      throw new DomainError(`La referencia "${raw}" no es valida. Se espera kebab-case.`)
    }

    return new Sku(normalized)
  }

  equals(other: Sku): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class ProductName {
  static readonly MIN_LENGTH = 3
  static readonly MAX_LENGTH = 80

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): ProductName {
    const normalized = raw.trim().replace(/\s+/gu, ' ')

    if (normalized.length < ProductName.MIN_LENGTH || normalized.length > ProductName.MAX_LENGTH) {
      throw new DomainError(
        `El nombre del producto debe tener entre ${String(ProductName.MIN_LENGTH)} y ${String(ProductName.MAX_LENGTH)} caracteres.`,
      )
    }

    return new ProductName(normalized)
  }

  equals(other: ProductName): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export class Category {
  private static readonly PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): Category {
    const normalized = raw.trim().toLowerCase()

    if (!Category.PATTERN.test(normalized)) {
      throw new DomainError(`La categoria "${raw}" no es valida. Se espera kebab-case.`)
    }

    return new Category(normalized)
  }

  equals(other: Category): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

/**
 * Importe monetario.
 *
 * La cantidad se guarda como **entero en la unidad minima de la moneda**
 * (centavos). Es la decision central de este objeto de valor: representar
 * dinero con numeros de punto flotante produce errores de redondeo que se
 * acumulan al sumar lineas de un pedido, y ese error es visible para quien
 * compra.
 */
export class Money {
  static readonly SUPPORTED_CURRENCIES: readonly string[] = ['COP', 'USD', 'EUR']

  readonly amount: number
  readonly currency: string

  private constructor(amount: number, currency: string) {
    this.amount = amount
    this.currency = currency
  }

  static create(amount: number, currency: string): Money {
    const normalizedCurrency = currency.trim().toUpperCase()

    if (!Money.SUPPORTED_CURRENCIES.includes(normalizedCurrency)) {
      throw new DomainError(
        `La moneda "${currency}" no esta soportada. Se admiten: ${Money.SUPPORTED_CURRENCIES.join(', ')}.`,
      )
    }

    if (!Number.isInteger(amount)) {
      throw new DomainError(
        `El importe debe ser un entero en la unidad minima de la moneda. Se recibio ${String(amount)}.`,
      )
    }

    if (amount < 0) {
      throw new DomainError(`El importe no puede ser negativo. Se recibio ${String(amount)}.`)
    }

    return new Money(amount, normalizedCurrency)
  }

  static zero(currency: string): Money {
    return Money.create(0, currency)
  }

  plus(other: Money): Money {
    Money.assertSameCurrency(this, other)

    return Money.create(this.amount + other.amount, this.currency)
  }

  times(factor: number): Money {
    if (!Number.isInteger(factor) || factor < 0) {
      throw new DomainError(
        `El factor debe ser un entero mayor o igual a 0. Se recibio ${String(factor)}.`,
      )
    }

    return Money.create(this.amount * factor, this.currency)
  }

  isZero(): boolean {
    return this.amount === 0
  }

  equals(other: Money): boolean {
    return this.amount === other.amount && this.currency === other.currency
  }

  toString(): string {
    return `${String(this.amount)} ${this.currency}`
  }

  private static assertSameCurrency(left: Money, right: Money): void {
    if (left.currency !== right.currency) {
      throw new DomainError(
        `No se pueden operar importes en monedas distintas: ${left.currency} y ${right.currency}.`,
      )
    }
  }
}
