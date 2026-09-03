import type { ClientSession, Collection, Db } from 'mongodb'

import {
  OutboxStatus,
  type OutboxEntry,
  type ProductOutboxPort,
  type TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'
import { OutboxPayloadTooLargeError } from '../../../application/errors/ApplicationError'

const MAX_PAYLOAD_BYTES = 256 * 1024 // 256 KiB (compatibilidad con SQS / ADR-015)

export interface OutboxDocument {
  readonly _id: string
  readonly eventId: string
  readonly aggregateId: string
  readonly aggregateType: string
  readonly eventType: string
  readonly eventVersion: number
  status: OutboxStatus
  readonly payload: Record<string, unknown>
  readonly createdAt: Date
  updatedAt: Date
  claimedBy?: string | null
  leaseExpiresAt?: Date | null
  attempts: number
  lastError?: string | null
  dispatchedAt?: Date | null
  purgeAt?: Date | null
}

/**
 * Adaptador de Outbox persistente en MongoDB con lease y reintentos (EN-027.8 / ADR-015).
 */
export class MongoProductOutboxRepository implements ProductOutboxPort {
  private readonly outbox: Collection<OutboxDocument>

  constructor(db: Db) {
    this.outbox = db.collection<OutboxDocument>('outbox')
  }

  async record(entry: OutboxEntry, context?: TransactionContext): Promise<void> {
    const session = context?.session ? (context.session as ClientSession) : undefined

    const json = JSON.stringify(entry.payload)
    const bytes = Buffer.byteLength(json, 'utf8')
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new OutboxPayloadTooLargeError(bytes, MAX_PAYLOAD_BYTES)
    }

    const document: OutboxDocument = {
      _id: entry.eventId,
      eventId: entry.eventId,
      aggregateId: entry.aggregateId,
      aggregateType: entry.aggregateType,
      eventType: entry.eventType,
      eventVersion: entry.eventVersion,
      status: entry.status,
      payload: entry.payload,
      createdAt: new Date(entry.createdAt),
      updatedAt: new Date(entry.updatedAt),
      leaseExpiresAt: entry.leaseExpiresAt ? new Date(entry.leaseExpiresAt) : null,
      attempts: entry.attempts,
      lastError: entry.lastError ?? null,
      dispatchedAt: entry.dispatchedAt ? new Date(entry.dispatchedAt) : null,
      purgeAt: entry.purgeAt ? new Date(entry.purgeAt) : null,
    }

    await this.outbox.insertOne(document, { session })
  }

  async claim(
    workerId: string,
    limit: number,
    leaseDurationMs: number,
  ): Promise<readonly OutboxEntry[]> {
    const now = new Date()
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)
    const claimed: OutboxEntry[] = []

    for (let i = 0; i < limit; i += 1) {
      const result = await this.outbox.findOneAndUpdate(
        {
          $or: [
            { status: OutboxStatus.Pending },
            {
              status: OutboxStatus.InFlight,
              leaseExpiresAt: { $lt: now },
            },
          ],
        },
        {
          $set: {
            status: OutboxStatus.InFlight,
            claimedBy: workerId,
            leaseExpiresAt,
            updatedAt: now,
          },
        },
        {
          sort: { createdAt: 1 },
          returnDocument: 'after',
        },
      )

      if (!result) {
        break
      }

      claimed.push(this.toEntry(result))
    }

    return claimed
  }

  async complete(eventId: string, context?: TransactionContext): Promise<void> {
    const session = context?.session ? (context.session as ClientSession) : undefined
    const now = new Date()

    await this.outbox.updateOne(
      { eventId },
      {
        $set: {
          status: OutboxStatus.Dispatched,
          dispatchedAt: now,
          updatedAt: now,
          leaseExpiresAt: null,
          claimedBy: null,
        },
      },
      { session },
    )
  }

  async fail(
    eventId: string,
    error: string,
    maxAttempts = 5,
  ): Promise<void> {
    const now = new Date()
    const document = await this.outbox.findOne({ eventId })
    if (!document) return

    const attempts = document.attempts + 1
    const status = attempts >= maxAttempts ? OutboxStatus.Dead : OutboxStatus.Pending

    await this.outbox.updateOne(
      { eventId },
      {
        $set: {
          status,
          attempts,
          lastError: error,
          updatedAt: now,
          leaseExpiresAt: null,
          claimedBy: null,
        },
      },
    )
  }

  async findByEventId(eventId: string): Promise<OutboxEntry | null> {
    const document = await this.outbox.findOne({ eventId })
    return document ? this.toEntry(document) : null
  }

  private toEntry(doc: OutboxDocument): OutboxEntry {
    return {
      eventId: doc.eventId,
      aggregateId: doc.aggregateId,
      aggregateType: doc.aggregateType as 'CanonicalProduct',
      eventType: doc.eventType,
      eventVersion: doc.eventVersion,
      status: doc.status,
      payload: doc.payload,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      leaseExpiresAt: doc.leaseExpiresAt ?? null,
      attempts: doc.attempts,
      lastError: doc.lastError ?? null,
      dispatchedAt: doc.dispatchedAt ?? null,
      purgeAt: doc.purgeAt ?? null,
    }
  }
}
