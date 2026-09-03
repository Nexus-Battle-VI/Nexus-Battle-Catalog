import type {
  ProductAuditEntry,
  ProductAuditPort,
} from '../../../application/ports/CanonicalProductPorts'

/** Doble de prueba en memoria para auditoría de producto. */
export class InMemoryProductAuditRepository implements ProductAuditPort {
  readonly entries: ProductAuditEntry[] = []

  record(entry: ProductAuditEntry): Promise<void> {
    this.entries.push(entry)
    return Promise.resolve()
  }

  findByEventId(eventId: string): Promise<ProductAuditEntry | null> {
    return Promise.resolve(this.entries.find((e) => e.eventId === eventId) ?? null)
  }

  findByAggregateId(aggregateId: string): Promise<ProductAuditEntry[]> {
    return Promise.resolve(
      this.entries
        .filter((e) => e.aggregateId === aggregateId)
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()),
    )
  }
}
