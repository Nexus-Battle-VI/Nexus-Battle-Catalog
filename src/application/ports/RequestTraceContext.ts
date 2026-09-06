/**
 * Trazabilidad de la solicitud original que produce un hecho de dominio
 * (ADR-017/AsyncAPI `catalog-events-v1`: `correlationId`).
 *
 * Distinto de `AuditActor` (`CanonicalProductPorts.ts`): `AuditActor` dice
 * QUIEN hizo la accion, esto dice QUE solicitud la origino. Se resuelve en la
 * capa HTTP (`adapters/inbound/http/correlation-id.ts`) y llega aqui como un
 * string ya validado -la aplicacion no conoce cabeceras ni el framework.
 */
export interface RequestTraceContext {
  readonly correlationId: string
}
