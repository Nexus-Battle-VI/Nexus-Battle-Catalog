import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'

/**
 * Lectura especializada para el contrato gameplay de Combat (HU-93.1A).
 *
 * El adaptador debe resolver en una sola consulta todas las definiciones
 * canónicas ACTIVE que pueden participar en la preparación de un bot. La capa
 * de aplicación conserva el filtrado defensivo y decide la proyección pública.
 */
export interface CombatBotCandidatesQueryPort {
  listActiveGameplayDefinitions(): Promise<readonly CanonicalProduct[]>
}

export const COMBAT_BOT_CANDIDATES_QUERY = Symbol('CombatBotCandidatesQueryPort')
