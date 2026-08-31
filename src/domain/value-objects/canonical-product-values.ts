import { DomainError } from '../errors/DomainError'
import type { Money } from './catalog-values'

/** Identidad canónica de Producto. El cliente nunca la proporciona. */
export class ProductId {
  private static readonly UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  readonly value: string

  private constructor(value: string) {
    this.value = value
  }

  static create(raw: string): ProductId {
    const normalized = raw.trim().toLowerCase()

    if (!ProductId.UUID_PATTERN.test(normalized)) {
      throw new DomainError(`El productId "${raw}" no es un UUID valido.`)
    }

    return new ProductId(normalized)
  }

  equals(other: ProductId): boolean {
    return this.value === other.value
  }

  toString(): string {
    return this.value
  }
}

export const ProductType = {
  Hero: 'HEROE',
  Ability: 'HABILIDAD',
  Weapon: 'ARMA',
  Armor: 'ARMADURA',
  Item: 'ITEM',
  Epic: 'EPICA',
} as const

export type ProductType = (typeof ProductType)[keyof typeof ProductType]

export const parseProductType = (raw: string): ProductType => {
  const candidate = raw.trim()
  const supportedTypes: readonly string[] = Object.values(ProductType)

  if (!supportedTypes.includes(candidate)) {
    throw new DomainError(
      `El tipo de producto "${raw}" no es valido. Se admiten: ${supportedTypes.join(', ')}.`,
    )
  }

  return candidate as ProductType
}

export const LifecycleStatus = {
  Active: 'ACTIVE',
  Suspended: 'SUSPENDED',
} as const

export type LifecycleStatus = (typeof LifecycleStatus)[keyof typeof LifecycleStatus]

export const PrintRunMode = {
  Unique: 'UNIQUE',
  Limited: 'LIMITED',
  Infinite: 'INFINITE',
} as const

export type PrintRunMode = (typeof PrintRunMode)[keyof typeof PrintRunMode]

/**
 * Tiraje solicitado por el negocio.
 *
 * `-1` conserva el valor especial del lineamiento. La modalidad derivada evita
 * que cada consumidor tenga que reinterpretarlo.
 */
export class PrintRun {
  readonly value: number
  readonly mode: PrintRunMode

  private constructor(value: number, mode: PrintRunMode) {
    this.value = value
    this.mode = mode
  }

  static create(value: number): PrintRun {
    if (!Number.isInteger(value) || value === 0 || value < -1) {
      throw new DomainError(
        `El tiraje debe ser un entero positivo o -1 para tiraje infinito. Se recibio ${String(value)}.`,
      )
    }

    if (value === -1) {
      return new PrintRun(value, PrintRunMode.Infinite)
    }

    if (value === 1) {
      return new PrintRun(value, PrintRunMode.Unique)
    }

    return new PrintRun(value, PrintRunMode.Limited)
  }

  get isInfinite(): boolean {
    return this.mode === PrintRunMode.Infinite
  }

  equals(other: PrintRun): boolean {
    return this.value === other.value
  }

  toString(): string {
    return String(this.value)
  }
}

export type FunctionalProductStatus = 'activo' | 'único' | 'suspendido'

export const projectFunctionalStatus = (
  lifecycleStatus: LifecycleStatus,
  printRunMode: PrintRunMode,
): FunctionalProductStatus => {
  if (lifecycleStatus === LifecycleStatus.Suspended) {
    return 'suspendido'
  }

  return printRunMode === PrintRunMode.Unique ? 'único' : 'activo'
}

/** Precio entero en créditos del juego. Cero representa un producto gratuito. */
export class CreditsPrice {
  readonly value: number

  private constructor(value: number) {
    this.value = value
  }

  static create(value: number): CreditsPrice {
    if (!Number.isInteger(value) || value < 0) {
      throw new DomainError(
        `El precio en creditos debe ser un entero mayor o igual a cero. Se recibio ${String(value)}.`,
      )
    }

    return new CreditsPrice(value)
  }

  equals(other: CreditsPrice): boolean {
    return this.value === other.value
  }

  toString(): string {
    return String(this.value)
  }
}

/** Mantiene atómicas la bandera premium y su precio real condicionado. */
export class ProductPricing {
  readonly creditsPrice: CreditsPrice
  readonly premium: boolean
  readonly realMoneyPrice: Money | null

  private constructor(params: {
    creditsPrice: CreditsPrice
    premium: boolean
    realMoneyPrice: Money | null
  }) {
    this.creditsPrice = params.creditsPrice
    this.premium = params.premium
    this.realMoneyPrice = params.realMoneyPrice
  }

  static create(params: {
    creditsPrice: CreditsPrice
    premium: boolean
    realMoneyPrice: Money | null
  }): ProductPricing {
    if (params.premium && (params.realMoneyPrice === null || params.realMoneyPrice.isZero())) {
      throw new DomainError('Un producto premium requiere un precio en moneda real positivo.')
    }

    if (!params.premium && params.realMoneyPrice !== null) {
      throw new DomainError('Un producto no premium no puede tener un precio en moneda real.')
    }

    return new ProductPricing(params)
  }
}
