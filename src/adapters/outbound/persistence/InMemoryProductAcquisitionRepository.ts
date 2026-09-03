import type {
  AcquisitionRecord,
  ProductAcquisitionPort,
} from '../../../application/ports/CanonicalProductPorts'

/**
 * Registro de adquisiciones en proceso, para desarrollo y pruebas HTTP.
 *
 * Reproduce la unicidad del identificador, que es lo unico que este puerto
 * promete. NO reproduce la atomicidad de MongoDB: la prueba de concurrencia de
 * CA-01 corre contra un motor real.
 */
export class InMemoryProductAcquisitionRepository implements ProductAcquisitionPort {
  private readonly byId = new Map<string, AcquisitionRecord>()

  claim(record: AcquisitionRecord): Promise<AcquisitionRecord | null> {
    if (this.byId.has(record.acquisitionId)) {
      return Promise.resolve(null)
    }

    this.byId.set(record.acquisitionId, record)

    return Promise.resolve(record)
  }

  findById(acquisitionId: string): Promise<AcquisitionRecord | null> {
    return Promise.resolve(this.byId.get(acquisitionId) ?? null)
  }
}
