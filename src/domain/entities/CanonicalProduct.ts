import type { ProductAttributes } from '../value-objects/product-attributes'
import {
  LifecycleStatus,
  type CreditsPrice,
  type PrintRun,
  type ProductDescription,
  type ProductId,
  type ProductImageUrl,
  type ProductPricing,
  type ProductType,
  type PrintRunMode,
} from '../value-objects/canonical-product-values'
import type { Money, ProductName, Sku } from '../value-objects/catalog-values'
import { DomainError } from '../errors/DomainError'

/**
 * Comprueba que el promedio y el numero de calificaciones digan lo mismo
 * (HU-40, CA-03): sin calificaciones el promedio es `null`, y con al menos una
 * es un numero entre 1 y 5. Community es quien calcula ambos valores; esta
 * comprobacion es la misma defensa en profundidad que `assertAvailability`
 * aplica a la disponibilidad -la invariante se verifica aqui ADEMAS de en el
 * validador de MongoDB-.
 */
export const assertRatingAggregate = (averageRating: number | null, reviewCount: number): void => {
  if (!Number.isInteger(reviewCount) || reviewCount < 0) {
    throw new DomainError(
      `El numero de calificaciones debe ser un entero no negativo. Se recibio ${String(reviewCount)}.`,
    )
  }

  if (reviewCount === 0) {
    if (averageRating !== null) {
      throw new DomainError('Un producto sin calificaciones no lleva promedio.')
    }

    return
  }

  if (averageRating === null || averageRating < 1 || averageRating > 5) {
    throw new DomainError(
      `Un producto con calificaciones necesita un promedio entre 1 y 5. Se recibio ${String(averageRating)}.`,
    )
  }
}

/**
 * Comprueba que la disponibilidad y el tiraje digan lo mismo.
 *
 * Tiraje infinito exige `null`; cualquier otro modo exige un entero entre 0 y
 * el tiraje. El limite superior es el que impide que un ajuste mal calculado
 * deje mas unidades disponibles de las que el producto llegara a emitir.
 */
const assertAvailability = (printRun: PrintRun, availableUnits: number | null): void => {
  if (printRun.isInfinite) {
    if (availableUnits !== null) {
      throw new DomainError(
        `Un producto de tiraje infinito no lleva contador de unidades disponibles. Se recibio ${String(availableUnits)}.`,
      )
    }

    return
  }

  if (availableUnits === null || !Number.isInteger(availableUnits)) {
    throw new DomainError(
      `Un producto de tiraje limitado necesita un contador entero de unidades disponibles. Se recibio ${String(availableUnits)}.`,
    )
  }

  if (availableUnits < 0 || availableUnits > printRun.value) {
    throw new DomainError(
      `Las unidades disponibles deben estar entre 0 y el tiraje ${String(printRun.value)}. Se recibio ${String(availableUnits)}.`,
    )
  }
}

export interface CanonicalProductSnapshot {
  readonly productId: string
  readonly sku: string
  readonly name: string
  readonly normalizedName: string
  readonly imageUrl: string
  readonly description: string
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: number
  readonly printRunMode: PrintRunMode
  /**
   * Unidades que aun pueden emitirse. `null` en tiraje infinito, y ahi es un
   * valor deliberado y no una ausencia: CA-03 exige que un producto infinito no
   * lleve contador alguno.
   *
   * Las unidades ya entregadas NO se guardan porque son derivables:
   * `printRun - availableUnits`. Un segundo contador solo anadiria una forma de
   * que dos numeros que siempre deben cuadrar dejen de hacerlo.
   */
  readonly availableUnits: number | null
  readonly lifecycleStatus: LifecycleStatus
  readonly creditsPrice: number
  readonly premium: boolean
  readonly realMoneyPrice: { readonly amount: number; readonly currency: string } | null
  /**
   * Promedio de calificaciones (HU-40, CA-03). `null` sin calificaciones
   * todavia. Lo calcula y lo empuja Community; Catalog solo lo conserva.
   */
  readonly averageRating: number | null
  readonly reviewCount: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly version: number
}

