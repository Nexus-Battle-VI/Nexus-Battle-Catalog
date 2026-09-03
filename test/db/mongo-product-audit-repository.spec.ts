import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import type { Db, MongoClient } from 'mongodb'

import { MongoProductAuditRepository } from '../../src/adapters/outbound/persistence/MongoProductAuditRepository'
import type { ProductAuditEntry } from '../../src/application/ports/CanonicalProductPorts'
import {
  createMongoClient,
  databaseOf,
  migrateToLatest,
} from '../../src/infrastructure/persistence/database'
import { describeError } from '../../src/infrastructure/observability/describe-error'
import { closeMongoTestResources } from '../support/mongo-test-resources'

const EVENTO = '44444444-4444-4444-8444-444444444444'
const AGREGADO = '55555555-5555-4555-8555-555555555555'

const entrada = (actor: ProductAuditEntry['actor']): ProductAuditEntry => ({
  eventId: EVENTO,
  aggregateId: AGREGADO,
  aggregateType: 'CanonicalProduct',
  action: 'PRODUCT_CREATED',
  actor,
  timestamp: new Date('2026-09-03T00:00:00.000Z'),
  snapshot: { productId: AGREGADO } as unknown as ProductAuditEntry['snapshot'],
})

describe('MongoProductAuditRepository contra el validador de audit_log', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db
  let repository: MongoProductAuditRepository

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)
    const { error } = await migrateToLatest(db)

    if (error !== undefined) {
      throw new Error(`Las migraciones fallaron: ${describeError(error)}`)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  beforeEach(async () => {
    repository = new MongoProductAuditRepository(db)
    await db.collection('audit_log').deleteMany({})
  })

  it('registra al actor cuando el testimonio no trae correo ni rol', async () => {
    await repository.record(entrada({ subject: 'sujeto-1', role: undefined, email: undefined }))

    const guardado = await db.collection('audit_log').findOne({ eventId: EVENTO })

    expect(guardado).not.toBeNull()
    // Ausentes, NO nulos: un null aqui es exactamente lo que rechaza el validador.
    expect(guardado).not.toHaveProperty('actor.email')
    expect(guardado).not.toHaveProperty('actor.role')
    expect(guardado?.actor).toEqual({ subject: 'sujeto-1' })
  })

  it('conserva correo y rol cuando el testimonio si los trae', async () => {
    await repository.record(
      entrada({ subject: 'sujeto-2', role: 'ADMINISTRATOR', email: 'admin@ejemplo.test' }),
    )

    const guardado = await db.collection('audit_log').findOne({ eventId: EVENTO })

    expect(guardado?.actor).toEqual({
      subject: 'sujeto-2',
      role: 'ADMINISTRATOR',
      email: 'admin@ejemplo.test',
    })
  })

  /**
   * Control de la prueba anterior. Sin el, las dos primeras podrian estar
   * pasando por construccion: si el validador no existiera, escribir el actor
   * tal cual tambien pasaria y la regresion no se detectaria nunca.
   *
   * Esto es lo que hacia el adaptador antes de la correccion.
   */
  it('el validador RECHAZA el actor si las claves ausentes se escriben como undefined', async () => {
    const actorSinFiltrar = { subject: 'sujeto-3', role: undefined, email: undefined }

    await expect(
      db.collection('audit_log').insertOne({
        _id: EVENTO as unknown as never,
        eventId: EVENTO,
        aggregateId: AGREGADO,
        aggregateType: 'CanonicalProduct',
        action: 'PRODUCT_CREATED',
        actor: actorSinFiltrar,
        timestamp: new Date(),
        snapshot: {},
      }),
    ).rejects.toThrow(/Document failed validation/u)
  })
})
