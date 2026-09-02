# Nexus-Battle-Catalog

Servicio de catálogo de Nexus Battles VI. Implementa el bounded context **Catalog**: qué productos existen, cómo se llaman, a qué categoría pertenecen, cuánto cuestan y si están a la venta.

Este repositorio contiene código y Pull Requests. No contiene Issues ni Product Backlog: la fuente única de verdad es [Nexus-Battle-Management](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management).

- **Team propietario:** Team Gama
- **Arquitectura interna:** Clean + Hexagonal, con puertos y adaptadores
- **Base de datos objetivo:** MongoDB (ver limitaciones más abajo)
- **Documentación técnica del sistema:** [Nexus-Battle-Infrastructure](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure)

## Dos decisiones que conviene conocer antes de leer el código

**1. Publicar es un paso explícito.** Crear un producto lo deja en `DRAFT`: existe pero no es visible ni comprable. Solo `POST /api/products/:sku/publication` lo expone. Esto evita que un producto a medio definir aparezca a la venta, que es lo que ocurre cuando crear y publicar son la misma operación.

```text
DRAFT  --publish-->  PUBLISHED  --archive-->  ARCHIVED
  ^                                               |
  +----------------- restoreToDraft --------------+
```

Archivar **no borra**: los pedidos ya confirmados siguen refiriéndose al producto. Y un producto archivado que se restaura vuelve a `DRAFT`, nunca directamente a `PUBLISHED`, porque volver a venderlo es una decisión que debe tomarse de nuevo.

**2. El dinero es un entero, no un decimal.** `Money` guarda la cantidad como entero en la **unidad mínima de la moneda** (centavos). Representar importes con punto flotante produce errores de redondeo que se acumulan al sumar líneas de un pedido, y ese error acaba siendo visible para quien compra.

```ts
Money.create(15000, 'COP') // 15.000 COP
Money.create(1500.5, 'COP') // DomainError
```

## Productos Premium

Un producto puede marcarse como `isPremium` y conservar, además de su precio
en créditos, un precio opcional en moneda real. Ambos importes se representan
como enteros en la unidad mínima de su moneda: por ejemplo, `$9.99 USD` se
expresa como `999 USD`.

Los productos creados antes de esta capacidad se interpretan como no Premium y
sin precio real, por lo que permanecen compatibles con el catálogo actual.
El agregado valida que un producto Premium tenga un precio real mayor que cero
y que un producto no Premium no conserve un precio real. Estas invariantes se
aplican tanto al crear como al modificar la configuración Premium.

## Verificacion de identidad

El servicio comprueba el testimonio que acompana a cada peticion contra el JWKS del user pool de Cognito ([ADR-004](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/main/docs/adr/ADR-004-identity-directory.md)). Se verifica el **token de acceso**, no el de identidad: el de identidad describe al usuario para la interfaz, el de acceso es el que autoriza y el unico cuyo `client_id` puede comprobarse.

La comprobacion de firma la hace [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify). **No se implementa verificacion criptografica a mano**: es la clase de codigo donde un error sutil no falla, sino que acepta tokens falsificados en silencio.

**La proteccion es el comportamiento por defecto.** El guard se registra de forma global y hay que excluir explicitamente lo que deba ser publico con `@Public()`. Al reves, cualquier endpoint nuevo naceria desprotegido y ese olvido no falla ninguna prueba.

