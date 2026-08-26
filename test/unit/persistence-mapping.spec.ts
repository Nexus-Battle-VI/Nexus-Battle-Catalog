import 'reflect-metadata'

import { Long } from 'mongodb'

import {
  PersistenceMappingError,
  toDocument,
  toSnapshot,
  type ProductDocument,
} from '../../src/adapters/outbound/persistence/mapping'
import { ProductStatus, type ProductSnapshot } from '../../src/domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../src/domain/value-objects/catalog-values'
import { up } from '../../src/adapters/outbound/persistence/migrations/001-products'
import { describeError } from '../../src/infrastructure/observability/describe-error'

const DOCUMENT: ProductDocument = {
  _id: 'sku-espada-corta',
  name: 'Espada corta',
  category: 'armas',
  priceAmount: Long.fromNumber(150_000),
  priceCurrency: 'COP',
  status: ProductStatus.Published,
}

const SNAPSHOT: ProductSnapshot = {
  sku: 'sku-espada-corta',
  name: 'Espada corta',
  category: 'armas',
  priceAmount: 150_000,
  priceCurrency: 'COP',
  status: ProductStatus.Published,
}

describe('Traduccion entre documento e instantanea', () => {
  it('reconstruye la instantanea completa', () => {
    expect(toSnapshot(DOCUMENT)).toEqual(SNAPSHOT)
  })

  it('la traduccion es reversible', () => {
    expect(toSnapshot(toDocument(SNAPSHOT))).toEqual(SNAPSHOT)
  })

  /**
   * El SKU es la clave del documento. Usarlo como `_id` hace que MongoDB
   * garantice su unicidad sin un indice adicional: un segundo producto con el
   * mismo SKU no se puede ni escribir.
   */
  it('usa el SKU como clave del documento', () => {
    expect(toDocument(SNAPSHOT)._id).toBe(SNAPSHOT.sku)
  })
})

/**
 * El dinero es la parte que no admite aproximaciones.
 *
 * El driver guardaria un `number` de JavaScript como `double` de BSON, y un
 * doble no es el tipo en el que se guarda dinero. Se usa `Long` —entero de 64
 * bits—, que es el equivalente del `bigint` que se uso en Commerce y por el
 * mismo motivo.
 */
