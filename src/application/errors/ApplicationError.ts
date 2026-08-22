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
