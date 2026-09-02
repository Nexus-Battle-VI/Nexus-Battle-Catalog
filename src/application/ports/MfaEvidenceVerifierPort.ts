/**
 * Puerto de comprobacion de evidencia de segundo factor.
 *
 * Este servicio no presencia el segundo factor: lo presencia Account, que es la
 * autoridad de identidad y quien ejecuta el inicio de sesion. Aqui solo se
 * pregunta si un testimonio concreto nacio de el.
 *
 * ES UN PUERTO Y NO UNA LLAMADA HTTP DIRECTA para que la autorizacion pueda
 * ejercitarse sin red: las pruebas de que una mutacion administrativa falla
 * cerrada ante un tiempo de espera agotado no deberian depender de levantar
 * otro servicio.
 */
export const MfaEvidenceOutcome = {
  /** Existe evidencia vigente para ese sujeto y ese testimonio. */
  Valid: 'valid',
  /** Se pudo preguntar, y no hay evidencia. Es una DENEGACION. */
  Absent: 'absent',
  /**
   * NO se pudo comprobar: tiempo de espera agotado, error del servicio o
   * respuesta ininteligible.
   *
   * Se distingue de `Absent` a proposito. Ambos impiden la operacion, pero
   * confundirlos convertiria una caida de infraestructura en «esta persona no
   * tiene segundo factor», que es una afirmacion falsa sobre alguien y ademas
   * envia a depurar al sitio equivocado.
   */
  Unavailable: 'unavailable',
} as const

export type MfaEvidenceOutcome = (typeof MfaEvidenceOutcome)[keyof typeof MfaEvidenceOutcome]

export interface MfaEvidenceVerifierPort {
  verify(subject: string, jti: string): Promise<MfaEvidenceOutcome>
}

export const MFA_EVIDENCE_VERIFIER = Symbol('MfaEvidenceVerifierPort')
