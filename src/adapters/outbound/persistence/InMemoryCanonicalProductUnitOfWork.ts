import type {
  CanonicalProductUnitOfWorkPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'

/**
 * Doble de prueba en memoria para la unidad de trabajo transaccional.
 */
export class InMemoryCanonicalProductUnitOfWork implements CanonicalProductUnitOfWorkPort {
  executedTransactions = 0
  shouldFail = false
  failureError: Error = new Error('Transacción fallida simulada')

  async executeTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    if (this.shouldFail) {
      throw this.failureError
    }

    this.executedTransactions += 1
    return work({ session: { inMemory: true } })
  }
}
