export type LogContext = Readonly<Record<string, string | number | boolean | null>>

/**
 * Puerto de registro estructurado. La capa de aplicacion no puede importar
 * `infrastructure/observability/logger` (regla de arquitectura), pero su
 * `Logger` concreto ya cumple esta misma forma, asi que se inyecta sin
 * necesitar un adaptador adicional.
 */
export interface LoggerPort {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}
