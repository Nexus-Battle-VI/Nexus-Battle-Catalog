import type { Collection, Db, Filter } from 'mongodb'

import { Product } from '../../../domain/entities/Product'
import { Category, Money, ProductName, Sku } from '../../../domain/value-objects/catalog-values'
import { ProductStatus } from '../../../domain/entities/Product'
import type {
  ProductQuery,
  ProductRepositoryPort,
} from '../../../application/ports/ProductRepositoryPort'
import { toDocument, toSnapshot, type ProductDocument } from './mapping'

/**
 * Repositorio del agregado Product sobre MongoDB, con el driver oficial.
 *
 * Cada consulta esta escrita a la vista. No hay una capa que traduzca objetos a
 * documentos por su cuenta, que es la razon por la que ADR-012 eligio el driver
 * y no un ODM: el documento que se guarda es exactamente el que se lee aqui.
 */
export class MongoProductRepository implements ProductRepositoryPort {
  private readonly products: Collection<ProductDocument>

  constructor(db: Db) {
    this.products = db.collection<ProductDocument>('products')
  }

  /**
   * Guarda el agregado entero.
   *
   * `replaceOne` con `upsert` y no `updateOne` con `$set`: el agregado es la
   * autoridad sobre TODO su contenido, y `$set` dejaria intacto cualquier campo
   * que el documento tuviera de mas —de una version anterior del servicio, por
   * ejemplo—. Reemplazar el documento completo expresa lo que de verdad ocurre.
   *
   * No hace falta transaccion: el agregado es un solo documento, y en MongoDB
   * la escritura de un documento ya es atomica. Es la ventaja de que Product no
   * tenga colecciones anidadas.
   */
  async save(product: Product): Promise<void> {
    const document = toDocument(product.toSnapshot())

    await this.products.replaceOne({ _id: document._id }, document, { upsert: true })
  }

  async findBySku(sku: Sku): Promise<Product | null> {
    const document = await this.products.findOne({ _id: sku.value })

    return document === null ? null : MongoProductRepository.hydrate(document)
  }

  /**
   * Comprueba la existencia sin traerse el documento.
   *
   * La proyeccion deja solo `_id`, que MongoDB ya tiene en el indice: no llega
   * a leer el documento. Traer campos que nadie va a mirar es trabajo que el
   * motor hace para nada.
   */
  async exists(sku: Sku): Promise<boolean> {
    const found = await this.products.findOne({ _id: sku.value }, { projection: { _id: 1 } })

    return found !== null
  }

  /**
   * Busca productos por categoria.
   *
   * Por defecto devuelve **solo los publicados**: un borrador o un archivado no
   * son catalogo, y que aparezcan salvo peticion explicita es la clase de fuga
   * que nadie prueba. `includeHidden` invierte esa decision, y quien la use
   * tiene que decirlo.
   *
   * No hay paginacion porque el puerto no la ofrece todavia. Es deuda
   * consciente: cuando el catalogo crezca, el cambio sera del puerto y de los
   * casos de uso, no solo del adaptador.
   */
  async search(query: ProductQuery): Promise<readonly Product[]> {
    // El filtro se compone de una vez y no por mutacion: los campos del
    // documento son de solo lectura, y eso es deliberado.
    const filter: Filter<ProductDocument> = {
      ...(query.category === undefined ? {} : { category: query.category.value }),
      ...(query.includeHidden === true ? {} : { status: ProductStatus.Published }),
    }

    const documents = await this.products.find(filter).sort({ _id: 1 }).toArray()

    return documents.map((document) => MongoProductRepository.hydrate(document))
  }

  private static hydrate(document: ProductDocument): Product {
    const snapshot = toSnapshot(document)

    return Product.restore({
      sku: Sku.create(snapshot.sku),
      name: ProductName.create(snapshot.name),
      category: Category.create(snapshot.category),
      price: Money.create(snapshot.priceAmount, snapshot.priceCurrency),
      status: snapshot.status,
    })
  }
}
