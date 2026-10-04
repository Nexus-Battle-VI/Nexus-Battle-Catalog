import type { ArmorSlot, CompatibilityScope } from '../../domain/value-objects/product-attributes'
import type { BaseCombatValue, ProductEffect } from '../../domain/value-objects/product-effects'

export interface CombatHeroDefinition {
  readonly productId: string
  readonly sku: string
  readonly heroSubtype: string
  readonly basePower: number
  readonly baseHealth: number
  readonly baseDefense: number
  readonly baseAttack?: BaseCombatValue
  readonly baseDamage?: BaseCombatValue
  readonly baseHealing?: BaseCombatValue
  readonly abilities: readonly string[]
}

export interface CombatAbilityDefinition {
  readonly productId: string
  readonly sku: string
  readonly compatibleHeroSubtypes: readonly string[]
  readonly powerCostMode: 'FIXED' | 'ALL_AVAILABLE'
  readonly powerCost?: number
  readonly chargeTurns: 1
  readonly effects: readonly ProductEffect[]
}

export interface CombatEquipmentDefinition {
  readonly productId: string
  readonly sku: string
  readonly type: 'ARMA' | 'ARMADURA' | 'ITEM'
  readonly compatibilityScope: CompatibilityScope
  readonly compatibleHeroSubtypes?: readonly string[]
  readonly effects: readonly ProductEffect[]
  readonly slot?: ArmorSlot
  readonly setCode?: string
}

export interface CombatEpicDefinition {
  readonly productId: string
  readonly sku: string
  readonly compatibleHeroSubtype: string
  readonly generalEffect?: ProductEffect
  readonly specificEffects: readonly ProductEffect[]
  readonly powerCost: 0
  readonly cooldownTurns: 2
}

export interface CombatBotCandidatesResponse {
  readonly schemaVersion: '1'
  readonly heroes: readonly CombatHeroDefinition[]
  readonly abilities: readonly CombatAbilityDefinition[]
  readonly equipment: readonly CombatEquipmentDefinition[]
  readonly epics: readonly CombatEpicDefinition[]
}
