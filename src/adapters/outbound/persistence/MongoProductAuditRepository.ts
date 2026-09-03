import type { ClientSession, Collection, Db } from 'mongodb'

import type {
  ProductAuditEntry,
  ProductAuditPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'

export interface ProductAuditDocument {
  readonly _id: string
  readonly eventId: string
  readonly aggregateId: string
  readonly aggregateType: string
  readonly action: string
  readonly actor: {
    readonly subject: string
    readonly role?: string
    readonly email?: string
  }
  readonly timestamp: Date
  readonly snapshot: Record<string, unknown>
  readonly delta?: Record<string, unknown>
}

/**
 * Traduce el actor OMITIENDO las claves ausentes en lugar de escribirlas.
 *
 * El controlador entrega `role` y `email` como `undefined` cuando el testimonio
 * no los trae -un testimonio de acceso de Cognito NO lleva `email`-, y el
 * controlador de MongoDB serializa `undefined` como **null**, no como ausencia.
 * El validador de `audit_log` (migracion 005) declara ambos `bsonType: 'string'`,
 * asi que ese null hace fallar el documento entero con `Document failed
 * validation`, la transaccion se aborta y la creacion responde 500.
 *
 * Comprobado contra el sistema desplegado: con `email: undefined` MongoDB
 * responde `consideredType: "null"`; omitiendo la clave, el mismo documento
 * pasa. La prueba de `test/db` reproduce ambos casos.
 */
const toActorDocument = (actor: ProductAuditEntry['actor']): ProductAuditDocument['actor'] => ({
  subject: actor.subject,
  ...(actor.role === undefined ? {} : { role: actor.role }),
  ...(actor.email === undefined ? {} : { email: actor.email }),
})

/**
 * Adaptador de auditoría insert-only en MongoDB (EN-027.7 / ADR-015).
 *
 * La identidad runtime solo tiene permiso para insertar registros; no se
 * exponen métodos de actualización ni borrado.
 */
export class MongoProductAuditRepository implements ProductAuditPort {
  private readonly auditLog: Collection<ProductAuditDocument>

  constructor(db: Db) {
    this.auditLog = db.collection<ProductAuditDocument>('audit_log')
  }

  async record(entry: ProductAuditEntry, context?: TransactionContext): Promise<void> {
    const session = context?.session ? (context.session as ClientSession) : undefined
    const document: ProductAuditDocument = {
      _id: entry.eventId,
      eventId: entry.eventId,
      aggregateId: entry.aggregateId,
      aggregateType: entry.aggregateType,
      action: entry.action,
      actor: toActorDocument(entry.actor),
      timestamp: new Date(entry.timestamp),
      snapshot: entry.snapshot as unknown as Record<string, unknown>,
      ...(entry.delta ? { delta: entry.delta } : {}),
    }

    await this.auditLog.insertOne(document, { session })
  }

  async findByEventId(eventId: string): Promise<ProductAuditDocument | null> {
    return this.auditLog.findOne({ eventId })
  }

  async findByAggregateId(aggregateId: string): Promise<ProductAuditDocument[]> {
    return this.auditLog.find({ aggregateId }).sort({ timestamp: -1 }).toArray()
  }
}
