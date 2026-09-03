import type { CanonicalProduct, CanonicalProductSnapshot } from '../../domain/entities/CanonicalProduct'
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

/** Contexto opaco de transacción, desacoplado del driver subyacente. */
export interface TransactionContext {
  readonly session?: unknown
}

/** Puerto que implementa la escritura canónica de productos, con soporte transaccional. */
export interface CanonicalProductWritePort {
  existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean>
  create(product: CanonicalProduct, context?: TransactionContext): Promise<void>
}

/** Almacén canónico completo durante la transición aditiva de ADR-013. */
export interface CanonicalProductRepositoryPort
  extends CanonicalProductWritePort, ProductReferenceQueryPort {}

/** Unidad de trabajo para coordinar transacciones atómicas (ADR-015 / EN-027.6). */
export interface CanonicalProductUnitOfWorkPort {
  executeTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T>
}

/** Actor responsable de la acción auditada. */
export interface AuditActor {
  readonly subject: string
  readonly role?: string
  readonly email?: string
}

/** Registro inmutable de auditoría para operaciones sobre Producto (EN-027.7). */
export interface ProductAuditEntry {
  readonly eventId: string
  readonly aggregateId: string
  readonly aggregateType: 'CanonicalProduct'
  readonly action: string
  readonly actor: AuditActor
  readonly timestamp: Date
  readonly snapshot: CanonicalProductSnapshot
  readonly delta?: Record<string, unknown>
}

/** Puerto para persistir auditoría insert-only dentro de la transacción. */
export interface ProductAuditPort {
  record(entry: ProductAuditEntry, context?: TransactionContext): Promise<void>
}

export const OutboxStatus = {
  Pending: 'PENDING',
  InFlight: 'IN_FLIGHT',
  Dispatched: 'DISPATCHED',
  Dead: 'DEAD',
} as const

export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus]

/** Evento pendiente de despacho en el Outbox (EN-027.8). */
export interface OutboxEntry {
  readonly eventId: string
  readonly aggregateId: string
  readonly aggregateType: 'CanonicalProduct'
  readonly eventType: string
  readonly eventVersion: number
  readonly status: OutboxStatus
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly leaseExpiresAt?: Date | null
  readonly attempts: number
  readonly lastError?: string | null
  readonly dispatchedAt?: Date | null
  readonly purgeAt?: Date | null
}

/** Puerto para el Outbox persistente con soporte de lease y reintentos. */
export interface ProductOutboxPort {
  record(entry: OutboxEntry, context?: TransactionContext): Promise<void>
  claim(workerId: string, limit: number, leaseDurationMs: number): Promise<readonly OutboxEntry[]>
  complete(eventId: string, context?: TransactionContext): Promise<void>
  fail(eventId: string, error: string, maxAttempts?: number): Promise<void>
}

export const HERO_SUBTYPE_REGISTRY = Symbol('HeroSubtypeRegistryPort')
export const PRODUCT_REFERENCE_QUERY = Symbol('ProductReferenceQueryPort')
export const CANONICAL_PRODUCT_WRITE = Symbol('CanonicalProductWritePort')
export const CANONICAL_PRODUCT_REPOSITORY = Symbol('CanonicalProductRepositoryPort')
export const CANONICAL_PRODUCT_UNIT_OF_WORK = Symbol('CanonicalProductUnitOfWorkPort')
export const PRODUCT_AUDIT_PORT = Symbol('ProductAuditPort')
export const PRODUCT_OUTBOX_PORT = Symbol('ProductOutboxPort')
