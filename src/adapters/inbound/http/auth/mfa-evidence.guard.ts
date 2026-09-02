import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import {
  MfaEvidenceOutcome,
  SecondFactorMethod,
  type MfaEvidenceVerifierPort,
} from '../../../../application/ports/MfaEvidenceVerifierPort'
import { REQUIRES_MFA_EVIDENCE, type RequestWithIdentity } from './decorators'

export interface MfaEvidenceGuardOptions {
  readonly reflector: Reflector
  readonly verifier: MfaEvidenceVerifierPort
}

/**
 * Exige evidencia de segundo factor en las mutaciones administrativas.
 *
 * SE EJECUTA DESPUES DE `RolesGuard` y antes del controlador. El orden importa:
 * quien no tiene rol suficiente ya fue rechazado, asi que este guard no gasta
 * una llamada de red por cada intento sin permiso. Y como corre antes del
 * controlador, la comprobacion ocurre ANTES de cualquier efecto persistente: no
 * existe el caso de un producto creado a medias.
 *
 * FALLA CERRADO EN LAS TRES SALIDAS. Evidencia valida continua; evidencia
 * ausente deniega; imposibilidad de comprobar deniega tambien. No hay camino
 * permisivo, ni siquiera cuando Account esta caido.
 *
 * DISTINGUE 403 DE 503, Y NO ES COSMETICO. `403` afirma algo sobre quien pide:
 * su testimonio no acredita segundo factor. `503` afirma algo sobre el sistema:
 * no se pudo comprobar. Devolver 403 ante una caida de Account seria acusar a
 * una persona de no haber hecho algo que quiza si hizo, y mandaria a depurar al
 * sitio equivocado. En ambos casos la operacion NO se ejecuta.
 */
@Injectable()
export class MfaEvidenceGuard implements CanActivate {
  private readonly options: MfaEvidenceGuardOptions

  constructor(options: MfaEvidenceGuardOptions) {
    this.options = options
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const exigida = this.options.reflector.getAllAndOverride<boolean>(REQUIRES_MFA_EVIDENCE, [
      context.getHandler(),
      context.getClass(),
    ])

    if (!exigida) {
      return true
    }

    const { identity } = context.switchToHttp().getRequest<RequestWithIdentity>()

    if (identity === undefined) {
      // No deberia ocurrir: un guard anterior siempre deja identidad. Si el
      // orden cambiara, este camino niega en lugar de reventar con un 500 que
      // ocultaria una ruta administrativa sin comprobar.
      throw new ForbiddenException(
        'La operacion exige TOTP verificado mediante una aplicacion autenticadora.',
      )
    }

    if (identity.jti === null) {
      // Sin `jti` no hay nada que preguntar: ningun testimonio puede acreditar
      // un segundo factor si no se puede identificar. Es el caso de la
      // identidad anonima, que solo existe sin proveedor configurado.
      throw new ForbiddenException(
        'La operacion exige TOTP verificado mediante una aplicacion autenticadora.',
      )
    }

    const outcome = await this.options.verifier.verify(
      identity.subject,
      identity.jti,
      SecondFactorMethod.AuthenticatorApp,
    )

    if (outcome === MfaEvidenceOutcome.Valid) {
      return true
    }

    if (outcome === MfaEvidenceOutcome.Unavailable) {
      throw new ServiceUnavailableException(
        'No se pudo comprobar el segundo factor. Intentelo de nuevo mas tarde.',
      )
    }

    throw new ForbiddenException(
      'La operacion exige TOTP verificado mediante una aplicacion autenticadora.',
    )
  }
}
