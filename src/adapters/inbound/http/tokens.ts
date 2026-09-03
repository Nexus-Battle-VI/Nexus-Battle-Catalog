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
export const CREATE_PRODUCT_ASSET_UPLOAD_INTENT = Symbol('CreateProductAssetUploadIntent')
export const FINALIZE_PRODUCT_ASSET = Symbol('FinalizeProductAsset')
export const GET_PRODUCT_ASSET_CONTENT = Symbol('GetProductAssetContent')
export const RECONCILE_PRODUCT_ASSETS = Symbol('ReconcileProductAssets')
export const PRODUCT_ASSET_STORAGE_PORT = Symbol('ProductAssetStoragePort')
export const PRODUCT_ASSET_REPOSITORY_PORT = Symbol('ProductAssetRepositoryPort')