| Ruta                                           | Proteccion                                                      |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/products` y `GET /api/products/:sku` | **Publica.** El catalogo publicado es informacion de escaparate |
| `POST /api/products`                           | Rol **`ADMINISTRATOR`** y TOTP de aplicacion autenticadora      |
| `POST /api/products/:sku/publication`          | Rol **`ADMINISTRATOR`** y TOTP de aplicacion autenticadora      |
| `POST /api/products/:sku/archival`             | Rol **`ADMINISTRATOR`** y TOTP de aplicacion autenticadora      |
| `POST /api/products/:sku/price`                | Rol **`ADMINISTRATOR`** y TOTP de aplicacion autenticadora      |
| `POST /api/v1/catalog/products`                | Rol **`ADMINISTRATOR`** y TOTP de aplicacion autenticadora      |
| `GET /api/health/*`                            | **Publica.** Un orquestador no lleva testimonio                 |

Antes de esto, **cualquiera podia crear un producto, publicarlo o cambiarle el precio**.

### Un binario de produccion sin autenticacion no arranca

Con `NODE_ENV=production` y `AUTH_MODE=disabled`, `loadConfig` lanza `ConfigurationError` y el servicio **no llega a escuchar**. Es la traduccion en codigo del blocker de ADR-004: un aviso en el registro se pasa por alto; un arranque que falla, no.

| Variable             | Efecto                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `AUTH_MODE=disabled` | Se atribuye la **identidad anonima** a toda peticion. Solo desarrollo local |
| `AUTH_MODE=jwt`      | Exige `COGNITO_USER_POOL_ID` y `COGNITO_CLIENT_ID`                          |

Con autenticacion JWT, las mutaciones administrativas consultan a Account por
la evidencia ligada a `subject + jti + method`. Catalog solicita siempre
`method=AUTHENTICATOR_APP`: SMS y correo no satisfacen esta autorizacion. La
consulta interna usa `ACCOUNT_INTERNAL_URL`, una firma HMAC con
`INTERNAL_SERVICE_AUTH_SECRET` y un tiempo limite configurable mediante
`INTERNAL_TIMEOUT_MS`. Evidencia ausente responde `403`; imposibilidad de
comprobarla responde `503`. En ambos casos la operacion falla antes de persistir.

Con `disabled` no se deja pasar sin mas: se atribuye el sujeto literal `anonymous` con todos los roles. Sin proveedor **no se sabe** quien realiza la peticion, y el dato que se guarde debe decirlo. Un registro firmado por `anonymous` es honesto; uno firmado por un identificador sin verificar, no.

**El despliegue corre con `AUTH_MODE=jwt`**, no con `disabled`: este servicio verifica de verdad quien realiza cada peticion, comprobado de extremo a extremo. `disabled` sigue existiendo para desarrollo local, y con `NODE_ENV=production` impide arrancar.

### De donde sale el rol que este servicio aplica

Los roles llegan en el claim `cognito:groups`. **Los grupos que no corresponden a un rol conocido se descartan**: aceptarlos convertiria el pool en una fuente de roles arbitrarios, donde bastaria crear un grupo con cualquier nombre para inventar un permiso.

Ese claim no lo llena el proveedor por su cuenta. **La fuente de verdad del rol
es Account**, que lo guarda en `account_roles` (PostgreSQL) y lo refleja en los
grupos del pool para que viaje dentro del testimonio. Conviene saberlo por dos
motivos:

- Este servicio **no debe consultar el rol a Account** en cada peticion. Lo lee
  del testimonio, que ya viene firmado, y por eso una caida de Account no tumba
  la autorizacion de este servicio.
- Un rol recien concedido **no aparece hasta que se emite un testimonio nuevo**.
  El anterior sigue siendo valido y sigue diciendo lo que decia cuando se emitio.

Hasta el 2026-08-29 ese reflejo no existia: Account escribia el rol en su base y
el testimonio viajaba sin `cognito:groups`, de modo que este servicio veia **sin
ningun rol** a quien se hubiera registrado. No daba sintoma porque ninguna puerta
de este servicio pide `PLAYER`, pero la divergencia era invisible, no
inexistente.

## Persistencia

MongoDB con el **driver oficial** ([ADR-012](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/main/docs/adr/ADR-012-orm-odm.md)). No hay ODM: el documento que se guarda es exactamente el que se lee en el adaptador.

| Variable                    | Efecto                                                       |
| --------------------------- | ------------------------------------------------------------ |
| `PERSISTENCE_DRIVER=memory` | Repositorio en proceso. **El estado se pierde al reiniciar** |
| `PERSISTENCE_DRIVER=mongo`  | Adaptador real. Exige `MONGODB_URI`                          |

### El esquema no se migra al arrancar

```bash
npm run migrate
```

Es un paso explícito del despliegue, y el motivo es concreto: migrar desde el arranque hace que **varias réplicas migren a la vez**, y que un despliegue con una migración rota deje el servicio en **bucle de reinicio** en lugar de fallar una sola vez, de forma visible.

MongoDB no trae migrador, así que hay uno propio y deliberadamente pequeño: una colección `_migrations` con el nombre como `_id`. Esa unicidad da **exclusión mutua real**, porque la migración se reclama antes de ejecutarse. Si el proceso muere a medias, la siguiente ejecución se niega a continuar y dice cuál quedó incompleta.

### El SKU es la clave del documento heredado

En el modelo actualmente desplegado, el SKU identifica al producto y se usa como `_id`, así que MongoDB garantiza esa unicidad **sin un índice adicional**: un segundo producto con el mismo SKU no se puede ni escribir.

Esta es una descripción del runtime heredado, no del modelo objetivo. ADR-013 establece `productId` como identidad canónica y conserva SKU únicamente como alias temporal durante la migración aditiva. Hasta implementar la persistencia canónica, las rutas y documentos actuales continúan operando por SKU.

### El dinero se guarda como `Long`

El driver guardaría un `number` de JavaScript como `double` de BSON, y **un doble no es el tipo en el que se guarda dinero**. Al leerlo se comprueba que la conversión sea exacta.

Se usa `promoteLongs: false` a propósito: por defecto el driver promociona un entero de 64 bits a número cuando cabe en 53 bits, de modo que el tipo dependería del **valor** y la comprobación solo se ejercitaría con importes grandes — un camino que nadie prueba.

### El validador vive en el motor

La colección se crea con `$jsonSchema`, `validationLevel: 'strict'` y `additionalProperties: false`.

Esto **no** contradice el rechazo de Mongoose en ADR-012: un esquema de Mongoose valida en la **aplicación**, repitiendo lo que el dominio ya hace. Este valida en el **motor**, y es el equivalente de las restricciones `CHECK` de los servicios de PostgreSQL.

### La versión del driver está fijada en la línea 6.x

La `7.6.0` **no conecta** con MongoDB 8.0: el servidor rechaza el saludo del monitor con `Missing required sub-document 'driver' in the client metadata document`. Se comprobó cambiando una sola variable, con la misma imagen del servidor. Queda registrado en ADR-012.

### Pruebas contra el motor real

```bash
npm run test:db
```

Levantan MongoDB 8.0 en un contenedor con Testcontainers. **Necesitan Docker**, y por eso están fuera de `npm test`: quien trabaja en el dominio o en los casos de uso no debería necesitarlo. El CI ejecuta ambas suites.

Lo que comprueban no se puede comprobar de otra forma: que las restricciones existan de verdad y que el guardado haga lo que dice. Un doble de prueba habría pasado con un esquema equivocado.

## Requisitos

| Herramienta | Versión                                       |
| ----------- | --------------------------------------------- |
| Node.js     | 24 LTS (`.nvmrc` fija el major 24)            |
| npm         | 11 o superior                                 |
| Docker      | opcional, para construir y ejecutar la imagen |

Este repositorio usa **npm** y `package-lock.json`. No se utilizan pnpm ni yarn.

## Puesta en marcha

```bash
nvm use
npm ci
cp .env.example .env
npm run dev
```

Con la configuración por defecto el servicio arranca con el repositorio en memoria: no requiere base de datos ni servicios externos.

Documentación interactiva de la API en `http://localhost:3003/api/docs`.

## API

| Método | Ruta                             | Descripción                                                    |
| ------ | -------------------------------- | -------------------------------------------------------------- |
| `POST` | `/api/products`                  | Crea un producto en borrador                                   |
| `GET`  | `/api/products`                  | Lista los productos publicados. Admite `?category=`            |
| `GET`  | `/api/products/:sku`             | Recupera un producto publicado                                 |
| `POST` | `/api/products/:sku/publication` | Publica el producto                                            |
| `POST` | `/api/products/:sku/archival`    | Archiva el producto                                            |
| `POST` | `/api/products/:sku/price`       | Cambia el precio                                               |
| `POST` | `/api/v1/catalog/products`       | Crea un producto canónico de ADR-013                           |
| `GET`  | `/api/health/live`               | El proceso responde. No consulta dependencias                  |
| `GET`  | `/api/health/ready`              | Evalúa las dependencias reales. Responde `503` si alguna falla |
| `GET`  | `/api/version`                   | Servicio, versión y entorno                                    |

Las consultas públicas (`GET`) devuelven `404` para un producto en borrador o archivado: no es un error de implementación, es la regla de visibilidad del dominio.

`POST /api/v1/catalog/products` es la ruta de transición hacia el producto
canónico. Recibe `printRun`; Catalog calcula y devuelve `printRunMode`,
`productId` y `lifecycleStatus`. El `sku` sigue siendo un alias temporal:
puede enviarse por compatibilidad o se genera automáticamente. La ruta exige
un rol administrativo y evidencia TOTP de una aplicacion autenticadora ligada
al `jti` del access token; no acepta esa evidencia desde el cuerpo o cabeceras
de la petición.

## Scripts

Los mismos que el resto de servicios del producto: `dev`, `build`, `start`, `start:prod`, `typecheck`, `lint`, `lint:fix`, `format`, `format:check`, `test`, `test:unit`, `test:integration`, `test:coverage`. La cobertura mínima exigida es del **80 %** y está configurada como umbral en Jest.

## Estructura

```text
src/
  domain/            Product, objetos de valor (Sku, ProductName, Category, Money) y eventos.
  application/       Casos de uso, puertos, DTO y errores.
  adapters/
    inbound/http/    Controladores y contratos HTTP.
    outbound/        Persistencia y utilidades de sistema.
  infrastructure/    Configuracion, observabilidad, salud y raiz de composicion.
test/
  unit/              Pruebas unitarias por capa.
  integration/       API real levantada con el modulo completo.
```

El dominio no importa NestJS, SDK de AWS, ORM, HTTP ni drivers de base de datos. La restricción se verifica en CI mediante reglas de ESLint.

## Versión de TypeScript

**TypeScript 5.9.3**, no 7, porque `@nestjs/cli@11.0.24` la declara como dependencia directa. Es la misma decisión que en el resto de servicios NestJS y está registrada en ADR-002.

## Docker

```bash
docker build -t nexus-battle-catalog:local .
docker run --rm -p 3003:3003 nexus-battle-catalog:local
```

La imagen es multi-etapa, se ejecuta con el usuario sin privilegios `node`, incluye solo dependencias de producción y no contiene secretos.

## Limitaciones conocidas del alcance actual

- **La persistencia por defecto es en memoria y se pierde al reiniciar.** Con `PERSISTENCE_DRIVER=mongo` opera el adaptador real sobre MongoDB con el driver oficial, probado contra un motor en contenedor. El repositorio en memoria no es un resto del andamiaje: es lo que permite probar el dominio y los casos de uso **sin Docker**. El driver está fijado en la línea `6.x`: la `7.6.0` no conecta con MongoDB 8.0.
- **La consulta de evidencia MFA requiere un despliegue coordinado con Account.** Account ya conserva y valida `method=AUTHENTICATOR_APP`, y Catalog firma `{subject, jti, method}`. En cada entorno ambos servicios deben compartir `INTERNAL_SERVICE_AUTH_SECRET`, y Catalog debe resolver `ACCOUNT_INTERNAL_URL`; si la configuración falta o Account no puede comprobar la evidencia, Catalog falla cerrado con `503` y nunca degrada la autorización a solo rol. `AUTH_MODE=disabled` sirve exclusivamente para desarrollo local y está prohibido en producción.
- **No se publica el catálogo hacia otros contextos.** Los eventos de dominio existen y están documentados, pero su transporte depende de ADR-006.
- No hay inventario ni stock: la disponibilidad de unidades no pertenece a este contexto.

## Contribución

Se aplican las convenciones descritas en [CONTRIBUTING.md](CONTRIBUTING.md) y la [política de trazabilidad entre repositorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/blob/main/docs/governance/cross-repository-traceability.md) de Management.

## Licencia

`Licensing pending project governance`. Este repositorio todavía no tiene una licencia asignada; su definición requiere autorización del gobierno del proyecto.
