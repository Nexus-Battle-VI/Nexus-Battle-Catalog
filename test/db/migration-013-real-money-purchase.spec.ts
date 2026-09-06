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
import { up as up013 } from '../../src/adapters/outbound/persistence/migrations/013-product-real-money-purchase'
import { createMongoClient, databaseOf } from '../../src/infrastructure/persistence/database'
import { closeMongoTestResources } from '../support/mongo-test-resources'

/**
 * HU-36 (CA-03) migracion 013: bandera de compra en moneda real.
 *
 * Misma pregunta que la suite de la 007 y la 012: **sin la 013, un producto
 * con `hasRealMoneyPurchase` es rechazado**, porque el esquema canonico sigue
 * declarando `additionalProperties: false`.
 */

const ID_SIN_COMPRAS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
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
  averageRating: null,
  reviewCount: Long.fromNumber(0),
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-01T00:00:00.000Z'),
  version: Long.fromNumber(0),
  ...extra,
})

describe('HU-36 migracion 013: bandera de compra en moneda real', () => {
  let container: StartedMongoDBContainer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:8.0').start()
    const options = { uri: `${container.getConnectionString()}/?directConnection=true` }

    client = createMongoClient(options)
    await client.connect()
    db = databaseOf(client, options)

    // Hasta la 012, deliberadamente: el estado del esquema ANTES de esta HU.
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
      up012,
    ]) {
      await up(db)
    }
  }, 180_000)

  afterAll(async () => {
    await closeMongoTestResources({ client, container })
  })

  describe('antes de aplicar la 013', () => {
    it('CONTROL: rechaza un producto que traiga hasRealMoneyPurchase', async () => {
      await expect(
        db.collection('products').insertOne(
          documentoCanonico(ID_SIN_COMPRAS, {
            hasRealMoneyPurchase: false,
          }),
        ),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    it('acepta el mismo producto sin el campo, que es como se escribia hasta ahora', async () => {
      await db.collection('products').insertOne(documentoCanonico(ID_SIN_COMPRAS))

      // Un documento del contrato heredado: la 013 no debe tocarlo.
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

  describe('despues de aplicar la 013', () => {
    beforeAll(async () => {
      await up013(db)
    }, 60_000)

    it('rellena los productos ya existentes sin compras registradas', async () => {
      const producto = await db
        .collection('products')
        .findOne({ _id: ID_SIN_COMPRAS as unknown as never })

      expect(producto?.hasRealMoneyPurchase).toBe(false)
    })

    it('no toca los documentos del contrato heredado', async () => {
      const heredado = await db
        .collection('products')
        .findOne({ _id: ID_HEREDADO as unknown as never })

      expect(heredado).not.toBeNull()
      expect('hasRealMoneyPurchase' in (heredado ?? {})).toBe(false)
    })

    it('exige el campo: un producto canonico sin el ya no entra', async () => {
      await expect(
        db
          .collection('products')
          .insertOne(documentoCanonico('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
      ).rejects.toThrow(/[Dd]ocument failed validation/u)
    })

    it('ahora si admite un producto con la compra registrada', async () => {
      await expect(
        db.collection('products').insertOne(
          documentoCanonico('cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
            hasRealMoneyPurchase: true,
          }),
        ),
      ).resolves.toBeTruthy()
    })

    it('es idempotente: volver a aplicarla no cambia el conteo de documentos', async () => {
      await up013(db)

      await expect(db.collection('products').countDocuments()).resolves.toBe(3)
    })
  })
})
