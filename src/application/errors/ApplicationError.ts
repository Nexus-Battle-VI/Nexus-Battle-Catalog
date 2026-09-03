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

export class OutboxPayloadTooLargeError extends Error {
  constructor(sizeBytes: number, maxBytes = 256 * 1024) {
    super(
      `El payload del outbox (${String(sizeBytes)} bytes) supera el limite maximo de ${String(maxBytes)} bytes.`,
    )
    this.name = 'OutboxPayloadTooLargeError'
  }
}
