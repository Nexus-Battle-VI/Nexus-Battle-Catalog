import {
  MfaEvidenceOutcome,
  type MfaEvidenceVerifierPort,
} from '../../../application/ports/MfaEvidenceVerifierPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from './internal-signature'

export interface Logger {
  info(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
  warn(message: string, context?: Readonly<Record<string, string | number | boolean>>): void
}

export interface AccountMfaEvidenceClientOptions {
  /** Base del contrato interno de Account, sin barra final. */
  readonly baseUrl: string
  readonly secret: string
  readonly serviceName: string
  readonly timeoutMs: number
  readonly logger: Logger
  /** Inyectable para probar sin red. */
  readonly fetchImpl?: typeof fetch
}

/** Ruta del contrato interno, relativa a `baseUrl`. */
export const EVIDENCE_PATH = '/api/internal/mfa-evidence/verification'

/**
 * Cliente del contrato interno de Account.
 *
 * FALLA CERRADO POR CONSTRUCCION: todo lo que no sea una respuesta 200 con
 * `valid: true` acaba en `Absent` o en `Unavailable`, nunca en «adelante». No
 * existe camino permisivo, ni siquiera ante un fallo del propio cliente.
 *
 * DISTINGUE «no hay evidencia» de «no se pudo comprobar». Las dos impiden la
 * operacion, pero mezclarlas convertiria una caida de Account en la afirmacion
 * de que alguien no supero el segundo factor -que es falsa- y mandaria a
 * depurar al sitio equivocado.
 *
 * EL TIEMPO DE ESPERA ES EXPLICITO. Sin el, una peticion colgada dejaria la
 * mutacion administrativa esperando hasta el tiempo de espera de la peticion
 * HTTP entrante, y el sintoma seria una interfaz congelada en lugar de un
 * rechazo claro.
 */
export class AccountMfaEvidenceClient implements MfaEvidenceVerifierPort {
  private readonly options: AccountMfaEvidenceClientOptions
  private readonly fetchImpl: typeof fetch

  constructor(options: AccountMfaEvidenceClientOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async verify(subject: string, jti: string): Promise<MfaEvidenceOutcome> {
    const body = { subject, jti }
    const timestamp = String(Date.now())
    const signature = signInternalRequest(this.options.secret, {
      service: this.options.serviceName,
      method: 'POST',
      path: EVIDENCE_PATH,
      timestamp,
      body,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.options.timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.options.baseUrl}${EVIDENCE_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [INTERNAL_SERVICE_HEADER]: this.options.serviceName,
          [INTERNAL_TIMESTAMP_HEADER]: timestamp,
          [INTERNAL_SIGNATURE_HEADER]: signature,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        // Incluye 401: si Account rechaza nuestra firma, este servicio NO puede
        // afirmar nada sobre el segundo factor de nadie. Es indisponibilidad
        // del contrato, no ausencia de evidencia.
        this.options.logger.warn('mfa_evidence_respuesta_no_ok', { status: response.status })

        return MfaEvidenceOutcome.Unavailable
      }

      const payload: unknown = await response.json()

      if (typeof payload !== 'object' || payload === null || !('valid' in payload)) {
        this.options.logger.warn('mfa_evidence_respuesta_ininteligible', {})

        return MfaEvidenceOutcome.Unavailable
      }

      const { valid } = payload

      if (typeof valid !== 'boolean') {
        // Un `valid` que no sea booleano no se interpreta por conveniencia: un
        // `"false"` en texto es veraz en JavaScript y autorizaria la operacion.
        this.options.logger.warn('mfa_evidence_respuesta_ininteligible', {})

        return MfaEvidenceOutcome.Unavailable
      }

      return valid ? MfaEvidenceOutcome.Valid : MfaEvidenceOutcome.Absent
    } catch (error: unknown) {
      this.options.logger.warn('mfa_evidence_no_verificable', {
        reason: error instanceof Error ? error.name : 'desconocido',
      })

      return MfaEvidenceOutcome.Unavailable
    } finally {
      clearTimeout(timer)
    }
  }
}
