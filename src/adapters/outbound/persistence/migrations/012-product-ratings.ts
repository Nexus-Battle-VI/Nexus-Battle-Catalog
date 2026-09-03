import { Long, type Db } from 'mongodb'

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/**
 * Encuentra el `$jsonSchema` canonico dentro del validador `$or` vigente.
 *
 * SE DUPLICA A PROPOSITO desde la 011: cada migracion es una fotografia
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
 * Migracion 012: agregado de calificaciones (HU-40, CA-03).
 *
 * MISMO MOTIVO QUE LA 007 PARA IR EN TRES FASES. El validador vigente declara
 * `additionalProperties: false`: escribir `averageRating`/`reviewCount` antes
 * de abrir el esquema haria fallar la propia escritura de relleno con
 * `Document failed validation`.
 *
 * QUE SE GUARDA. `averageRating` es `null` sin calificaciones y un numero
 * entre 1 y 5 en otro caso; `reviewCount` es el conteo que ya valido
 * Community. Catalog no vuelve a calcular ninguno de los dos: los conserva
 * tal cual los empuja el contrato interno `POST
 * /internal/v1/catalog/products/:id/rating`.
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

  // FASE 1 - Abrir el esquema a los campos nuevos, sin exigirlos todavia.
  properties.averageRating = { bsonType: ['double', 'int', 'long', 'null'], minimum: 1, maximum: 5 }
  properties.reviewCount = { bsonType: 'long', minimum: 0 }
  await apply()

  // FASE 2 - Rellenar los documentos canonicos ya existentes: nacen sin
  // calificaciones, igual que un producto creado hoy.
  //
  // `Long.fromNumber(0)`, NO el literal `0`. El driver serializa un numero JS
  // pequeno como `int32` por defecto, y el esquema recien abierto exige
  // `bsonType: 'long'` para `reviewCount`: un `0` sin envolver hace fallar
  // esta misma escritura con `Document failed validation`. Se descubrio
  // ejecutandolo contra un MongoDB real.
  await db
    .collection('products')
    .updateMany(
      { type: { $exists: true }, reviewCount: { $exists: false } },
      { $set: { averageRating: null, reviewCount: Long.fromNumber(0) } },
    )

  // FASE 3 - Exigir los campos y su coherencia mutua.
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field: unknown): field is string => typeof field === 'string')
    : []
  schema.required = [...new Set([...required, 'averageRating', 'reviewCount'])]

  const validatorNode = record(validator)

  // La coherencia promedio/conteo se anade como una condicion `$expr` mas,
  // igual que la 007 hace con `availableUnits`/`printRunMode`. Solo se anade
  // dentro de la RAMA CANONICA -la que ya contenia este `$jsonSchema`-: la
  // rama heredada (`legacySchema`) no tiene ninguno de los dos campos y no
  // debe evaluarla.
  const ratingConsistency = {
    $expr: {
      $cond: {
        if: { $eq: ['$reviewCount', 0] },
        then: { $eq: ['$averageRating', null] },
        else: {
          $and: [
            { $ne: ['$averageRating', null] },
            { $gte: ['$averageRating', 1] },
            { $lte: ['$averageRating', 5] },
          ],
        },
      },
    },
  }

  // El validador tiene la forma `{ $or: [legacySchema, { $and: [...] }] }`
  // desde la 004: la condicion se anade al `$and` canonico, dentro de esa rama.
  const orBranches = Array.isArray(validatorNode?.$or) ? (validatorNode.$or as unknown[]) : null
  if (orBranches !== null) {
    for (const branch of orBranches) {
      const node = record(branch)
      const branchAnd = Array.isArray(node?.$and) ? (node.$and as unknown[]) : null
      if (branchAnd?.some((sub) => canonicalSchema(sub) !== null) === true) {
        branchAnd.push(ratingConsistency)
      }
    }
  }

  await apply()
}
