/**
 * Describe un error de origen desconocido sin producir `[object Object]`.
 *
 * Copia intencional de `infrastructure/observability/describe-error.ts`: la
 * capa de aplicacion no puede importar `infrastructure` (regla de
 * arquitectura), y esta funcion es lo bastante pequena y sin dependencias
 * como para no justificar un puerto propio solo para reutilizarla.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }

  if (error === undefined || error === null) {
    return String(error)
  }

  try {
    return JSON.stringify(error)
  } catch {
    return 'error no serializable'
  }
}
