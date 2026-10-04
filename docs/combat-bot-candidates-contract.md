# Contrato interno gameplay de candidatos para bots de Combat

## Propósito y ownership

Catalog es la autoridad de héroes, habilidades, equipamiento, compatibilidades y
épicas. Este contrato permite que Combat descubra las definiciones necesarias
para preparar un participante IA de JcE sin consumir la vitrina comercial, sin
conocer SKU de antemano y sin acceder a la base privada de Catalog.

El contrato resuelve Management #575 y desbloquea #557. No selecciona un héroe,
no arma un loadout, no consume RNG, no aplica el 5 % de épica y no construye un
`CombatProfile`: esas decisiones siguen perteneciendo a Combat.

## Método y ruta

```http
GET /api/internal/v1/catalog/combat/bot-candidates
```

La petición no lleva body ni query parameters.

La ruta está excluida del OpenAPI público y no debe publicarse en el proxy. Esa
restricción de red es una defensa adicional; la autorización HMAC sigue siendo
obligatoria aun dentro de la red interna.

## Autenticación

Solo el servicio `combat` está autorizado. No se presenta JWT de usuario.

```text
x-internal-service: combat
x-internal-timestamp: <epoch en milisegundos>
x-internal-signature: <HMAC-SHA256>
```

La firma usa el mecanismo interno existente de Catalog: servicio, método `GET`,
ruta exacta, timestamp y el hash SHA-256 del cuerpo canónico `{}`. La ventana
permitida para el timestamp es de 30 segundos.

Respuestas de seguridad:

- `401 Unauthorized`: cabeceras ausentes, firma inválida, timestamp vencido o
  caller distinto de `combat`;
- `503 Service Unavailable`: `INTERNAL_SERVICE_AUTH_SECRET` no está configurado.

## Schema v1

La respuesta declara `schemaVersion: "1"`. Este valor versiona el contrato de
gameplay; no representa la versión del servicio ni un commit.

```ts
interface CombatBotCandidatesResponse {
  readonly schemaVersion: '1'
  readonly heroes: readonly CombatHeroDefinition[]
  readonly abilities: readonly CombatAbilityDefinition[]
  readonly equipment: readonly CombatEquipmentDefinition[]
  readonly epics: readonly CombatEpicDefinition[]
}
```

Solo se incluyen productos `ACTIVE`. Un catálogo sin definiciones activas
responde `200 OK` con las cuatro colecciones vacías.

### Héroes

Cada elemento contiene únicamente:

- `productId` y `sku`;
- `heroSubtype`;
- `basePower`, `baseHealth` y `baseDefense`;
- `baseAttack` y `baseDamage` para la rama ofensiva, o `baseHealing` para la
  rama de soporte;
- `abilities`, con exactamente los IDs autoritativos del héroe.

Catalog no mantiene una whitelist de subtipos en este caso de uso. Todo subtipo
válido conserva exactamente la rama y los valores definidos por sus atributos.
En particular, un soporte no recibe ataque o daño artificial.

### Habilidades

`abilities` es la unión de las habilidades referenciadas por los héroes ACTIVE;
no se devuelven habilidades huérfanas. Cada definición contiene:

- `productId` y `sku`;
- `compatibleHeroSubtypes`;
- `powerCostMode` y `powerCost` cuando el modo es `FIXED`;
- `chargeTurns`;
- `effects` con la forma normalizada de Catalog.

Si un héroe ACTIVE referencia una habilidad que no existe como HABILIDAD ACTIVE
o que no declara compatibilidad con su subtipo, la operación falla cerrada. No
oculta la inconsistencia devolviendo un dataset incompleto.

### Equipamiento

Incluye productos ACTIVE de tipo `ARMA`, `ARMADURA` e `ITEM`, con:

- `productId`, `sku` y `type`;
- `compatibilityScope` literal (`ALL_HEROES` o `SELECTED_SUBTYPES`);
- `compatibleHeroSubtypes` solo cuando corresponde;
- `effects`;
- `slot` para armaduras;
- `setCode` cuando exista.

`setCode` es un dato descriptivo de la definición. Este contrato no lo convierte
en una regla de obligatoriedad del loadout.

### Épicas

Cada épica ACTIVE contiene:

- `productId` y `sku`;
- `compatibleHeroSubtype`;
- `generalEffect` cuando exista;
- `specificEffects`;
- `powerCost` y `cooldownTurns` derivados del schema normalizado vigente.

## Orden canónico

Cada una de las cuatro colecciones se ordena ascendentemente por `productId` en
la capa de aplicación. El adaptador Mongo también ordena explícitamente y nunca
se depende del orden natural de la colección. Esto permite que un consumidor
aplique RNG reproducible sobre una lista estable.

## Campos excluidos

La proyección es una lista blanca. No expone:

- `name`, `description` ni `imageUrl`;
- `creditsPrice`, `realMoneyPrice` ni `premium`;
- `printRun`, `printRunMode` ni `availableUnits`;
- `averageRating`, `reviewCount` ni compras/ventas;
- fechas, versión interna, identidad de usuarios, ownership o PII.

La disponibilidad comercial no afecta la elegibilidad: un producto ACTIVE
puede participar aunque no tenga stock o sea premium.

## Ejemplo ficticio

```json
{
  "schemaVersion": "1",
  "heroes": [
    {
      "productId": "10000000-0000-4000-8000-000000000010",
      "sku": "ejemplo-soporte",
      "heroSubtype": "SUBTIPO_FICTICIO",
      "basePower": 10,
      "baseHealth": 40,
      "baseDefense": 8,
      "baseHealing": { "mode": "FIXED", "amount": 6 },
      "abilities": [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000003"
      ]
    }
  ],
  "abilities": [],
  "equipment": [],
  "epics": []
}
```

Los valores del ejemplo son fixtures ficticios, no contenido oficial del juego.
