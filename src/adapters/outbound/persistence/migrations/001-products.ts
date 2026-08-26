import type { Db } from 'mongodb'

/**
 * Esquema inicial de Catalog.
 *
 * MongoDB no exige declarar nada antes de escribir, y por eso mismo hace falta
 * declararlo: una coleccion sin validador acepta un documento de cualquier
 * forma, incluido uno escrito por una version anterior del servicio o por
 * alguien conectado a mano al motor.
 *
 * Aqui esta la diferencia con Mongoose que motivo ADR-012. Un esquema de
 * Mongoose valida **en la aplicacion**: es una segunda comprobacion que repite
 * la del dominio y no protege de nada que no pase por el codigo. Este validador
 * vive **en el motor**, y es el equivalente exacto de las restricciones `CHECK`
 * que los servicios de PostgreSQL declaran en su migracion.
 *
 * `up` recibe `Db` a proposito y no un tipo del esquema actual: una migracion
 * queda congelada en el tiempo y tiene que seguir siendo ejecutable tal y como
 * se escribio, aunque el modelo cambie despues.
 */
export const up = async (db: Db): Promise<void> => {
  await db.createCollection('products', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'name', 'category', 'priceAmount', 'priceCurrency', 'status'],
        // Ningun campo mas: un documento con propiedades que el dominio no
        // conoce es basura que se leera algun dia como si significara algo.
        additionalProperties: false,
        properties: {
          // El SKU es la clave: MongoDB garantiza su unicidad sin indice
          // adicional. El patron es el mismo que exige `Sku` en el dominio.
          _id: { bsonType: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' },
          name: { bsonType: 'string', minLength: 3, maxLength: 80 },
          category: { bsonType: 'string', pattern: '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' },
          // `long` y no `double`: el dinero se guarda como entero de 64 bits en
          // la unidad minima de la moneda. Un doble aceptaria 1999.99, que no
          // es un importe que este dominio pueda representar.
          priceAmount: { bsonType: 'long', minimum: 0 },
          priceCurrency: { enum: ['COP', 'USD', 'EUR'] },
          status: { enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] },
        },
      },
    },
    // Que rechace la escritura, no que la registre y siga. Un validador que
    // avisa es un validador que nadie lee.
    validationLevel: 'strict',
    validationAction: 'error',
  })

  // El acceso real es "dame los productos de esta categoria, publicados". Sin
  // este indice, cada busqueda recorreria la coleccion entera.
  await db.collection('products').createIndex({ category: 1, status: 1 })
}

export const down = async (db: Db): Promise<void> => {
  await db.collection('products').drop()
}
