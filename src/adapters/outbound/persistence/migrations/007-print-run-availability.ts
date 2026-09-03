import type { Db } from 'mongodb'

const SKU_PATTERN = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
const CURRENCIES = ['COP', 'USD', 'EUR']
const PRODUCT_TYPES = ['HEROE', 'HABILIDAD', 'ARMA', 'ARMADURA', 'ITEM', 'EPICA']

/**
 * Migración 007: disponibilidad del tiraje (HU-34).
 *
 * ESTA MIGRACION VA ANTES QUE CUALQUIER CAMBIO DE DOMINIO, y no por orden
 * estetico. El esquema canonico que instala la 005 declara
 * `additionalProperties: false`: escribir un producto con un campo que el
 * validador no conoce hace fallar la insercion ENTERA con `Document failed
 * validation`. Con Catalog arrancando con `logger: false`, eso se manifiesta
 * como un 500 sin una sola linea en el registro. Ya paso una vez.
 *
 * QUE SE GUARDA, Y QUE NO.
 *
 * Solo se anade `availableUnits`. NO hay contador de unidades entregadas, y es
 * una decision de producto, no un olvido: CA-03 exige que en tiraje infinito
 * ninguna adquisicion toque el catalogo, asi que un contador de entregas para
 * productos infinitos contradiria el criterio. Para tiraje limitado el dato
 * tampoco necesita guardarse, porque es derivable en todo momento:
 *
 *     entregadas = printRun - availableUnits
 *
 * La invariante se conserva sola: al crear, `availableUnits = printRun`; cada
 * adquisicion resta uno; y un ajuste de tiraje recalcula
 * `availableUnits = nuevoTiraje - entregadas` con las entregadas leidas del
 * estado anterior. Un segundo contador solo anadiria una forma de desincronizar
 * dos numeros que siempre deben cuadrar.
 *
 * LA COHERENCIA LA IMPONE LA BASE. `availableUnits` es null si y solo si el
 * tiraje es infinito, y en otro caso esta entre 0 y `printRun`. Dejar esa regla
 * unicamente en el dominio significaria que una escritura por otra via puede
 * romperla en silencio.
 *
 * El esquema se reescribe entero porque `collMod` REEMPLAZA el validador; no
 * lo fusiona. Repetirlo aqui tambien deja cada migracion como una fotografia
 * cerrada de lo que el esquema era en ese punto.
 *
 * VA EN TRES FASES, y no por gusto: abrir el esquema, rellenar, exigir. La
 * primera version hacia el relleno de entrada y fallaba en su propio
 * `updateMany`, porque el validador vigente en ese instante seguia siendo el de
 * la 005 y ese rechaza cualquier campo que no conozca. La validacion no se
 * desactiva en ningun momento; solo se relaja en lo que este campo necesita.
 */
