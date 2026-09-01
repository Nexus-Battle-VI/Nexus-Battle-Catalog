import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'
import type { ProductId, ProductType } from '../../domain/value-objects/canonical-product-values'

export const HeroCombatBranch = {
  Offensive: 'OFFENSIVE',
  Healing: 'HEALING',
} as const

export type HeroCombatBranch = (typeof HeroCombatBranch)[keyof typeof HeroCombatBranch]

export interface HeroSubtypeDefinition {
  readonly code: string
  readonly combatBranch: HeroCombatBranch
}

export interface HeroSubtypeRegistryPort {
  findByCode(code: string): Promise<HeroSubtypeDefinition | null>
}

export interface ProductReferenceQueryPort {
  findTypeById(productId: ProductId): Promise<ProductType | null>
}

/** Puerto que #134 implementará con una escritura atómica en MongoDB. */
export interface CanonicalProductWritePort {
  existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean>
  create(product: CanonicalProduct): Promise<void>
}

export const HERO_SUBTYPE_REGISTRY = Symbol('HeroSubtypeRegistryPort')
export const PRODUCT_REFERENCE_QUERY = Symbol('ProductReferenceQueryPort')
export const CANONICAL_PRODUCT_WRITE = Symbol('CanonicalProductWritePort')
