import { MongoClient, type Db } from 'mongodb'

import * as migration001 from '../../adapters/outbound/persistence/migrations/001-products'
import * as migration002 from '../../adapters/outbound/persistence/migrations/002-premium-products'
import * as migration003 from '../../adapters/outbound/persistence/migrations/003-premium-product-validation'
import * as migration004 from '../../adapters/outbound/persistence/migrations/004-canonical-products'
import * as migration005 from '../../adapters/outbound/persistence/migrations/005-atomicity-audit-outbox'
import * as migration006 from '../../adapters/outbound/persistence/migrations/006-product-assets'
import * as migration007 from '../../adapters/outbound/persistence/migrations/007-print-run-availability'

export interface DatabaseOptions {
  readonly uri: string
  readonly databaseName?: string
  /**
   * Conexiones simultaneas del pool.
   *
   * Deliberadamente bajo. Los seis servicios y los dos motores comparten
   * instancia (ADR-011): si cada servicio abriera un pool generoso, el motor
   * agotaria su limite de conexiones antes de que ningun servicio notara
   * presion.
   */
  readonly maxPoolSize?: number
}

export const DEFAULT_DATABASE_NAME = 'catalog'

export const createMongoClient = (options: DatabaseOptions): MongoClient =>
  new MongoClient(options.uri, {
    maxPoolSize: options.maxPoolSize ?? 5,
    // Sin este limite, un motor caido deja las peticiones colgadas hasta el
    // tiempo de espera de la peticion HTTP, que es mucho mas largo.
    serverSelectionTimeoutMS: 5_000,
    // Cerrar conexiones ociosas devuelve capacidad al motor compartido.
    maxIdleTimeMS: 30_000,
    // Los enteros de 64 bits llegan como `Long` y NO como numero.
    //
    // Por defecto el driver los promociona a numero cuando caben en 53 bits y
    // los deja como `Long` cuando no. Eso significa que el tipo que recibe la
    // traduccion depende del VALOR, y un camino que solo se ejercita con
    // importes grandes es un camino que nadie prueba. Con esto siempre llega un
    // `Long`, y la comprobacion de exactitud se aplica siempre.
    promoteLongs: false,
  })

export const databaseOf = (client: MongoClient, options: DatabaseOptions): Db =>
  client.db(options.databaseName ?? DEFAULT_DATABASE_NAME)

/**
 * Migraciones declaradas en codigo, no descubiertas del sistema de ficheros.
 *
 * Leer el directorio en tiempo de ejecucion fallaria en la imagen de
 * produccion, donde ese directorio contiene JavaScript compilado con otra ruta.
 * Importarlas explicitamente hace que el compilador las verifique y que el
 * empaquetado no pueda dejarse ninguna fuera en silencio.
 *
 * El orden lo fija el nombre, y por eso llevan prefijo numerico.
 */
const MIGRATIONS: readonly { readonly name: string; readonly up: (db: Db) => Promise<void> }[] = [
  { name: '001-products', up: migration001.up },
  { name: '002-premium-products', up: migration002.up },
  { name: '003-premium-product-validation', up: migration003.up },
  { name: '004-canonical-products', up: migration004.up },
  { name: '005-atomicity-audit-outbox', up: migration005.up },
  { name: '006-product-assets', up: migration006.up },
  { name: '007-print-run-availability', up: migration007.up },
]

const REGISTRY = '_migrations'

interface MigrationRecord {
  readonly _id: string
  readonly startedAt: Date
  readonly completedAt?: Date
}

export interface MigrationOutcome {
  readonly applied: readonly string[]
  readonly error: unknown
}

/**
 * Lleva el esquema al ultimo estado conocido.
 *
 * MongoDB no trae migrador, asi que hay uno aqui. Es deliberadamente pequeno:
 * una coleccion `_migrations` con el nombre como `_id`, que MongoDB ya obliga a
 * ser unico.
 *
 * Esa unicidad es lo que da exclusion mutua real: la migracion se **reclama**
 * antes de ejecutarse, de modo que un segundo proceso que intente lo mismo
 * choca en la insercion en lugar de ejecutar `createCollection` a la vez. Si
 * `up` falla, la reclamacion se retira para que un reintento pueda seguir.
 *
 * Una reclamacion sin completar significa que una ejecucion anterior murio a
 * medias. En ese caso NO se continua: el esquema esta en un estado que nadie
 * conoce, y seguir escribiendo encima lo empeora. Se falla y se dice cual.
 *
 * No se ejecuta al arrancar el servicio: migrar desde el arranque significa que
 * varias replicas migran a la vez, y que un despliegue con una migracion rota
 * deja el servicio en bucle de reinicio. Se invoca desde `npm run migrate`,
 * como paso explicito del despliegue.
 */
export const migrateToLatest = async (db: Db): Promise<MigrationOutcome> => {
  const registry = db.collection<MigrationRecord>(REGISTRY)
  const applied: string[] = []

  try {
    const existing = await registry.find().toArray()
    const byName = new Map(existing.map((record) => [record._id, record]))

    for (const migration of MIGRATIONS) {
      const record = byName.get(migration.name)

      if (record !== undefined) {
        if (record.completedAt === undefined) {
          throw new Error(
            `La migracion "${migration.name}" quedo a medias en una ejecucion anterior. ` +
              'Hay que revisar el estado del esquema a mano antes de continuar.',
          )
        }

        continue
      }

      // Reclamar primero. Si otro proceso llego antes, esta insercion falla por
      // clave duplicada y no se ejecuta `up` dos veces.
      await registry.insertOne({ _id: migration.name, startedAt: new Date() })

      // Las operaciones de esquema de MongoDB no son transaccionales. Si `up`
      // falla, la reclamacion queda incompleta deliberadamente: la siguiente
      // ejecucion se detendra y exigira inspeccionar el esquema en vez de
      // reintentarlo a ciegas sobre un estado desconocido.
      await migration.up(db)

      await registry.updateOne({ _id: migration.name }, { $set: { completedAt: new Date() } })
      applied.push(migration.name)
    }

    return { applied, error: undefined }
  } catch (error: unknown) {
    return { applied, error }
  }
}
