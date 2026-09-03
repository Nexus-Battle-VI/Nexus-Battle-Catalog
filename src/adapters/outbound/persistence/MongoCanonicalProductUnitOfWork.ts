import type { MongoClient } from 'mongodb'

import type {
  CanonicalProductUnitOfWorkPort,
  TransactionContext,
} from '../../../application/ports/CanonicalProductPorts'

/**
 * Unidad de trabajo transaccional con sesión MongoDB (EN-027.6 / ADR-015).
 *
 * Utiliza transacciones multidocumento con `writeConcern: majority` y
 * `readConcern: majority` sobre el conjunto de réplicas de MongoDB.
 * Cualquier excepción aborta automáticamente la transacción completa.
 */
export class MongoCanonicalProductUnitOfWork implements CanonicalProductUnitOfWorkPort {
  constructor(private readonly client: MongoClient) {}

  async executeTransaction<T>(work: (context: TransactionContext) => Promise<T>): Promise<T> {
    const session = this.client.startSession()

    try {
      let result!: T
      await session.withTransaction(
        async () => {
          result = await work({ session })
        },
        {
          writeConcern: { w: 'majority' },
          readConcern: { level: 'majority' },
        },
      )

      return result
    } finally {
      await session.endSession()
    }
  }
}
