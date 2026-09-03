import type { Db } from 'mongodb'

/**
 * Migración 009: índice de LECTURA por `sku` para la consulta canónica de HU-27.
 *
 * `uniq_products_sku` (migración 004) es único y su `partialFilterExpression` es
 * `{ sku: { $type: 'string' } }`. MongoDB 8.0 NO usa un índice parcial con
 * predicado `$type` para resolver `{ sku: { $in: [...] } }` — comprobado con
 * `explain`: el plan resultaba `COLLSCAN`. Eso deja la resolución por lote de
 * `findByReferences` (HU-27, consumidor Player/Inventory) sin índice.
 *
 * Este índice adicional es **de solo lectura** (no único) y su
 * `partialFilterExpression` usa `{ sku: { $exists: true } }`, que un `$in` de
 * cadenas sí implica: con él, el `$or` por `_id` / `sku` se resuelve por unión
 * de índices y el lookup deja de recorrer la colección.
 *
 * Es aditivo: no toca `uniq_products_sku`, ni el validador, ni ninguna
 * restricción. `createIndex` es idempotente por nombre.
 */
export const up = async (db: Db): Promise<void> => {
  await db.collection('products').createIndex(
    { sku: 1 },
    {
      name: 'products_sku_read',
      unique: false,
      partialFilterExpression: { sku: { $exists: true } },
    },
  )
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('products').dropIndex('products_sku_read')
}
