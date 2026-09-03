import {
  OutboxStatus,
  type OutboxEntry,
  type ProductOutboxPort,
} from '../../../application/ports/CanonicalProductPorts'
import { OutboxPayloadTooLargeError } from '../../../application/errors/ApplicationError'

const MAX_PAYLOAD_BYTES = 256 * 1024

/** Doble de prueba en memoria para outbox persistente. */
export class InMemoryProductOutboxRepository implements ProductOutboxPort {
  readonly entries: OutboxEntry[] = []

  record(entry: OutboxEntry): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(entry.payload), 'utf8')
    if (bytes > MAX_PAYLOAD_BYTES) {
      return Promise.reject(new OutboxPayloadTooLargeError(bytes, MAX_PAYLOAD_BYTES))
    }
    this.entries.push(structuredClone(entry))
    return Promise.resolve()
  }

  claim(
    _workerId: string,
    limit: number,
    leaseDurationMs: number,
  ): Promise<readonly OutboxEntry[]> {
    const now = new Date()
    const claimed: OutboxEntry[] = []

    for (const entry of this.entries) {
      if (claimed.length >= limit) break
      const canClaim =
        entry.status === OutboxStatus.Pending ||
        (entry.status === OutboxStatus.InFlight &&
          entry.leaseExpiresAt !== null &&
          entry.leaseExpiresAt !== undefined &&
          entry.leaseExpiresAt < now)

      if (canClaim) {
        const mutable = entry as {
          status: OutboxStatus
          leaseExpiresAt: Date | null
          updatedAt: Date
        }
        mutable.status = OutboxStatus.InFlight
        mutable.leaseExpiresAt = new Date(now.getTime() + leaseDurationMs)
        mutable.updatedAt = now
        claimed.push(structuredClone(entry))
      }
    }

    return Promise.resolve(claimed)
  }

  complete(eventId: string): Promise<void> {
    const entry = this.entries.find((e) => e.eventId === eventId)
    if (entry) {
      const mutable = entry as {
        status: OutboxStatus
        dispatchedAt: Date | null
        updatedAt: Date
        leaseExpiresAt: Date | null
      }
      mutable.status = OutboxStatus.Dispatched
      mutable.dispatchedAt = new Date()
      mutable.updatedAt = new Date()
      mutable.leaseExpiresAt = null
    }
    return Promise.resolve()
  }

  fail(eventId: string, error: string, maxAttempts = 5): Promise<void> {
    const entry = this.entries.find((e) => e.eventId === eventId)
    if (entry) {
      const mutable = entry as {
        status: OutboxStatus
        attempts: number
        lastError: string | null
        updatedAt: Date
        leaseExpiresAt: Date | null
      }
      mutable.attempts += 1
      mutable.lastError = error
      mutable.updatedAt = new Date()
      mutable.leaseExpiresAt = null
      mutable.status = mutable.attempts >= maxAttempts ? OutboxStatus.Dead : OutboxStatus.Pending
    }
    return Promise.resolve()
  }

  findByEventId(eventId: string): Promise<OutboxEntry | null> {
    const entry = this.entries.find((e) => e.eventId === eventId)
    return Promise.resolve(entry ? structuredClone(entry) : null)
  }
}
