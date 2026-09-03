import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Long, type Db, type MongoClient } from 'mongodb'

import { up as up001 } from '../../src/adapters/outbound/persistence/migrations/001-products'
import { up as up002 } from '../../src/adapters/outbound/persistence/migrations/002-premium-products'
import { up as up003 } from '../../src/adapters/outbound/persistence/migrations/003-premium-product-validation'
import { up as up004 } from '../../src/adapters/outbound/persistence/migrations/004-canonical-products'
import { up as up005 } from '../../src/adapters/outbound/persistence/migrations/005-atomicity-audit-outbox'
import { up as up006 } from '../../src/adapters/outbound/persistence/migrations/006-product-assets'
import { up as up007 } from '../../src/adapters/outbound/persistence/migrations/007-print-run-availability'
import { createMongoClient, databaseOf } from '../../src/infrastructure/persistence/database'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * HU-34, paso 1: el esquema de disponibilidad.
 *
 * La pregunta que responde esta suite no es «funciona la migracion», sino algo
 * mas concreto: **sin la 007, un producto con `availableUnits` es rechazado**.
 *
 * Importa porque el esquema canonico declara `additionalProperties: false`. Si
 * el codigo empezara a escribir el campo antes de que el validador lo conozca,
 * cada creacion fallaria con `Document failed validation`, y Catalog arranca
 * con `logger: false`: el sintoma seria un 500 mudo. Ya ocurrio una vez con el
 * actor de auditoria. Este fichero existe para que no vuelva a ocurrir sin que
 * una prueba lo diga antes.
 */

const ID_LIMITADO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_INFINITO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ID_HEREDADO = 'espada-heredada'

const documentoCanonico = (
  id: string,
  printRun: number,
  printRunMode: 'UNIQUE' | 'LIMITED' | 'INFINITE',
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _id: id,
  sku: `sku-${id.slice(0, 8)}`,
  name: `Producto ${id.slice(0, 8)}`,
  normalizedName: `producto ${id.slice(0, 8)}`,
  description: 'Descripcion valida.',
  imageUrl: 'https://assets.example.test/img.png',
  type: 'ARMA',
  attributes: { schemaVersion: '1', values: { kind: 'ARMA' } },
  printRun: Long.fromNumber(printRun),
  printRunMode,
  lifecycleStatus: 'ACTIVE',
  creditsPrice: Long.fromNumber(500),
  premium: false,
  realMoneyPrice: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  version: Long.fromNumber(0),
  ...extra,
})

describe('HU-34 migracion 007: disponibilidad del tiraje', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    // Hasta la 006, deliberadamente: el estado del esquema ANTES de esta HU.
    for (const up of [up001, up002, up003, up004, up005, up006]) {
      await up(db)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  describe('antes de aplicar la 007', () => {
    it('CONTROL: rechaza un producto que traiga availableUnits', async () => {
      // Este es el caso que da sentido a todos los demas. Si dejara de fallar,
      // las pruebas de mas abajo estarian pasando por construccion: el
      // validador no estaria aplicandose y no nos enteremos.
      await expect(
        db
          .collection('products')
          .insertOne(
            documentoCanonico(ID_LIMITADO, 10, 'LIMITED', { availableUnits: Long.fromNumber(10) }),
          ),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    it('acepta el mismo producto sin el campo, que es como se escribia hasta ahora', async () => {
      await db.collection('products').insertOne(documentoCanonico(ID_LIMITADO, 10, 'LIMITED'))
      await db.collection('products').insertOne(documentoCanonico(ID_INFINITO, -1, 'INFINITE'))

      // Un documento del contrato heredado, para comprobar que la 007 no lo
      // toca: no tiene tiraje y no debe adquirir contador.
      await db.collection('products').insertOne({
        _id: ID_HEREDADO as unknown as never,
        name: 'Espada heredada',
        category: 'armas',
        priceAmount: Long.fromNumber(100),
        priceCurrency: 'COP',
        status: 'PUBLISHED',
      })

      await expect(db.collection('products').countDocuments()).resolves.toBe(3)
    })
  })

  describe('despues de aplicar la 007', () => {
    beforeAll(async () => {
      await up007(db)
    }, 60_000)

    it('rellena los productos ya existentes segun su modo de tiraje', async () => {
      const limitado = await db
        .collection('products')
        .findOne({ _id: ID_LIMITADO as unknown as never })
      const infinito = await db
        .collection('products')
        .findOne({ _id: ID_INFINITO as unknown as never })

      // El limitado nace con todo su tiraje por emitir: nada se ha entregado
      // todavia porque hasta esta HU no habia forma de adquirir nada.
      expect(Long.isLong(limitado?.availableUnits)).toBe(true)
      expect(limitado?.availableUnits?.toString()).toBe('10')

      // El infinito recibe null, y null es el valor, no un descuido (CA-03).
      expect(infinito?.availableUnits).toBeNull()
      expect('availableUnits' in (infinito ?? {})).toBe(true)
    })

    it('no toca los documentos del contrato heredado', async () => {
      const heredado = await db
        .collection('products')
        .findOne({ _id: ID_HEREDADO as unknown as never })

      expect(heredado).not.toBeNull()
      expect('availableUnits' in (heredado ?? {})).toBe(false)
    })

    it('ahora si admite un producto limitado con su contador', async () => {
      await expect(
        db.collection('products').insertOne(
          documentoCanonico('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 5, 'LIMITED', {
            availableUnits: Long.fromNumber(5),
          }),
        ),
      ).resolves.toBeTruthy()
    })

    it('exige el campo: un producto canonico sin contador ya no entra', async () => {
      await expect(
        db
          .collection('products')
          .insertOne(documentoCanonico('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 5, 'LIMITED')),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    describe('la coherencia entre modo y contador la impone la base', () => {
      it('rechaza tiraje infinito con contador', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', -1, 'INFINITE', {
              availableUnits: Long.fromNumber(0),
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })

      it('rechaza tiraje limitado con contador nulo', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('ffffffff-ffff-4fff-8fff-ffffffffffff', 5, 'LIMITED', {
              availableUnits: null,
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })

      it('rechaza mas unidades disponibles que tiraje', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('11111111-2222-4333-8444-555555555555', 5, 'LIMITED', {
              availableUnits: Long.fromNumber(6),
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })

      it('admite el agotado: cero disponibles sobre un tiraje limitado', async () => {
        // Agotado NO es invalido. Es el estado que CA-01 espera al final, y con
        // `lifecycleStatus` intacto: agotado y suspendido son independientes.
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('22222222-3333-4444-8555-666666666666', 5, 'LIMITED', {
              availableUnits: Long.fromNumber(0),
            }),
          ),
        ).resolves.toBeTruthy()

        const agotado = await db
          .collection('products')
          .findOne({ _id: '22222222-3333-4444-8555-666666666666' as unknown as never })

        expect(agotado?.lifecycleStatus).toBe('ACTIVE')
      })
    })
  })
})
