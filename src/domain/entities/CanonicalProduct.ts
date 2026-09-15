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
  /**
   * Cierto si el producto tuvo al menos una compra en moneda real (HU-36,
   * CA-03). Lo empuja Commerce -dueño de las transacciones- via el contrato
   * interno de HU-36.6; Catalog no calcula esto, solo lo conserva para poder
   * bloquear el retiro de la condicion premium.
   */
  readonly hasRealMoneyPurchase: boolean
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
  readonly hasRealMoneyPurchase: boolean
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
    hasRealMoneyPurchase: boolean
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
    this.hasRealMoneyPurchase = params.hasRealMoneyPurchase
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
      // Un producto nace sin compras: nadie pudo haberlo comprado todavia.
      hasRealMoneyPurchase: false,
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
    hasRealMoneyPurchase: boolean
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
   * RETIRAR premium (pasar de `true` a `false`) solo se rechaza cuando
   * `hasRealMoneyPurchase` es cierto (HU-36, CA-03): ese dato lo empuja
   * Commerce via el contrato interno de HU-36.6, asi que ya vive en este
   * agregado y la invariante se puede sostener aqui. ESTA COMPROBACION SE
   * REPITE en `ConfigureProductPremium` -donde el error se traduce a 409 en
   * vez de al generico 422 que produce este `DomainError`-, siguiendo el mismo
   * criterio de defensa en profundidad que `assertAvailability` documenta:
   * el dominio protege su propia invariante incluso si alguien lo invoca sin
   * pasar por el caso de uso.
   */
  configurePremium(pricing: ProductPricing, at: Date): CanonicalProduct {
    if (this.premium && !pricing.premium && this.hasRealMoneyPurchase) {
      throw new DomainError(
        'No es posible retirar la condicion premium de un producto con compras en moneda real ya registradas.',
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
      // Esta operacion es sobre premium, no sobre calificaciones ni compras:
      // se conservan intactas, igual que `copyWith` cuando no recibe `rating`.
      averageRating: this.averageRating,
      reviewCount: this.reviewCount,
      hasRealMoneyPurchase: this.hasRealMoneyPurchase,
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
    lifecycleStatus?: LifecycleStatus,
    hasRealMoneyPurchase?: boolean,
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
      lifecycleStatus: lifecycleStatus ?? this.lifecycleStatus,
      createdAt: this.createdAt,
      updatedAt: at,
      averageRating: rating?.averageRating ?? this.averageRating,
      reviewCount: rating?.reviewCount ?? this.reviewCount,
      hasRealMoneyPurchase: hasRealMoneyPurchase ?? this.hasRealMoneyPurchase,
      // La version AVANZA. Escribir un cambio conservandola dejaria la
      // concurrencia optimista sin efecto: dos ajustes simultaneos leerian la
      // misma version, y el segundo pisaria al primero sin que nada lo notara.
      version: this.version + 1,
    })
  }

  /**
   * Suspende el producto: borrado logico (HU-35, CA-01). Nunca se elimina el
   * documento ni sus referencias; solo cambia `lifecycleStatus`.
   *
   * Reutiliza guardas que YA EXISTEN en el resto del agregado: `reserveUnits`
   * ya rechaza operar sobre un producto suspendido, y la proyeccion de
   * vitrina publica ya filtra por `lifecycleStatus: ACTIVE`. Esta operacion
   * no necesita tocar ninguna de las dos.
   *
   * IDEMPOTENTE: si ya esta suspendido, devuelve el MISMO agregado (misma
   * referencia, `version` sin avanzar). El caso de uso usa esa igualdad de
   * referencia para no escribir un segundo evento de auditoria ni de outbox.
   */
  suspend(at: Date): CanonicalProduct {
    if (this.lifecycleStatus === LifecycleStatus.Suspended) {
      return this
    }

    return this.copyWith(
      this.printRun,
      this.availableUnits,
      at,
      undefined,
      LifecycleStatus.Suspended,
    )
  }

  /**
   * Reactiva el producto (HU-35, CA-03).
   *
   * NO restituye unidades: `availableUnits` es independiente de
   * `lifecycleStatus`, asi que un producto agotado antes de suspenderse sigue
   * agotado despues de reactivarse, sin logica adicional. Ampliar el tiraje
   * para volver a habilitar adquisiciones es HU-034, no esta operacion.
   *
   * Idempotente igual que `suspend`.
   */
  reactivate(at: Date): CanonicalProduct {
    if (this.lifecycleStatus === LifecycleStatus.Active) {
      return this
    }

    return this.copyWith(this.printRun, this.availableUnits, at, undefined, LifecycleStatus.Active)
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
   * Registra que el producto tuvo una compra en moneda real (HU-36, CA-03).
   *
   * MISMO CRITERIO QUE `withRating`: es una escritura ABSOLUTA que empuja
   * Commerce, no un calculo de este agregado. No se comprueba si ya estaba en
   * `true` porque no hace falta -escribir `true` sobre `true` es exactamente
   * el mismo resultado, sin efecto observable distinto salvo el avance de
   * `version`, igual que un reintento de `updateRating` con el mismo valor.
   */
  withRealMoneyPurchase(at: Date): CanonicalProduct {
    return this.copyWith(this.printRun, this.availableUnits, at, undefined, undefined, true)
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
      hasRealMoneyPurchase: this.hasRealMoneyPurchase,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      version: this.version,
    }
  }
}

export const normalizeProductName = (name: string): string =>
  name.normalize('NFKC').toLocaleLowerCase('es')
