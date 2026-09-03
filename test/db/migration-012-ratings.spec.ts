import { MongoDBContainer, type StartedMongoDBContainer } from '@testcontainers/mongodb'
import { Long, type Db, type MongoClient } from 'mongodb'

import { up as up001 } from '../../src/adapters/outbound/persistence/migrations/001-products'
import { up as up002 } from '../../src/adapters/outbound/persistence/migrations/002-premium-products'
import { up as up003 } from '../../src/adapters/outbound/persistence/migrations/003-premium-product-validation'
import { up as up004 } from '../../src/adapters/outbound/persistence/migrations/004-canonical-products'
import { up as up005 } from '../../src/adapters/outbound/persistence/migrations/005-atomicity-audit-outbox'
import { up as up006 } from '../../src/adapters/outbound/persistence/migrations/006-product-assets'
import { up as up007 } from '../../src/adapters/outbound/persistence/migrations/007-print-run-availability'
import { up as up008 } from '../../src/adapters/outbound/persistence/migrations/008-product-acquisitions'
import { up as up009 } from '../../src/adapters/outbound/persistence/migrations/009-canonical-sku-read-index'
import { up as up010 } from '../../src/adapters/outbound/persistence/migrations/010-stock-reservations'
import { up as up011 } from '../../src/adapters/outbound/persistence/migrations/011-storefront-search'
import { up as up012 } from '../../src/adapters/outbound/persistence/migrations/012-product-ratings'
import { createMongoClient, databaseOf } from '../../src/infrastructure/persistence/database'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * HU-40 (CA-03) migracion 012: el agregado de calificaciones.
 *
 * Misma pregunta que la suite de la 007: **sin la 012, un producto con
 * `averageRating`/`reviewCount` es rechazado**, porque el esquema canonico
 * sigue declarando `additionalProperties: false`.
 */

const ID_SIN_CALIFICAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ID_HEREDADO = 'espada-heredada'

const documentoCanonico = (
  id: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  _id: id,
  sku: `sku-${id.slice(0, 8)}`,
  name: `Producto ${id.slice(0, 8)}`,
  normalizedName: `producto ${id.slice(0, 8)}`,
  storefrontSearchText: `producto ${id.slice(0, 8)}`,
  storefrontSearchTokens: [] as number[],
  description: 'Descripcion valida.',
  imageUrl: 'https://assets.example.test/img.png',
  type: 'ARMA',
  attributes: { schemaVersion: '1', values: { kind: 'ARMA' } },
  printRun: Long.fromNumber(10),
  printRunMode: 'LIMITED',
  availableUnits: Long.fromNumber(10),
  lifecycleStatus: 'ACTIVE',
  creditsPrice: Long.fromNumber(500),
  premium: false,
  realMoneyPrice: null,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  version: Long.fromNumber(0),
  ...extra,
})

describe('HU-40 migracion 012: agregado de calificaciones', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    // Hasta la 011, deliberadamente: el estado del esquema ANTES de esta HU.
    for (const up of [
      up001,
      up002,
      up003,
      up004,
      up005,
      up006,
      up007,
      up008,
      up009,
      up010,
      up011,
    ]) {
      await up(db)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  describe('antes de aplicar la 012', () => {
    it('CONTROL: rechaza un producto que traiga averageRating/reviewCount', async () => {
      await expect(
        db.collection('products').insertOne(
          documentoCanonico(ID_SIN_CALIFICAR, {
            averageRating: null,
            reviewCount: Long.fromNumber(0),
          }),
        ),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    it('acepta el mismo producto sin los campos, que es como se escribia hasta ahora', async () => {
      await db.collection('products').insertOne(documentoCanonico(ID_SIN_CALIFICAR))

      // Un documento del contrato heredado: no tiene tiraje ni calificaciones
      // y la 012 no debe tocarlo.
      await db.collection('products').insertOne({
        _id: ID_HEREDADO as unknown as never,
        name: 'Espada heredada',
        category: 'armas',
        priceAmount: Long.fromNumber(100),
        priceCurrency: 'COP',
        status: 'PUBLISHED',
      })

      await expect(db.collection('products').countDocuments()).resolves.toBe(2)
    })
  })

  describe('despues de aplicar la 012', () => {
    beforeAll(async () => {
      await up012(db)
    }, 60_000)

    it('rellena los productos ya existentes sin calificaciones', async () => {
      const producto = await db
        .collection('products')
        .findOne({ _id: ID_SIN_CALIFICAR as unknown as never })

      expect(producto?.averageRating).toBeNull()
      expect(Long.isLong(producto?.reviewCount)).toBe(true)
      expect(producto?.reviewCount?.toString()).toBe('0')
    })

    it('no toca los documentos del contrato heredado', async () => {
      const heredado = await db
        .collection('products')
        .findOne({ _id: ID_HEREDADO as unknown as never })

      expect(heredado).not.toBeNull()
      expect('averageRating' in (heredado ?? {})).toBe(false)
      expect('reviewCount' in (heredado ?? {})).toBe(false)
    })

    it('exige los campos: un producto canonico sin ellos ya no entra', async () => {
      await expect(
        db
          .collection('products')
          .insertOne(documentoCanonico('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    it('ahora si admite un producto calificado', async () => {
      await expect(
        db.collection('products').insertOne(
          documentoCanonico('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
            averageRating: 4.5,
            reviewCount: Long.fromNumber(2),
          }),
        ),
      ).resolves.toBeTruthy()
    })

    describe('la coherencia entre promedio y conteo la impone la base', () => {
      it('rechaza un promedio cuando el conteo es cero', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
              averageRating: 4,
              reviewCount: Long.fromNumber(0),
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })

      it('rechaza la ausencia de promedio cuando SI hay conteo', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', {
              averageRating: null,
              reviewCount: Long.fromNumber(3),
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })

      it('rechaza un promedio fuera de 1-5', async () => {
        await expect(
          db.collection('products').insertOne(
            documentoCanonico('ffffffff-ffff-4fff-8fff-ffffffffffff', {
              averageRating: 5.5,
              reviewCount: Long.fromNumber(1),
            }),
          ),
        ).rejects.toThrow(/[Dd]ocument failed validation/u)
      })
    })
  })
})
