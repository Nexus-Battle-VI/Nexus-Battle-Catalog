# Arquitectura de Nexus-Battle-Catalog

Documento técnico del servicio. La arquitectura del sistema completo, los ADR y los diagramas viven en [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure).

## Bounded context

**Catalog** es responsable de qué productos existen y qué información comercial tienen. Su lenguaje ubicuo se limita a producto, referencia, nombre, categoría, precio y estado de publicación.

No es responsable de cuántas unidades hay disponibles: el stock no pertenece a este contexto. Tampoco de qué posee un jugador, que pertenece a Player/Inventory, ni de qué se ha comprado, que pertenece a Commerce.

### Datos que posee

Catalog es propietario exclusivo de los productos. Ningún otro servicio accede a este almacén, ni directamente ni mediante claves foráneas: Commerce y Player/Inventory referencian productos **por SKU a través de la API**.

Esa es la regla que mantiene el límite. Un `JOIN` desde Commerce hacia la colección de productos convertiría dos servicios en uno solo con dos procesos.

## Capas

```text
+-------------------------------------------------------------+
|  adapters/inbound/http   ProductsController                  |
+-------------------------------------------------------------+
|  application             CreateProduct, PublishProduct,      |
|                          ArchiveProduct, ChangeProductPrice, |
|                          GetProduct, ListProducts, ports/    |
+-------------------------------------------------------------+
|  domain                  Product, Sku, ProductName,          |
|                          Category, Money, eventos            |
+-------------------------------------------------------------+
|  adapters/outbound       InMemoryProductRepository,          |
|                          SystemClock, UuidGenerator          |
+-------------------------------------------------------------+
|  infrastructure          config, observability, health,      |
|                          bootstrap (raiz de composicion)     |
+-------------------------------------------------------------+
```

Las dependencias apuntan siempre hacia el dominio. El dominio no conoce ninguna capa exterior, y la capa de aplicación no conoce NestJS.

## Ciclo de vida del producto

```text
              draft()
                 |
                 v
              DRAFT  <----- restoreToDraft() -----+
                 |                                |
             publish()                            |
                 |                                |
                 v                                |
             PUBLISHED  ---- archive() ---->  ARCHIVED
                                                  ^
                                     archive() desde DRAFT
```

Tres decisiones deliberadas:

1. **Crear no publica.** Un producto nace invisible. Publicar es una decisión comercial explícita.
2. **Archivar no borra.** Los pedidos ya confirmados referencian el producto; eliminarlo rompería su histórico.
3. **Restaurar devuelve a borrador.** Un producto que dejó de venderse y vuelve al catálogo requiere una decisión nueva de publicación, no una reactivación automática.

Un producto archivado tampoco admite cambios de precio: su precio es el que tenía cuando dejó de venderse, y alterarlo distorsionaría el histórico.

## Money: por qué enteros

`Money` guarda la cantidad como **entero en la unidad mínima de la moneda**.

```text
15.000 COP  ->  Money.create(15000, 'COP')
```

La razón es concreta: `0.1 + 0.2 !== 0.3` en punto flotante. Al sumar líneas de un pedido, ese error se acumula y acaba produciendo un total que no coincide con la suma visible de las partes. Modelar el importe como entero elimina la clase entera de errores en lugar de mitigarla con redondeos.

`Money` también rechaza operar importes de monedas distintas. Sumar COP con USD no es un error de redondeo: es una operación sin significado, y el tipo lo impide.

## Puertos

| Puerto                  | Responsabilidad                         | Implementación actual       |
| ----------------------- | --------------------------------------- | --------------------------- |
| `ProductRepositoryPort` | Persistir, recuperar y buscar productos | `InMemoryProductRepository` |
| `ClockPort`             | Proveer el instante actual              | `SystemClock`               |
| `IdGeneratorPort`       | Generar identificadores                 | `UuidGenerator`             |

La búsqueda incluye la bandera `includeHidden`, que **por defecto es falsa**: la visibilidad es la regla, y ver borradores es la excepción que debe pedirse de forma explícita.

## Patrones aplicados

| Patrón                  | Dónde                                    | Por qué                                                       |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Ports and Adapters      | Todas las dependencias externas          | Permite sustituir la persistencia sin tocar el dominio        |
| Repository              | `ProductRepositoryPort`                  | Aísla el agregado del mecanismo de almacenamiento             |
| State                   | `ProductStatus` y sus transiciones       | Concentra en el agregado qué operaciones admite cada estado   |
| Specification implícita | `ProductQuery`                           | Expresa el criterio de búsqueda sin filtrar en el controlador |
| Domain Events           | `published`, `price-changed`, `archived` | Registra hechos del dominio de forma trazable                 |

No se aplica CQRS ni Event Sourcing: el contexto no tiene un modelo de lectura diferenciado ni requiere reconstruir estado histórico.

## Eventos de dominio

| Evento                          | Cuándo                                             |
| ------------------------------- | -------------------------------------------------- |
| `catalog.product.published`     | Un producto pasa a estar disponible                |
| `catalog.product.price-changed` | Cambia el precio; incluye importe anterior y nuevo |
| `catalog.product.archived`      | Un producto deja de estar disponible               |

`price-changed` incluye el importe anterior de forma deliberada: permite a un consumidor detectar la dirección del cambio sin consultar el servicio.

## Observabilidad

Registro JSON estructurado por línea, emitido exclusivamente desde `infrastructure/observability/logger.ts`. El resto del código tiene prohibido escribir en la consola mediante la regla `no-console` de ESLint.

## Salud

`/api/health/live` confirma que el proceso responde y no consulta dependencias. `/api/health/ready` evalúa el repositorio real y responde `503` cuando falla. Una comprobación que lanza una excepción cuenta como fallo, nunca como éxito.

## Limitaciones conocidas del alcance actual

- La persistencia es en memoria y se pierde al reiniciar. El adaptador MongoDB depende de ADR-005, que debe decidir el ODM antes de escribir esquema e índices.
- **No hay control de acceso.** Las operaciones de escritura deberían exigir rol de administrador. Implementarlo requiere que Account emita credenciales verificables, lo que depende del proveedor de identidad pendiente de aprobación. Añadir una comprobación de rol sin identidad verificable sería seguridad aparente, no seguridad.
- Los eventos de dominio no se publican hacia un bus. Su transporte depende de ADR-006.
- No hay gestión de stock ni disponibilidad: no pertenece a este contexto.

Estas limitaciones están declaradas de forma explícita para que la arquitectura de demo no se confunda con la arquitectura objetivo.
