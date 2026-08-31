import {
  HeroCombatBranch,
  type HeroSubtypeDefinition,
  type HeroSubtypeRegistryPort,
} from '../../../application/ports/CanonicalProductPorts'

/**
 * Proyección local de hero-subtypes-v1.yaml, aprobada mediante PO-ATTR-01.
 * Es un registro versionado detrás de un puerto, no un enum permanente.
 */
const HERO_SUBTYPES_V1: readonly HeroSubtypeDefinition[] = [
  { code: 'GUERRERO_TANQUE', combatBranch: HeroCombatBranch.Offensive },
  { code: 'GUERRERO_ARMAS', combatBranch: HeroCombatBranch.Offensive },
  { code: 'MAGO_FUEGO', combatBranch: HeroCombatBranch.Offensive },
  { code: 'MAGO_HIELO', combatBranch: HeroCombatBranch.Offensive },
  { code: 'PICARO_VENENO', combatBranch: HeroCombatBranch.Offensive },
  { code: 'PICARO_MACHETE', combatBranch: HeroCombatBranch.Offensive },
  { code: 'CHAMAN', combatBranch: HeroCombatBranch.Healing },
  { code: 'MEDICO', combatBranch: HeroCombatBranch.Healing },
]

export class HeroSubtypeRegistryV1 implements HeroSubtypeRegistryPort {
  private readonly byCode = new Map(HERO_SUBTYPES_V1.map((entry) => [entry.code, entry]))

  findByCode(code: string): Promise<HeroSubtypeDefinition | null> {
    return Promise.resolve(this.byCode.get(code) ?? null)
  }
}
