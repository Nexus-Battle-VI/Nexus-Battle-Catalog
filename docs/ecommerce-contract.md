# Integración de vitrina y compra simulada

Trazabilidad: Refs Nexus-Battle-VI/Nexus-Battle-Management#31 (HU-57) y
Refs Nexus-Battle-VI/Nexus-Battle-Management#33 (HU-59).

## Colección canónica pública

`GET /api/v1/catalog/products` devuelve:

```json
{ "items": [], "page": 1, "pageSize": 16, "total": 0 }
```

`items` utiliza el DTO canónico existente: `productId` UUID, `sku` alias,
`name`, `imageUrl`, `description`, `type`, `attributes`, `printRun`,
`printRunMode`, `availableUnits`, `lifecycleStatus`, `creditsPrice`, `premium`,
`realMoneyPrice`, fechas y versión. La creación canónica alimenta directamente
esta consulta. No se duplican documentos legacy para mostrarlos en la tienda.

| Parámetro opcional     | Regla                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`                | Hasta 200 caracteres; substring literal normalizado NFKC/minúsculas en nombre, descripción, SKU, tipo, valores de atributos y precios. No es una expresión regular. |
| `type`                 | `HEROE`, `HABILIDAD`, `ARMA`, `ARMADURA`, `ITEM`, `EPICA`.                                                                                                          |
| `currency`             | `COP`, `USD` o `EUR`; selecciona la moneda exacta de `realMoneyPrice`.                                                                                              |
| `minPrice`, `maxPrice` | Enteros no negativos en unidades menores; requieren `currency`; mínimo no supera máximo.                                                                            |
| `page`                 | Entero positivo; por defecto 1; páginas fijas de 16.                                                                                                                |

Los filtros se combinan con AND. Se ordena por `normalizedName` y `productId`
como desempate. `total` cuenta todos los resultados antes de paginar; una página
posterior al final devuelve `items: []` con el total real. Solo se muestran
productos `ACTIVE`. Los agotados permanecen visibles con `availableUnits: 0`;
`null` significa tiraje infinito. La elegibilidad de compra se valida de nuevo
en servidor, no se deduce de haber aparecido en la vitrina.

Sin filtro de moneda aparecen también productos no premium y su precio en
créditos. `creditsPrice` es un entero de juego; no se divide por 100. El importe
real es entero en unidades menores de su moneda. Esta API no convierte divisas,
no determina moneda por ubicación y no inventa promociones. Parámetros no
declarados y rangos sin moneda devuelven 400.

Mongo ejecuta la búsqueda, los filtros AND y la paginación. La proyección
`storefrontSearchText` conserva la misma normalización y todos los valores
buscables. Ngrams de 1 a 3 unidades UTF-16 se agrupan en 4096 buckets hash
deterministas, indexados por `idx_products_storefront_search_v1` junto al estado.
Esto acota las claves de índice por producto sin recortar texto ni imponer
un mínimo de caracteres. Las colisiones solo agregan candidatos: `$indexOfCP`
comprueba después la coincidencia literal exacta dentro de Mongo, sin regex ni
ejecución de JavaScript. La agregación ordena y usa `$facet` para devolver el
total y hasta 16 documentos; los campos de búsqueda internos no se transfieren.
Sin texto se usa `idx_products_storefront_order`.

El índice tiene coste de almacenamiento y escritura, de hasta 4096 claves por
producto. Una consulta de un carácter común o un producto con vocabulario muy
grande puede producir muchos candidatos; se conserva el resultado correcto y
la transferencia limitada a una página. No se afirma un tiempo constante.
El límite existente de 256 KiB del payload canónico permanece sin cambios.

La migración nueva `011-storefront-search` amplía el validador, rellena la
proyección de los productos canónicos existentes, exige sus dos campos y crea
el índice. Los documentos legacy conservan su esquema. Creaciones y reemplazos
canónicos recalculan la proyección en `toCanonicalDocument`; reservas y ajustes
de contadores no modifican información buscable.

Despliegue: detener escritores canónicos antiguos, ejecutar las migraciones del
binario nuevo y arrancar ese binario. No mantener versiones antiguas escribiendo
durante el backfill: reemplazan el documento completo. Después de migrar, el
validador rechaza esos reemplazos sin proyección. Una reversión necesita adaptar
el escritor o una migración explícita; no basta arrancar la imagen anterior.
La prueba DB verifica backfill, rechazo de escritor antiguo, actualización de
precio/descripción, filtros, resultados literales y `IXSCAN` mediante `explain`.

La lectura individual existente `GET /api/v1/catalog/products/:reference`
resuelve UUID o SKU y también permite consultar `SUSPENDED` para Inventory.
Si un alias tiene forma de UUID y coincide con otra identidad, prevalece el
`productId` canónico; Mongo y memoria aplican la misma prioridad.
`POST /api/v1/catalog/products/lookup` sigue acotado a referencias conocidas.
La superficie legacy `/api/products` mantiene su contrato durante la migración;
los nuevos consumidores deben usar la colección canónica.

## Imágenes

`imageUrl` conserva el contrato de assets existente. El contenido bajo
`/api/v1/catalog/product-assets/:assetId/content` requiere Bearer y redirige
307 a una URL firmada de corta duración. El cliente debe resolverlo de forma
autenticada y verificar CORS; no debe introducir tokens en query strings.
Este cambio no hace público el bucket ni altera el contrato de imágenes.

## Reserva interna de lote

Solo Commerce puede invocar estos endpoints, con el HMAC existente:
`x-internal-service: commerce`, `x-internal-timestamp` en milisegundos y
`x-internal-signature`. La cadena firmada contiene servicio, método, ruta,
timestamp y SHA256 del JSON canónico ordenado. Ventana de 30 segundos.
No hay JWT de usuario en esta comunicación y las rutas `/api/internal/*`
permanecen fuera del proxy público.

```text
POST /api/internal/v1/catalog/reservations
{
  "reservationId": "UUID",
  "playerId": "sujeto-del-jugador",
  "lines": [{ "productId": "UUID", "quantity": 2 }]
}
```

Cada producto aparece una sola vez; duplicados dan 400. Las líneas se ordenan
por UUID antes de comparar identidad. UUID se normaliza; cantidad de 1 a 9999,
igual al contrato de Inventory. Se requieren líneas no vacías. Los campos no
declarados se rechazan. No se aceptan SKU en lugar de productId.

Respuesta 200 de éxito:

```json
{
  "reservationId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "playerId": "jugador",
  "state": "RESERVED",
  "lines": [{ "productId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "quantity": 2 }],
  "replayed": false
}
```

La reserva valida todo el lote (existencia, ACTIVE y unidades suficientes) y
descuenta productos finitos junto al registro de operación en una transacción
Mongo con snapshot y majority. Infinito no modifica el contador ni la versión
del producto. Si una línea falla, ninguna unidad del lote queda descontada.
La identidad persistida no se elimina al terminar ni tiene TTL.

El rechazo definitivo también se guarda como estado interno `REJECTED`, con
jugador, líneas y motivo. Reintentar el mismo ID tras reponer stock reproduce
el rechazo; una compra nueva necesita un ID nuevo. `REJECTED` nunca aparece en
una respuesta 200. Un ID igual con jugador o contenido distinto es conflicto,
incluso si el primer intento fue rechazado.

```text
POST /api/internal/v1/catalog/reservations/:reservationId/confirmation
POST /api/internal/v1/catalog/reservations/:reservationId/release
{ "playerId": "sujeto-del-jugador" }
```

| Estado actual | confirmation                     | release                                         |
| ------------- | -------------------------------- | ----------------------------------------------- |
| RESERVED      | CONFIRMED; no descuenta otra vez | RELEASED; restaura solo las unidades reservadas |
| CONFIRMED     | 200 replay                       | 409 conflicto                                   |
| RELEASED      | 409 conflicto                    | 200 replay                                      |
| REJECTED      | 409 conflicto                    | 409 conflicto                                   |

Repetir POST de reserva idéntico devuelve su estado actual con `replayed: true`;
no reactiva una reserva RELEASED. Confirmación/liberación verifican el jugador.
Si un producto pasó de finito a infinito, liberar no inventa un contador.

| Respuesta                  | Significado y recuperación                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 400                        | Forma inválida, UUID, cantidad, campos desconocidos o producto duplicado.                                         |
| 401                        | Firma ausente/incorrecta, servicio no permitido o timestamp vencido.                                              |
| 404 `RESERVATION_REJECTED` | Producto ausente al reservar; resultado negativo durable sin efectos de stock.                                    |
| 404                        | Reserva ausente al transicionar, o producto ausente durante liberación; no certifica rechazo inicial sin efectos. |
| 409 `RESERVATION_REJECTED` | Stock insuficiente o producto inactivo; lote no aplicado, resultado negativo durable.                             |
| 409 `RESERVATION_CONFLICT` | Misma identidad con otro payload/jugador o transición incompatible; no inferir ausencia de efectos.               |
| 503                        | Configuración/dependencia no disponible; conservar identidad y reintentar.                                        |

No hay expiración automática: podría liberar stock de una entrega que Commerce
ya ejecutó y aún está recuperando. Commerce coordina **reserva → grant de lote
Inventory → confirmación → orden completada/outbox**. Solo libera una reserva
pendiente ante rechazo definitivo que certifique no entrega; un timeout o
conflicto incierto exige recuperación. Inventory registra posesión, nunca
vuelve a descontar Catalog. Los pagos siguen siendo simulados.

El decremento interno anterior por adquisición individual se conserva para
compatibilidad; ahora también comprueba ACTIVE y rechaza acquisitionId usado
para otro producto/jugador. Commerce no debe ejecutar adquisición individual
y reserva de lote para la misma compra.

## Entrega y aceptación

Aplicar migraciones hasta `010-stock-reservations` antes de usar las nuevas
rutas. Requiere MongoDB con replica set: una instancia sin transacciones no
ofrece las garantías de lote. El adaptador en memoria reproduce contratos y
atomicidad dentro del proceso para pruebas, pero no persiste entre reinicios.

Verificación: typecheck, lint, format, cobertura unit/integration, build y
suite DB con Mongo real. Casos dirigidos: 17 productos, filtros combinados,
atributos/precio en búsqueda, productos suspendidos, stock 0/null, falta de
unidades en una línea, identidad repetida/alterada, rechazo tras reposición,
concurrencia por última unidad, confirmación sin doble descuento y liberación
concurrente. El correo de compra y la aceptación funcional pertenecen al flujo
integrado de Commerce/Inventory/Notifications/Web, no al mero POST de reserva.
