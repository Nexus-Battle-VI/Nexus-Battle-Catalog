import type { Db } from 'mongodb'

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

/**
 * Migración 008: registro de adquisiciones consumidas (HU-34).
 *
 * PARA QUE SIRVE. Da idempotencia al decremento. Quien llama al contrato
 * interno puede reintentar -un tiempo de espera agotado con la peticion ya
 * procesada al otro lado es lo normal, no lo excepcional-, y sin este registro
 * el reintento restaria una segunda unidad.
 *
 * Ese error es especialmente malo porque NO SE VE: nadie recibe un mensaje de
 * fallo, el producto simplemente se agota antes de lo que debia y el tiraje
 * configurado deja de significar lo que dice.
 *
 * LA UNICIDAD LA DA `_id`. El identificador de adquisicion ES la clave del
 * documento, asi que MongoDB rechaza el duplicado sin que haga falta indice
 * adicional ni comprobacion previa: se intenta insertar y el choque es la
 * respuesta. Comprobar antes y escribir despues dejaria justo la ventana que
 * esto viene a cerrar.
 *
 * `availableUnits` guarda el resultado para poder responder lo MISMO ante un
 * reintento. Devolver la disponibilidad actual en vez de la registrada haria
 * que dos respuestas a la misma peticion se contradijeran.
 */
export const up = async (db: Db): Promise<void> => {
  const existentes = new Set((await db.listCollections().toArray()).map((c) => c.name))

  if (!existentes.has('acquisitions')) {
    await db.createCollection('acquisitions', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['_id', 'productId', 'playerId', 'at'],
          additionalProperties: false,
          properties: {
            _id: { bsonType: 'string', pattern: UUID_PATTERN },
            productId: { bsonType: 'string', pattern: UUID_PATTERN },
            playerId: { bsonType: 'string', minLength: 1 },
            // `null` cuando el producto es de tiraje infinito: la adquisicion
            // ocurrio y no hay contador que reportar.
            availableUnits: { bsonType: ['long', 'null'] },
            at: { bsonType: 'date' },
          },
        },
      },
      validationLevel: 'strict',
      validationAction: 'error',
    })
  }

  // Consulta de apoyo: todas las adquisiciones de un producto, por fecha. No la
  // usa el decremento -ese va por `_id`- sino la revision de un caso concreto.
  await db
    .collection('acquisitions')
    .createIndex({ productId: 1, at: -1 }, { name: 'idx_acquisitions_product_at' })
}