/** Agregado canónico aditivo; el agregado heredado continúa operando por SKU. */
export class CanonicalProduct {
  readonly productId: ProductId
  readonly sku: Sku
  readonly name: ProductName
  readonly normalizedName: string
  readonly imageUrl: ProductImageUrl
  readonly description: ProductDescription
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: PrintRun
  readonly availableUnits: number | null
  readonly lifecycleStatus: LifecycleStatus
  readonly creditsPrice: CreditsPrice
  readonly premium: boolean
  readonly realMoneyPrice: Money | null
  readonly averageRating: number | null
  readonly reviewCount: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly version: number

  private constructor(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    availableUnits: number | null
    pricing: ProductPricing
    createdAt: Date
    lifecycleStatus: LifecycleStatus
    updatedAt: Date
    averageRating: number | null
    reviewCount: number
    version?: number
  }) {
    this.productId = params.productId
    this.sku = params.sku
    this.name = params.name
    this.normalizedName = normalizeProductName(params.name.value)
    this.imageUrl = params.imageUrl
    this.description = params.description
    this.type = params.type
    this.attributes = params.attributes
    this.printRun = params.printRun
    // La invariante se comprueba aqui ADEMAS de en el validador de MongoDB.
    // No es redundancia gratuita: el validador protege la base de escrituras
    // por cualquier via, y esta comprobacion hace que un error de calculo falle
    // en el dominio -donde se ve la causa- y no como un `Document failed
    // validation` a cinco capas de distancia.
    assertAvailability(params.printRun, params.availableUnits)
    this.availableUnits = params.availableUnits
    this.creditsPrice = params.pricing.creditsPrice
    this.premium = params.pricing.premium
    this.realMoneyPrice = params.pricing.realMoneyPrice
    this.lifecycleStatus = params.lifecycleStatus
    assertRatingAggregate(params.averageRating, params.reviewCount)
    this.averageRating = params.averageRating
    this.reviewCount = params.reviewCount
    this.createdAt = new Date(params.createdAt)
    this.updatedAt = new Date(params.updatedAt)
    this.version = params.version ?? 0
  }

  static create(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    pricing: ProductPricing
    createdAt: Date
  }): CanonicalProduct {
    return new CanonicalProduct({
      ...params,
      // Un producto nace con todo su tiraje por emitir; infinito nace sin
      // contador.
      availableUnits: params.printRun.isInfinite ? null : params.printRun.value,
      lifecycleStatus: LifecycleStatus.Active,
      updatedAt: params.createdAt,
      // Un producto nace sin calificaciones (HU-40): las empuja Community
      // cuando exista la primera.
      averageRating: null,
      reviewCount: 0,
      version: 0,
    })
  }

  static restore(params: {
    productId: ProductId
    sku: Sku
    name: ProductName
    imageUrl: ProductImageUrl
    description: ProductDescription
    type: ProductType
    attributes: ProductAttributes
    printRun: PrintRun
    availableUnits: number | null
    pricing: ProductPricing
    lifecycleStatus: LifecycleStatus
    createdAt: Date
    updatedAt: Date
    averageRating: number | null
    reviewCount: number
    version?: number
  }): CanonicalProduct {
    return new CanonicalProduct(params)
  }

  /**
   * Unidades ya entregadas. `null` en tiraje infinito, donde no se cuentan.
   *
   * SE DERIVA, no se guarda. La invariante `entregadas = tiraje - disponibles`
   * se sostiene en los tres unicos momentos en que algo cambia: al crear
   * -disponibles = tiraje, entregadas = 0-, al adquirir -disponibles baja uno,
   * entregadas sube uno- y al ajustar el tiraje, que recalcula disponibles a
   * partir de estas mismas entregadas. Guardar un segundo contador solo
   * anadiria una forma de que los dos numeros dejaran de cuadrar.
   */
  get deliveredUnits(): number | null {
    return this.availableUnits === null ? null : this.printRun.value - this.availableUnits
  }

  /** Un producto de tiraje limitado sin unidades disponibles. Infinito nunca. */
  get isSoldOut(): boolean {
    return this.availableUnits !== null && this.availableUnits === 0
  }

  /**
   * Ajusta el tiraje y recalcula la disponibilidad (HU-34, CA-02).
   *
   * DEVUELVE UN AGREGADO NUEVO. La version no se toca aqui: el repositorio
   * escribe condicionado a la version que leyo, de modo que dos ajustes
   * simultaneos no pueden pisarse.
   *
   * De limitado a infinito se permite en cualquier momento. La conversion
   * inversa NO: al pasar a infinito, `availableUnits` es null y las unidades
   * entregadas dejan de ser derivables, asi que no hay con que comprobar la
   * regla `nuevoTiraje >= entregadas`. Inventar ese numero seria peor que
   * negarse; se rechaza de forma explicita.
   */
  adjustPrintRun(printRun: PrintRun, at: Date): CanonicalProduct {
    const entregadas = this.deliveredUnits

    if (printRun.isInfinite) {
      return this.copyWith(printRun, null, at)
    }

    if (entregadas === null) {
      throw new DomainError(
        'Convertir un tiraje infinito en limitado no esta soportado: no hay registro de las unidades ya entregadas con el que comprobar la regla.',
      )
    }

    if (printRun.value < entregadas) {
      throw new DomainError(
        `El tiraje no puede ser inferior a las unidades ya entregadas (${String(entregadas)}).`,
      )
    }

    return this.copyWith(printRun, printRun.value - entregadas, at)
  }

  /**
   * Activa o actualiza la condicion premium y su precio en moneda real (HU-36).
   *
   * `pricing` ya trae la invariante de `ProductPricing` resuelta (premium
   * exige precio real positivo; no premium no admite precio real). El
   * creditsPrice de `pricing` se ignora a proposito: esta operacion es sobre
   * la condicion premium, no sobre el precio en creditos.
   *
   * RETIRAR premium (pasar de `true` a `false`) NO esta soportado todavia: esa
   * transicion exige saber si el producto ya tuvo una compra en moneda real, y
   * esa informacion vive en Commerce, no en Catalog (HU-36.6, sin resolver
   * todavia). Un campo local que nunca pudiera pasar a `true` seria peor que
   * no tener la regla -aparentaria protegerla y en realidad permitiria retirar
   * premium siempre-, asi que se rechaza la transicion completa en vez de
   * simularla a medias con un dato que nadie puede escribir aun.
   */
  configurePremium(pricing: ProductPricing, at: Date): CanonicalProduct {
    if (this.premium && !pricing.premium) {
      throw new DomainError(
        'Retirar la condicion premium no esta soportado todavia: requiere resolver primero la verificacion de compras en moneda real (HU-36.6).',
      )
    }

    return new CanonicalProduct({
      productId: this.productId,
      sku: this.sku,
      name: this.name,
      imageUrl: this.imageUrl,
      description: this.description,
      type: this.type,
      attributes: this.attributes,
      printRun: this.printRun,
      availableUnits: this.availableUnits,
      pricing: {
        creditsPrice: this.creditsPrice,
        premium: pricing.premium,
        realMoneyPrice: pricing.realMoneyPrice,
      },
      lifecycleStatus: this.lifecycleStatus,
      createdAt: this.createdAt,
      updatedAt: at,
      // Esta operacion es sobre premium, no sobre calificaciones: se
      // conservan intactas, igual que `copyWith` cuando no recibe `rating`.
      averageRating: this.averageRating,
      reviewCount: this.reviewCount,
      // La version AVANZA, por la misma razon que en `adjustPrintRun`: sin
      // avanzar, dos configuraciones simultaneas leerian la misma version y la
      // segunda pisaria a la primera sin que nada lo notara.
      version: this.version + 1,
    })
  }

  private copyWith(
    printRun: PrintRun,
    availableUnits: number | null,
    at: Date,
    rating?: { averageRating: number | null; reviewCount: number },
  ): CanonicalProduct {
    return new CanonicalProduct({
      productId: this.productId,
      sku: this.sku,
      name: this.name,
      imageUrl: this.imageUrl,
      description: this.description,
      type: this.type,
      attributes: this.attributes,
      printRun,
      availableUnits,
      pricing: {
        creditsPrice: this.creditsPrice,
        premium: this.premium,
        realMoneyPrice: this.realMoneyPrice,
      },
      lifecycleStatus: this.lifecycleStatus,
      createdAt: this.createdAt,
      updatedAt: at,
      averageRating: rating?.averageRating ?? this.averageRating,
      reviewCount: rating?.reviewCount ?? this.reviewCount,
      // La version AVANZA. Escribir un cambio conservandola dejaria la
      // concurrencia optimista sin efecto: dos ajustes simultaneos leerian la
      // misma version, y el segundo pisaria al primero sin que nada lo notara.
      version: this.version + 1,
    })
  }

  /**
   * Actualiza el agregado de calificaciones (HU-40, CA-03).
   *
   * DEVUELVE UN AGREGADO NUEVO, igual que `adjustPrintRun`. Quien calcula el
   * promedio y el conteo es Community, dueña de las calificaciones; este
   * metodo solo aplica el valor ya calculado y conserva la invariante -sin
   * calificaciones, sin promedio- en el lado de Catalog.
   */
  withRating(
    rating: { averageRating: number | null; reviewCount: number },
    at: Date,
  ): CanonicalProduct {
    return this.copyWith(this.printRun, this.availableUnits, at, rating)
  }

  /**
   * Consume una unidad.
   *
   * En tiraje infinito devuelve el mismo agregado, sin cambio alguno: CA-03
   * exige que la adquisicion no toque el catalogo.
   *
   * El almacen de MongoDB NO pasa por aqui: alli el decremento es una sola
   * operacion condicionada, porque leer-decidir-escribir deja una ventana en la
   * que dos adquisiciones ven la misma ultima unidad. Este metodo expresa la
   * misma regla para los almacenes que no pueden condicionar la escritura.
   */
  consumeUnit(at: Date): CanonicalProduct {
    return this.reserveUnits(1, at)
  }

  reserveUnits(quantity: number, at: Date): CanonicalProduct {
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new DomainError('La cantidad debe ser un entero positivo seguro.')
    if (this.lifecycleStatus !== LifecycleStatus.Active)
      throw new DomainError('El producto está suspendido.')
    if (this.availableUnits === null) {
      return this
    }

    if (this.availableUnits < quantity) {
      throw new DomainError(`El producto ${this.productId.value} esta agotado.`)
    }

    return this.copyWith(this.printRun, this.availableUnits - quantity, at)
  }

  releaseUnits(quantity: number, at: Date): CanonicalProduct {
    if (!Number.isSafeInteger(quantity) || quantity < 1)
      throw new DomainError('La cantidad debe ser un entero positivo seguro.')
    if (this.availableUnits === null) return this
    if (this.availableUnits + quantity > this.printRun.value)
      throw new DomainError('La devolución supera el tiraje.')
    return this.copyWith(this.printRun, this.availableUnits + quantity, at)
  }

  toSnapshot(): CanonicalProductSnapshot {
    return {
      productId: this.productId.value,
      sku: this.sku.value,
      name: this.name.value,
      normalizedName: this.normalizedName,
      imageUrl: this.imageUrl.value,
      description: this.description.value,
      type: this.type,
      attributes: this.attributes,
      printRun: this.printRun.value,
      printRunMode: this.printRun.mode,
      availableUnits: this.availableUnits,
      lifecycleStatus: this.lifecycleStatus,
      creditsPrice: this.creditsPrice.value,
      premium: this.premium,
      realMoneyPrice:
        this.realMoneyPrice === null
          ? null
          : { amount: this.realMoneyPrice.amount, currency: this.realMoneyPrice.currency },
      averageRating: this.averageRating,
      reviewCount: this.reviewCount,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      version: this.version,
    }
  }
}

export const normalizeProductName = (name: string): string =>
  name.normalize('NFKC').toLocaleLowerCase('es')