export const up = async (db: Db): Promise<void> => {
  const legacySchema = {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'name', 'category', 'priceAmount', 'priceCurrency', 'status'],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string', pattern: SKU_PATTERN },
            sku: { bsonType: 'string', pattern: SKU_PATTERN },
            name: { bsonType: 'string', minLength: 3, maxLength: 80 },
            category: { bsonType: 'string', pattern: SKU_PATTERN },
            priceAmount: { bsonType: 'long', minimum: 0 },
            priceCurrency: { enum: CURRENCIES },
            isPremium: { bsonType: 'bool' },
            realMoneyPriceAmount: { bsonType: 'long', minimum: 1 },
            realMoneyPriceCurrency: { enum: CURRENCIES },
            status: { enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
          },
        },
      },
      {
        $or: [
          {
            isPremium: { $exists: false },
            realMoneyPriceAmount: { $exists: false },
            realMoneyPriceCurrency: { $exists: false },
          },
          {
            isPremium: false,
            realMoneyPriceAmount: { $exists: false },
            realMoneyPriceCurrency: { $exists: false },
          },
          {
            isPremium: true,
            realMoneyPriceAmount: { $type: 'long', $gt: 0 },
            realMoneyPriceCurrency: { $in: CURRENCIES },
          },
        ],
      },
    ],
  }

  const canonicalSchema = (exigirDisponibilidad: boolean): object => ({
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          required: [
            '_id',
            'sku',
            'name',
            'normalizedName',
            'description',
            'imageUrl',
            'type',
            'attributes',
            'printRun',
            'printRunMode',
            ...(exigirDisponibilidad ? ['availableUnits'] : []),
            'lifecycleStatus',
            'creditsPrice',
            'premium',
            'realMoneyPrice',
            'createdAt',
            'updatedAt',
            'version',
          ],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string', pattern: UUID_PATTERN },
            sku: { bsonType: 'string', pattern: SKU_PATTERN },
            name: { bsonType: 'string', minLength: 3, maxLength: 80 },
            normalizedName: { bsonType: 'string', minLength: 3, maxLength: 80 },
            description: { bsonType: 'string', minLength: 1 },
            imageUrl: { bsonType: 'string', minLength: 1 },
            type: { enum: PRODUCT_TYPES },
            attributes: {
              bsonType: 'object',
              required: ['schemaVersion', 'values'],
              additionalProperties: false,
              properties: {
                schemaVersion: { enum: ['1'] },
                values: {
                  bsonType: 'object',
                  required: ['kind'],
                  properties: { kind: { enum: PRODUCT_TYPES } },
                },
              },
            },
            printRun: { bsonType: 'long' },
            printRunMode: { enum: ['UNIQUE', 'LIMITED', 'INFINITE'] },
            availableUnits: { bsonType: ['long', 'null'] },
            lifecycleStatus: { enum: ['ACTIVE', 'SUSPENDED'] },
            creditsPrice: { bsonType: 'long', minimum: 0 },
            premium: { bsonType: 'bool' },
            realMoneyPrice: {
              bsonType: ['object', 'null'],
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { bsonType: 'long', minimum: 1 },
                currency: { enum: CURRENCIES },
              },
            },
            createdAt: { bsonType: 'date' },
            updatedAt: { bsonType: 'date' },
            version: { bsonType: 'long', minimum: 0 },
          },
        },
      },
      { $expr: { $eq: ['$type', '$attributes.values.kind'] } },
      {
        $or: [
          { printRun: -1, printRunMode: 'INFINITE' },
          { printRun: 1, printRunMode: 'UNIQUE' },
          { printRun: { $gte: 2 }, printRunMode: 'LIMITED' },
        ],
      },
      // La disponibilidad y el modo de tiraje no pueden contradecirse.
      //
      // Se aplica UNICAMENTE en la fase estricta: durante el relleno todavia
      // hay documentos sin contador, y exigirla antes rechazaria la propia
      // escritura que viene a ponerlo.
      //
      // Infinito exige null -CA-03: no hay contador que consultar-, y cualquier
      // otro modo exige un entero entre 0 y el tiraje. El limite superior es lo
      // que impide que un ajuste mal calculado deje mas unidades disponibles de
      // las que el producto llegara a emitir.
      ...(exigirDisponibilidad
        ? [
            {
              $expr: {
                $cond: {
                  if: { $eq: ['$printRunMode', 'INFINITE'] },
                  then: { $eq: ['$availableUnits', null] },
                  else: {
                    $and: [
                      { $ne: ['$availableUnits', null] },
                      { $gte: ['$availableUnits', 0] },
                      { $lte: ['$availableUnits', '$printRun'] },
                    ],
                  },
                },
              },
            },
          ]
        : []),
      {
        $or: [
          { premium: false, realMoneyPrice: null },
          {
            premium: true,
            'realMoneyPrice.amount': { $type: 'long', $gt: 0 },
            'realMoneyPrice.currency': { $in: CURRENCIES },
          },
        ],
      },
    ],
  })

  const aplicarValidador = async (exigirDisponibilidad: boolean): Promise<void> => {
    await db.command({
      collMod: 'products',
      validator: { $or: [legacySchema, canonicalSchema(exigirDisponibilidad)] },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }

  // FASE 1 - Abrir el esquema al campo nuevo, sin exigirlo todavia.
  //
  // Este paso NO es una formalidad. El validador de la 005 declara
  // `additionalProperties: false`, asi que el relleno de la fase 2 -que escribe
  // `availableUnits`- seria rechazado por el propio validador que esta
  // migracion viene a sustituir. Se descubrio ejecutandolo: la migracion
  // fallaba en su propio `updateMany`.
  //
  // La validacion NO se desactiva en ningun momento. Se relaja solo en lo que
  // este campo necesita.
  await aplicarValidador(false)

  // FASE 2 - Rellenar los documentos canonicos ya existentes.
  //
  // `printRunMode` distingue los documentos canonicos de los del contrato
  // heredado, que no tienen tiraje y no deben tocarse.
  await db
    .collection('products')
    .updateMany({ printRunMode: { $exists: true }, availableUnits: { $exists: false } }, [
      {
        $set: {
          availableUnits: {
            $cond: {
              if: { $eq: ['$printRunMode', 'INFINITE'] },
              then: null,
              // `$printRun` ya es `Long`, de modo que el relleno conserva el
              // tipo que el validador exige.
              else: '$printRun',
            },
          },
        },
      },
    ])

  // FASE 3 - Exigir el campo y su coherencia con el modo de tiraje.
  await aplicarValidador(true)

  // Indice del decremento atomico.
  //
  // La operacion de adquisicion filtra por `_id` y por `availableUnits > 0`,
  // asi que `_id` ya la resuelve. Este indice sirve a la otra consulta que
  // HU-34 necesita: listar lo agotado y lo disponible en el catalogo
  // administrativo sin recorrer la coleccion entera.
  await db.collection('products').createIndex(
    { printRunMode: 1, availableUnits: 1 },
    {
      name: 'idx_products_availability',
      partialFilterExpression: { printRunMode: { $exists: true } },
    },
  )
}