describe('Importes', () => {
  it('guarda el importe como entero de 64 bits, no como doble', () => {
    expect(toDocument(SNAPSHOT).priceAmount).toBeInstanceOf(Long)
  })

  it('convierte un importe grande pero exacto', () => {
    const document = { ...DOCUMENT, priceAmount: Long.fromString('9007199254740991') }

    expect(toSnapshot(document).priceAmount).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('rechaza un importe que JavaScript no puede representar con exactitud', () => {
    // Una unidad por encima del maximo seguro: convertirlo sin comprobar
    // devolveria un valor distinto del que hay guardado.
    const document = { ...DOCUMENT, priceAmount: Long.fromString('9007199254740993') }

    expect(() => toSnapshot(document)).toThrow(PersistenceMappingError)
  })

  it('admite un importe de cero', () => {
    expect(toSnapshot({ ...DOCUMENT, priceAmount: Long.ZERO }).priceAmount).toBe(0)
  })

  it.each([
    ['fraccionario', 1500.5],
    ['negativo', -1],
  ])('rechaza escribir un importe %s', (_caso, priceAmount) => {
    expect(() => toDocument({ ...SNAPSHOT, priceAmount })).toThrow(PersistenceMappingError)
  })
})

/**
 * Validar lo que se lee pesa mas en MongoDB que en PostgreSQL: una coleccion
 * admite documentos de cualquier forma salvo que se declare un validador, y aun
 * con validador uno escrito ANTES de declararlo sigue ahi.
 */
describe('Validacion de lo que se lee', () => {
  it('rechaza un estado que el dominio no reconoce', () => {
    expect(() => toSnapshot({ ...DOCUMENT, status: 'DESCATALOGADO' })).toThrow(
      PersistenceMappingError,
    )
  })

  it('rechaza una moneda que el dominio no admite', () => {
    expect(() => toSnapshot({ ...DOCUMENT, priceCurrency: 'XYZ' })).toThrow(PersistenceMappingError)
  })
})

/**
 * Una migracion NO puede importar el dominio: queda congelada en el tiempo y
 * tiene que seguir siendo ejecutable tal y como se escribio, aunque el dominio
 * cambie despues. Eso obliga a repetir el vocabulario en el validador.
 *
 * Estas pruebas son lo que evita que esa duplicacion se convierta en
 * divergencia. Es el mismo criterio que se aplico a las restricciones `CHECK`
 * de los servicios de PostgreSQL, y la razon por la que este validador NO
 * contradice el rechazo de Mongoose en ADR-012: un esquema de Mongoose valida
 * en la APLICACION, repitiendo lo que el dominio ya hace; esto valida en el
 * MOTOR, y protege de escrituras que no pasan por el codigo.
 */
describe('El dominio y la migracion no divergen', () => {
  const fuenteDeLaMigracion = up.toString()

  it.each(Object.values(ProductStatus))('el validador admite el estado %s', (status) => {
    expect(fuenteDeLaMigracion).toContain(`'${status}'`)
  })

  it.each(Money.SUPPORTED_CURRENCIES)('el validador admite la moneda %s', (currency) => {
    expect(fuenteDeLaMigracion).toContain(`'${currency}'`)
  })

  it('el validador no admite valores que el dominio desconoce', () => {
    const enLosEnumerados = [...fuenteDeLaMigracion.matchAll(/'([A-Z]{3,})'/g)].map(
      (match) => match[1]!,
    )
    const conocidos: readonly string[] = [
      ...Object.values(ProductStatus),
      ...Money.SUPPORTED_CURRENCIES,
    ]

    expect(enLosEnumerados.filter((value) => !conocidos.includes(value))).toEqual([])
  })

  it('los limites del nombre coinciden con los del dominio', () => {
    expect(fuenteDeLaMigracion).toContain(`minLength: ${String(ProductName.MIN_LENGTH)}`)
    expect(fuenteDeLaMigracion).toContain(`maxLength: ${String(ProductName.MAX_LENGTH)}`)
  })

  /**
   * Se compara por COMPORTAMIENTO y no por cadenas: lo que importa es que motor
   * y dominio acepten y rechacen exactamente lo mismo, no que el texto del
   * patron coincida. Dos expresiones distintas pueden significar lo mismo, y
   * dos iguales pueden aplicarse a campos distintos.
   */
  it.each([
    ['_id', (raw: string): unknown => Sku.create(raw)],
    ['category', (raw: string): unknown => Category.create(raw)],
  ])('el patron de %s acepta y rechaza lo mismo que el dominio', (campo, construir) => {
    const patrones = [...fuenteDeLaMigracion.matchAll(/pattern: '([^']+)'/g)].map(
      (match) => match[1]!,
    )

    expect(patrones.length).toBeGreaterThan(0)

    const patron = new RegExp(patrones[0]!)
    const ejemplos = [
      'armas',
      'sku-de-varias-partes',
      'a1',
      'MAYUSCULAS',
      'con espacio',
      '-guion',
      '',
    ]

    for (const ejemplo of ejemplos) {
      const loAdmiteElDominio = ((): boolean => {
        try {
          construir(ejemplo)

          return true
        } catch {
          return false
        }
      })()

      expect({ campo, ejemplo, motor: patron.test(ejemplo.trim().toLowerCase()) }).toEqual({
        campo,
        ejemplo,
        motor: loAdmiteElDominio,
      })
    }
  })
})

/**
 * Muchas bibliotecas rechazan con `unknown`. Pasar eso por `String()` a secas
 * convierte cualquier objeto en `[object Object]` justo cuando mas falta hace
 * saber que ocurrio.
 */
describe('describeError', () => {
  it('usa el mensaje cuando es un Error', () => {
    expect(describeError(new Error('algo fallo'))).toBe('algo fallo')
  })

  it('serializa un objeto en lugar de producir [object Object]', () => {
    expect(describeError({ code: '121', detail: 'validacion' })).toBe(
      '{"code":"121","detail":"validacion"}',
    )
  })

  it.each([
    [undefined, 'undefined'],
    [null, 'null'],
  ])('describe %s sin romperse', (valor, esperado) => {
    expect(describeError(valor)).toBe(esperado)
  })

  it('no se rompe con una estructura circular', () => {
    const circular: Record<string, unknown> = {}
    circular.yo = circular

    expect(describeError(circular)).toBe('error no serializable')
  })
})
