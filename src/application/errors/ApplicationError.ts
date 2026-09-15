/**
 * Errores de la capa de aplicacion. Describen el resultado del caso de uso sin
 * conocer el protocolo: la traduccion a HTTP ocurre en el adaptador de entrada.
 */
export class ProductAlreadyExistsError extends Error {
  constructor(sku: string) {
    super(`Ya existe un producto con la referencia "${sku}".`)
    this.name = 'ProductAlreadyExistsError'
  }
}

export class ProductNotFoundError extends Error {
  constructor(sku: string) {
    super(`No existe un producto con la referencia "${sku}".`)
    this.name = 'ProductNotFoundError'
  }
}

export class CanonicalProductAlreadyExistsError extends Error {
  constructor(name: string, type: string) {
    super(`Ya existe un producto activo con el nombre "${name}" y tipo ${type}.`)
    this.name = 'CanonicalProductAlreadyExistsError'
  }
}

export class CanonicalProductSkuAlreadyExistsError extends Error {
  constructor(sku: string) {
    super(`El alias SKU "${sku}" ya pertenece a otro producto.`)
    this.name = 'CanonicalProductSkuAlreadyExistsError'
  }
}

export class CanonicalProductIdentityAlreadyExistsError extends Error {
  constructor(productId: string) {
    super(`La identidad canónica "${productId}" ya pertenece a otro producto.`)
    this.name = 'CanonicalProductIdentityAlreadyExistsError'
  }
}

export class InvalidHeroSubtypeError extends Error {
  constructor(code: string) {
    super(`El subtipo de heroe "${code}" no existe en el registro funcional vigente.`)
    this.name = 'InvalidHeroSubtypeError'
  }
}

export class HeroSubtypeBranchMismatchError extends Error {
  constructor(code: string, expectedBranch: string) {
    super(`El subtipo "${code}" no corresponde a la rama ${expectedBranch}.`)
    this.name = 'HeroSubtypeBranchMismatchError'
  }
}

export class InvalidAbilityReferenceError extends Error {
  constructor(productId: string) {
    super(`La referencia "${productId}" no corresponde a un producto HABILIDAD existente.`)
    this.name = 'InvalidAbilityReferenceError'
  }
}

export class CanonicalProductConcurrencyConflictError extends Error {
  constructor(productId: string, version: number) {
    super(
      `Conflicto de concurrencia al mutar el producto "${productId}" en version ${String(version)}.`,
    )
    this.name = 'CanonicalProductConcurrencyConflictError'
  }
}

/** HU-36, CA-03: retirar premium de un producto con compras en moneda real ya registradas. */
export class ProductPremiumPurchaseConflictError extends Error {
  constructor(productId: string) {
    super(
      `No es posible retirar la condicion premium del producto "${productId}": ya tiene compras en moneda real registradas.`,
    )
    this.name = 'ProductPremiumPurchaseConflictError'
  }
}

export class OutboxPayloadTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes = 256 * 1024) {
    super(
      `El payload del outbox (${String(sizeBytes)} bytes) supera el limite maximo de ${String(maxBytes)} bytes.`,
    )
    this.name = 'OutboxPayloadTooLargeError'
  }
}

/**
 * El envelope V1 (ADR-017/018, AsyncAPI catalog-events-v1) exige
 * `correlationId` como trazabilidad de la solicitud original. Ningun caso de
 * uso de Catalog la conserva hoy -auditado en codigo-, asi que el dispatcher
 * no puede fabricarla (ni con `eventId`, ni con un UUID nuevo en cada
 * intento) sin romper esa semantica. Ver HU-38, BLOCKER-CONTRACT.
 */
export class MissingCorrelationIdError extends Error {
  constructor(eventId: string, eventType: string) {
    super(
      `El evento de outbox ${eventId} (${eventType}) no tiene correlationId: ` +
        'el contrato exige la trazabilidad de la solicitud original y Catalog no la conserva todavia.',
    )
    this.name = 'MissingCorrelationIdError'
  }
}

/** El eventType del outbox no forma parte del transporte aprobado por HU-38 (ADR-017/018). */
export class UnsupportedOutboxEventTypeError extends Error {
  constructor(eventType: string) {
    super(`El eventType "${eventType}" no tiene un destino de publicacion aprobado.`)
    this.name = 'UnsupportedOutboxEventTypeError'
  }
}

/** El envelope serializado supera el tamaño maximo de mensaje de SQS (ADR-017/018: 65536 bytes). */
export class ProductEventEnvelopeTooLargeError extends Error {
  constructor(eventId: string, sizeBytes: number, maxBytes = 65_536) {
    super(
      `El envelope del evento ${eventId} (${String(sizeBytes)} bytes) supera el limite de ${String(maxBytes)} bytes de SQS.`,
    )
    this.name = 'ProductEventEnvelopeTooLargeError'
  }
}

export class ProductAssetNotFoundError extends Error {
  constructor(assetId: string) {
    super(`El recurso visual "${assetId}" no existe.`)
    this.name = 'ProductAssetNotFoundError'
  }
}

export class ProductAssetExpiredError extends Error {
  constructor(assetId: string) {
    super(`La intencion de carga del asset "${assetId}" ha expirado.`)
    this.name = 'ProductAssetExpiredError'
  }
}

export class ProductAssetConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductAssetConflictError'
  }
}

export class ProductAssetInvalidContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductAssetInvalidContentError'
  }
}

export class ProductAssetAnimatedContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductAssetAnimatedContentError'
  }
}

export class ProductAssetChecksumMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductAssetChecksumMismatchError'
  }
}

export class ProductAssetLengthMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductAssetLengthMismatchError'
  }
}

export class ProductAssetStorageUnavailableError extends Error {
  constructor(
    message = 'El almacenamiento de recursos visuales no esta disponible temporalmente.',
  ) {
    super(message)
    this.name = 'ProductAssetStorageUnavailableError'
  }
}

/** El producto canónico solicitado no existe (HU-34). */
export class CanonicalProductNotFoundError extends Error {
  constructor(productId: string) {
    super(`El producto ${productId} no existe.`)
    this.name = 'CanonicalProductNotFoundError'
  }
}

/**
 * No quedan unidades disponibles (HU-34, CA-01).
 *
 * Es 409 y no 422: la peticion es correcta y lo que falla es el ESTADO del
 * producto en ese instante. La misma peticion habria funcionado un segundo
 * antes, y volvera a funcionar si el administrador amplia el tiraje.
 */
export class ProductSoldOutError extends Error {
  constructor(productId: string) {
    super(`Producto agotado: ${productId}.`)
    this.name = 'ProductSoldOutError'
  }
}
