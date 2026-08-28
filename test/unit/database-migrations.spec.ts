import type { Db } from 'mongodb'

import { describeError } from '../../src/infrastructure/observability/describe-error'
import { migrateToLatest } from '../../src/infrastructure/persistence/database'

interface MigrationRecordForTest {
  readonly _id: string
  readonly startedAt: Date
  readonly completedAt?: Date
}

interface PartialMigrationScenario {
  readonly db: Db
  readonly record: () => MigrationRecordForTest | null
  readonly createCollectionCalls: () => number
}

/**
 * Simula el punto no transaccional de 001: la coleccion queda creada y la
 * operacion posterior que crea el indice falla.
 */
const partialMigrationScenario = (): PartialMigrationScenario => {
  let migrationRecord: MigrationRecordForTest | null = null
  let collectionCreated = false
  let collectionCreationCount = 0

  const registry = {
    find: () => ({
      toArray: (): Promise<MigrationRecordForTest[]> =>
        Promise.resolve(migrationRecord === null ? [] : [{ ...migrationRecord }]),
    }),
    insertOne: (record: MigrationRecordForTest): Promise<unknown> => {
      migrationRecord = { ...record }

      return Promise.resolve({ acknowledged: true })
    },
    deleteOne: (): Promise<unknown> => {
      migrationRecord = null

      return Promise.resolve({ acknowledged: true })
    },
    updateOne: (): Promise<unknown> => {
      if (migrationRecord !== null) {
        migrationRecord = { ...migrationRecord, completedAt: new Date() }
      }

      return Promise.resolve({ acknowledged: true })
    },
  }

  const products = {
    createIndex: (): Promise<never> => Promise.reject(new Error('fallo al crear el indice')),
  }

  const db = {
    collection: (name: string): unknown => (name === '_migrations' ? registry : products),
    createCollection: (): Promise<unknown> => {
      collectionCreationCount += 1

      if (collectionCreated) {
        return Promise.reject(new Error('la coleccion ya existe'))
      }

      collectionCreated = true

      return Promise.resolve(products)
    },
  } as unknown as Db

  return {
    db,
    record: (): MigrationRecordForTest | null => migrationRecord,
    createCollectionCalls: (): number => collectionCreationCount,
  }
}

describe('Migraciones parcialmente aplicadas', () => {
  it('conserva la reclamacion incompleta cuando una operacion posterior falla', async () => {
    const scenario = partialMigrationScenario()

    const { error } = await migrateToLatest(scenario.db)

    expect(describeError(error)).toContain('fallo al crear el indice')
    expect(scenario.record()).toMatchObject({ _id: '001-products' })
    expect(scenario.record()?.completedAt).toBeUndefined()
  })

  it('bloquea el siguiente intento sin volver a ejecutar la migracion', async () => {
    const scenario = partialMigrationScenario()

    await migrateToLatest(scenario.db)
    const { applied, error } = await migrateToLatest(scenario.db)

    expect(applied).toEqual([])
    expect(describeError(error)).toContain('quedo a medias')
    expect(scenario.createCollectionCalls()).toBe(1)
  })
})
