import type {
  CanonicalProduct,
  CanonicalProductSnapshot,
} from '../../domain/entities/CanonicalProduct'
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

/**
 * Consulta de lectura por referencia sobre el conjunto de productos que el
 * consumidor ya posee. `references` casa cada valor contra `productId` (UUID) o
 * contra el alias `sku`; `nameQuery` filtra por substring del nombre normalizado
 * y `type` por tipo canónico. Ambos filtros son opcionales.
 */
export interface CanonicalProductLookupQuery {
  readonly references: readonly string[]
  readonly nameQuery?: string
  readonly type?: ProductType
}

/**
 * Puerto de LECTURA canónica para consumidores externos (HU-27).
 *
 * Añade lectura al almacén canónico sin exponer la base privada de Catalog y
 * sin obligar a un N+1: `findByReferences` resuelve muchas referencias en una
 * sola consulta. La identidad canónica sigue siendo `productId`; `sku` se
 * acepta solo como alias de compatibilidad de consulta.
 */
export interface CanonicalProductReadPort {
  findByReference(reference: string): Promise<CanonicalProduct | null>
  findByReferences(query: CanonicalProductLookupQuery): Promise<readonly CanonicalProduct[]>
}

/** Contexto opaco de transacción, desacoplado del driver subyacente. */
export interface TransactionContext {
  readonly session?: unknown
}

/** Resultado del decremento condicionado de disponibilidad (HU-34, CA-01). */
export interface AvailabilityDecrement {
  /** Unidades que quedan tras el decremento. `null` en tiraje infinito. */
  readonly availableUnits: number | null
  /** Cierto cuando este decremento fue el que dejo el producto en cero. */
  readonly depleted: boolean
}

/** Puerto que implementa la escritura canónica de productos, con soporte transaccional. */
export interface CanonicalProductWritePort {
  existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean>
  create(product: CanonicalProduct, context?: TransactionContext): Promise<void>
  findById(productId: ProductId): Promise<CanonicalProduct | null>
  update(
    product: CanonicalProduct,
    expectedVersion: number,
    context?: TransactionContext,
  ): Promise<void>
  /**
   * Resta UNA unidad de forma atomica y condicionada.
   *
   * Devuelve `null` cuando no hay nada que restar -producto inexistente o
   * agotado-. La condicion viaja DENTRO de la operacion de escritura: leer,
   * decidir y escribir por separado deja una ventana en la que dos
   * adquisiciones simultaneas pueden ver la misma ultima unidad.
   *
   * En tiraje infinito NO escribe nada y devuelve disponibilidad `null`: CA-03
   * exige que la adquisicion no toque el catalogo.
   */
  decrementAvailability(
    productId: ProductId,
    context?: TransactionContext,
  ): Promise<AvailabilityDecrement | null>
}

/** Almacén canónico completo durante la transición aditiva de ADR-013. */
export interface CanonicalProductRepositoryPort
  extends CanonicalProductWritePort, ProductReferenceQueryPort, CanonicalProductReadPort {}

/** Resultado registrado de una adquisición, para responder igual ante un reintento. */
export interface AcquisitionRecord {
  readonly acquisitionId: string
  readonly productId: string
  readonly playerId: string
  readonly availableUnits: number | null
  readonly at: Date
}

/**
 * Registro de adquisiciones consumidas, que es lo que da idempotencia.
 *
 * Sin el, un reintento de la llamada interna -un tiempo de espera agotado en
 * quien llama, con la peticion ya procesada- restaria una segunda unidad. Y ese
 * error no se ve: el producto simplemente se agota antes de lo que debia.
 */
export interface ProductAcquisitionPort {
  /** Reserva el identificador. Devuelve `null` si ya estaba consumido. */
  claim(record: AcquisitionRecord, context?: TransactionContext): Promise<AcquisitionRecord | null>
  findById(acquisitionId: string): Promise<AcquisitionRecord | null>
}

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
export const CANONICAL_PRODUCT_READ = Symbol('CanonicalProductReadPort')
export const CANONICAL_PRODUCT_WRITE = Symbol('CanonicalProductWritePort')
export const CANONICAL_PRODUCT_REPOSITORY = Symbol('CanonicalProductRepositoryPort')
export const CANONICAL_PRODUCT_UNIT_OF_WORK = Symbol('CanonicalProductUnitOfWorkPort')
export const PRODUCT_AUDIT_PORT = Symbol('ProductAuditPort')
export const PRODUCT_OUTBOX_PORT = Symbol('ProductOutboxPort')
export const PRODUCT_ACQUISITION_PORT = Symbol('ProductAcquisitionPort')
