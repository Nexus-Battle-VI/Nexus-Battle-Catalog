/**
 * Tokens de inyeccion de los casos de uso.
 *
 * Los casos de uso son clases sin decoradores: no conocen NestJS. Se registran
 * mediante proveedores explicitos en el modulo.
 */
export const CREATE_PRODUCT = Symbol('CreateProduct')
export const PUBLISH_PRODUCT = Symbol('PublishProduct')
export const ARCHIVE_PRODUCT = Symbol('ArchiveProduct')
export const CHANGE_PRICE = Symbol('ChangeProductPrice')
export const GET_PRODUCT = Symbol('GetProduct')
export const LIST_PRODUCTS = Symbol('ListProducts')
export const CREATE_CANONICAL_PRODUCT = Symbol('CreateCanonicalProduct')
