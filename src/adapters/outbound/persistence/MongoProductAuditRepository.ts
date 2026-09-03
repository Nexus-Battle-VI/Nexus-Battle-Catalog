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
      actor: entry.actor,
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
