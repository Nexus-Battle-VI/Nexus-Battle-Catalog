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
Las reglas que validan la combinación entre la bandera Premium y el precio real
se entregan en HU-36.2.

## Verificacion de identidad

El servicio comprueba el testimonio que acompana a cada peticion contra el JWKS del user pool de Cognito ([ADR-004](https://github.com/Nexus-Battle-VI/Nexus-Battle-Infrastructure/blob/main/docs/adr/ADR-004-identity-directory.md)). Se verifica el **token de acceso**, no el de identidad: el de identidad describe al usuario para la interfaz, el de acceso es el que autoriza y el unico cuyo `client_id` puede comprobarse.

La comprobacion de firma la hace [`aws-jwt-verify`](https://github.com/awslabs/aws-jwt-verify). **No se implementa verificacion criptografica a mano**: es la clase de codigo donde un error sutil no falla, sino que acepta tokens falsificados en silencio.

**La proteccion es el comportamiento por defecto.** El guard se registra de forma global y hay que excluir explicitamente lo que deba ser publico con `@Public()`. Al reves, cualquier endpoint nuevo naceria desprotegido y ese olvido no falla ninguna prueba.

| Ruta                                           | Proteccion                                                      |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/products` y `GET /api/products/:sku` | **Publica.** El catalogo publicado es informacion de escaparate |
| `POST /api/products`                           | Rol **`ADMINISTRATOR`**                                         |
| `POST /api/products/:sku/publication`          | Rol **`ADMINISTRATOR`**                                         |
| `POST /api/products/:sku/archival`             | Rol **`ADMINISTRATOR`**                                         |
| `POST /api/products/:sku/price`                | Rol **`ADMINISTRATOR`**                                         |
| `GET /api/health/*`                            | **Publica.** Un orquestador no lleva testimonio                 |

Antes de esto, **cualquiera podia crear un producto, publicarlo o cambiarle el precio**.

### Un binario de produccion sin autenticacion no arranca

Con `NODE_ENV=production` y `AUTH_MODE=disabled`, `loadConfig` lanza `ConfigurationError` y el servicio **no llega a escuchar**. Es la traduccion en codigo del blocker de ADR-004: un aviso en el registro se pasa por alto; un arranque que falla, no.

| Variable             | Efecto                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `AUTH_MODE=disabled` | Se atribuye la **identidad anonima** a toda peticion. Estado del blocker |
| `AUTH_MODE=jwt`      | Exige `COGNITO_USER_POOL_ID` y `COGNITO_CLIENT_ID`                       |

Con `disabled` no se deja pasar sin mas: se atribuye el sujeto literal `anonymous` con todos los roles. Sin proveedor **no se sabe** quien realiza la peticion, y el dato que se guarde debe decirlo. Un registro firmado por `anonymous` es honesto; uno firmado por un identificador sin verificar, no.

Los roles llegan en el claim `cognito:groups`. **Los grupos que no corresponden a un rol conocido se descartan**: aceptarlos convertiria el pool en una fuente de roles arbitrarios, donde bastaria crear un grupo con cualquier nombre para inventar un permiso.

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
| `GET`  | `/api/health/live`               | El proceso responde. No consulta dependencias                  |
| `GET`  | `/api/health/ready`              | Evalúa las dependencias reales. Responde `503` si alguna falla |
| `GET`  | `/api/version`                   | Servicio, versión y entorno                                    |

Las consultas públicas (`GET`) devuelven `404` para un producto en borrador o archivado: no es un error de implementación, es la regla de visibilidad del dominio.

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

- **La persistencia es en memoria** y se pierde al reiniciar. El adaptador MongoDB depende de que ADR-005 decida el ODM. Configurar `PERSISTENCE_DRIVER=mongo` valida la configuración y lo advierte en el registro, pero no habilita un adaptador que no existe.
- **No hay control de acceso.** Crear, publicar, archivar y cambiar precios deberían requerir rol de administrador. La autorización depende de que Account emita credenciales verificables, lo que a su vez depende del proveedor de identidad pendiente de aprobación. Añadir aquí una comprobación de rol sin una identidad verificable sería seguridad aparente.
- **No se publica el catálogo hacia otros contextos.** Los eventos de dominio existen y están documentados, pero su transporte depende de ADR-006.
- No hay inventario ni stock: la disponibilidad de unidades no pertenece a este contexto.

## Contribución

Se aplican las convenciones descritas en [CONTRIBUTING.md](CONTRIBUTING.md) y la [política de trazabilidad entre repositorios](https://github.com/Nexus-Battle-VI/Nexus-Battle-Management/blob/main/docs/governance/cross-repository-traceability.md) de Management.

## Licencia

`Licensing pending project governance`. Este repositorio todavía no tiene una licencia asignada; su definición requiere autorización del gobierno del proyecto.
