# Contrato de elegibilidad para subasta oficial (HU-66)

Catalog es la única autoridad para decidir si un producto puede publicarse por
el Maestro de Juego y qué marca debe mostrar Auction. El consumidor no debe
inferir la marca ni aceptar una enviada por Web.

## Solicitud

```http
GET /api/internal/v1/catalog/products/{productId}/official-auction-eligibility
x-internal-service: auction
x-internal-timestamp: <epoch en milisegundos>
x-internal-signature: <HMAC-SHA256>
```

La firma usa el contrato HMAC interno existente. La ruta solo admite al
consumidor `auction`; una firma ausente, vencida o inválida responde `401`. Si
el secreto no está configurado, el servicio falla cerrado con `503`.

## Respuesta `200`

```json
{
  "productId": "00000000-0000-4000-8000-000000000101",
  "exclusive": true,
  "officialMark": "OFFICIAL",
  "publishable": true
}
```

- Un producto de tiraje único es exclusivo y recibe `OFFICIAL`.
- Un producto premium es exclusivo y recibe `PREMIUM`, con precedencia sobre
  `OFFICIAL`.
- Un producto ordinario devuelve `exclusive: false`, `officialMark: null` y
  `publishable: false`.
- Un producto suspendido conserva su clasificación, pero devuelve
  `publishable: false`.
- Un identificador inexistente responde `404`.

El esquema pertenece a la versión `v1`; cualquier campo ausente o valor de
marca distinto de `OFFICIAL | PREMIUM | null` debe tratarse como contrato
inválido y fallar de forma cerrada en Auction.
