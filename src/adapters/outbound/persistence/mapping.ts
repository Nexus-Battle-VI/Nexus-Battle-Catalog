import { Long } from 'mongodb'

import { ProductStatus } from '../../../domain/entities/Product'
import { Money } from '../../../domain/value-objects/catalog-values'
import type { ProductSnapshot } from '../../../domain/entities/Product'

/**
 * Traduccion entre documentos de MongoDB y la instantanea del agregado.
 *
 * Vive aparte del repositorio y es **puro** a proposito: es la parte del
 * adaptador donde de verdad se puede equivocar uno, y sacarla del repositorio
 * permite probarla sin base de datos ni contenedor.
 */

export class PersistenceMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PersistenceMappingError'
  }
}

/**
 * Documento tal y como se guarda.
 *
 * `_id` es el SKU y no un identificador generado. El SKU ya identifica al
 * producto de forma unica en el dominio, y usarlo como clave hace que MongoDB
 * garantice esa unicidad sin un indice adicional: un segundo producto con el
 * mismo SKU no se puede ni escribir.
 */
export interface ProductDocument {
  readonly _id: string
  readonly name: string
  readonly category: string
  /**
   * Importe en la unidad minima de la moneda, como entero de 64 bits.
   *
   * **No es un `number` de JavaScript.** El driver guardaria un `number` como
   * `double` de BSON, y un doble no es el tipo en el que se guarda dinero: el
   * dia que alguien sume desde una agregacion de MongoDB, el resultado puede
   * dejar de ser entero. `Long` es el equivalente de `bigint` que se uso en
   * Commerce, y por el mismo motivo.
   */
  readonly priceAmount: Long
  readonly priceCurrency: string
  readonly status: string
  readonly isPremium?: boolean
  readonly realMoneyPriceAmount?: Long
  readonly realMoneyPriceCurrency?: string
}

const STATUSES: readonly string[] = Object.values(ProductStatus)

/**
 * Convierte el importe de 64 bits a un numero de JavaScript.
 *
 * Un entero de 64 bits no cabe en el numero de JavaScript, exacto solo hasta
 * 2^53 - 1. Convertirlo sin comprobar **redondearia en silencio** un importe
 * grande, que es justo lo que no puede ocurrir con dinero. Se comprueba que la
 * conversion sea exacta comparando el texto de vuelta: un importe redondeado es
 * peor que un error, porque el error se ve.
 */
const toExactAmount = (raw: Long | number, sku: string): number => {
  const texto = raw.toString()
  const parsed = Number(texto)

  if (!Number.isInteger(parsed) || String(parsed) !== texto) {
    throw new PersistenceMappingError(
      `El producto ${sku} tiene un importe que no se puede representar con exactitud: "${texto}".`,
    )
  }

  return parsed
}

/**
 * Construye la instantanea a partir del documento.
 *
 * Valida lo que lee en lugar de confiar en el documento. En MongoDB esto pesa
 * mas que en PostgreSQL: una coleccion admite documentos de cualquier forma
 * salvo que se declare un validador, y aun con validador uno escrito antes de
 * declararlo sigue ahi. Fallar al leerlo es preferible a construir un agregado
 * con un estado que el dominio no reconoce.
 */
export const toSnapshot = (document: ProductDocument): ProductSnapshot => {
  if (!STATUSES.includes(document.status)) {
    throw new PersistenceMappingError(
      `El producto ${document._id} tiene un estado desconocido: "${document.status}".`,
    )
  }

  if (!Money.SUPPORTED_CURRENCIES.includes(document.priceCurrency)) {
    throw new PersistenceMappingError(
      `El producto ${document._id} esta en una moneda que el dominio no admite: "${document.priceCurrency}".`,
    )
  }

  return {
    sku: document._id,
    name: document.name,
    category: document.category,
    priceAmount: toExactAmount(document.priceAmount, document._id),
    priceCurrency: document.priceCurrency,
    status: document.status as ProductStatus,
    isPremium: document.isPremium ?? false,
    realMoneyPriceAmount:
      document.realMoneyPriceAmount === undefined
        ? null
        : toExactAmount(document.realMoneyPriceAmount, document._id),
    realMoneyPriceCurrency: document.realMoneyPriceCurrency ?? null,
  }
}

/** Descompone la instantanea en el documento que se guarda. */
export const toDocument = (snapshot: ProductSnapshot): ProductDocument => {
  if (!Number.isInteger(snapshot.priceAmount) || snapshot.priceAmount < 0) {
    throw new PersistenceMappingError(
      `El producto ${snapshot.sku} tiene un importe que no es un entero no negativo: ${String(snapshot.priceAmount)}.`,
    )
  }

  return {
    _id: snapshot.sku,
    name: snapshot.name,
    category: snapshot.category,
    priceAmount: Long.fromNumber(snapshot.priceAmount),
    priceCurrency: snapshot.priceCurrency,
    status: snapshot.status,
    isPremium: snapshot.isPremium,
    ...(snapshot.realMoneyPriceAmount === null || snapshot.realMoneyPriceCurrency === null
      ? {}
      : {
          realMoneyPriceAmount: Long.fromNumber(snapshot.realMoneyPriceAmount),
          realMoneyPriceCurrency: snapshot.realMoneyPriceCurrency,
        }),
  }
}
