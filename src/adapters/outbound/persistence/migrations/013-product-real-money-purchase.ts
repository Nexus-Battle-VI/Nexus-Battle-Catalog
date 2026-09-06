import { type Db } from 'mongodb'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Encuentra el `$jsonSchema` canonico dentro del validador `$or` vigente.
 *
 * SE DUPLICA A PROPOSITO desde la 012: cada migracion es una fotografia
 * cerrada de como se transformo el esquema en ese punto, y no debe depender
 * de que otra migracion exista todavia con esa forma exacta.
 */
const canonicalSchema = (value: unknown): Record<string, unknown> | null => {
  const node = record(value)
  if (node === null) return null
  const schema = record(node.$jsonSchema)
  const properties = record(schema?.properties)
  if (schema !== null && properties?.normalizedName !== undefined && properties.type !== undefined)
    return schema
  for (const child of Object.values(node)) {
    for (const branch of Array.isArray(child) ? child : [child]) {
      const found = canonicalSchema(branch)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * Migracion 013: bandera de compra en moneda real (HU-36, CA-03).
 *
 * MISMO MOTIVO QUE LA 007 Y LA 012 PARA IR EN TRES FASES. El validador
 * vigente declara `additionalProperties: false`: escribir
 * `hasRealMoneyPurchase` antes de abrir el esquema haria fallar la propia
 * escritura de relleno con `Document failed validation`.
 *
 * QUE SE GUARDA. `hasRealMoneyPurchase` es `false` para todo producto
 * existente -ninguno pudo haber recibido todavia el empuje de Commerce, que
 * es quien lo escribe a partir de esta migracion- y solo puede pasar a
 * `true`, nunca al reves (`MongoCanonicalProductRepository.markRealMoneyPurchase`
 * no admite desmarcarlo).
 */
export const up = async (db: Db): Promise<void> => {
  const info = await db.listCollections({ name: 'products' }).next()
  if (info === null || !('options' in info)) throw new Error('Products collection is missing.')
  const validator: unknown = structuredClone(info.options?.validator)
  const schema = canonicalSchema(validator)
  const properties = record(schema?.properties)
  if (schema === null || properties === null)
    throw new Error('Canonical products validator is missing.')

  const apply = (): Promise<unknown> =>
    db.command({
      collMod: 'products',
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    })

  // FASE 1 - Abrir el esquema al campo nuevo, sin exigirlo todavia.
  properties.hasRealMoneyPurchase = { bsonType: 'bool' }
  await apply()

  // FASE 2 - Rellenar los documentos canonicos ya existentes: nacen sin
  // compras registradas, igual que un producto creado hoy.
  await db
    .collection('products')
    .updateMany(
      { type: { $exists: true }, hasRealMoneyPurchase: { $exists: false } },
      { $set: { hasRealMoneyPurchase: false } },
    )

  // FASE 3 - Exigir el campo.
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field: unknown): field is string => typeof field === 'string')
    : []
  schema.required = [...new Set([...required, 'hasRealMoneyPurchase'])]

  await apply()
}
