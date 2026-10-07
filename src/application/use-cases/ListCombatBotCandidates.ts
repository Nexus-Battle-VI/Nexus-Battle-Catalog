import type { CanonicalProduct } from '../../domain/entities/CanonicalProduct'
import { LifecycleStatus, ProductType } from '../../domain/value-objects/canonical-product-values'
import type {
  CombatAbilityDefinition,
  CombatBotCandidatesResponse,
  CombatEquipmentDefinition,
  CombatEpicDefinition,
  CombatHeroDefinition,
} from '../dto/CombatBotCandidatesDto'
import { CombatBotCatalogInconsistencyError } from '../errors/ApplicationError'
import type { CombatBotCandidatesQueryPort } from '../ports/CombatBotCandidatesQueryPort'

const byProductId = (left: { productId: string }, right: { productId: string }): number =>
  left.productId.localeCompare(right.productId)

/**
 * Proyecta el catálogo autoritativo en una lista blanca gameplay-only.
 *
 * No selecciona bot, equipamiento ni épica y no consume RNG. Su única decisión
 * es contractual: cuáles definiciones ACTIVE forman parte del schema v1.
 */
export class ListCombatBotCandidates {
  constructor(private readonly products: CombatBotCandidatesQueryPort) {}

  async execute(): Promise<CombatBotCandidatesResponse> {
    const active = (await this.products.listActiveGameplayDefinitions()).filter(
      (product) => product.lifecycleStatus === LifecycleStatus.Active,
    )
    const heroes = active
      .filter((product) => product.type === ProductType.Hero)
      .map(toHero)
      .sort(byProductId)
    const requiredAbilityIds = new Set(heroes.flatMap((hero) => hero.abilities))
    const abilities = active
      .filter(
        (product) =>
          product.type === ProductType.Ability && requiredAbilityIds.has(product.productId.value),
      )
      .map(toAbility)
      .sort(byProductId)

    const foundAbilityIds = new Set(abilities.map((ability) => ability.productId))
    const missingAbilityId = [...requiredAbilityIds].find((id) => !foundAbilityIds.has(id))
    if (missingAbilityId !== undefined) {
      throw new CombatBotCatalogInconsistencyError(
        `El héroe ACTIVE referencia la habilidad ${missingAbilityId}, pero no existe como HABILIDAD ACTIVE.`,
      )
    }

    const abilitiesById = new Map(abilities.map((ability) => [ability.productId, ability]))
    for (const hero of heroes) {
      const incompatibleAbilityId = hero.abilities.find(
        (abilityId) =>
          !abilitiesById.get(abilityId)?.compatibleHeroSubtypes.includes(hero.heroSubtype),
      )
      if (incompatibleAbilityId !== undefined) {
        throw new CombatBotCatalogInconsistencyError(
          `La habilidad ${incompatibleAbilityId} no declara compatibilidad con el subtipo ${hero.heroSubtype}.`,
        )
      }
    }

    return {
      schemaVersion: '1',
      heroes,
      abilities,
      equipment: active
        .filter(
          (product) =>
            product.type === ProductType.Weapon ||
            product.type === ProductType.Armor ||
            product.type === ProductType.Item,
        )
        .map(toEquipment)
        .sort(byProductId),
      epics: active
        .filter((product) => product.type === ProductType.Epic)
        .map(toEpic)
        .sort(byProductId),
    }
  }
}

const toHero = (product: CanonicalProduct): CombatHeroDefinition => {
  const values = product.attributes.values
  if (values.kind !== ProductType.Hero) throw wrongType(product, ProductType.Hero)

  return {
    productId: product.productId.value,
    sku: product.sku.value,
    heroSubtype: values.heroSubtype,
    basePower: values.basePower,
    baseHealth: values.baseHealth,
    baseDefense: values.baseDefense,
    ...(values.baseAttack === undefined ? {} : { baseAttack: values.baseAttack }),
    ...(values.baseDamage === undefined ? {} : { baseDamage: values.baseDamage }),
    ...(values.baseHealing === undefined ? {} : { baseHealing: values.baseHealing }),
    abilities: [...values.abilities],
  }
}

const toAbility = (product: CanonicalProduct): CombatAbilityDefinition => {
  const values = product.attributes.values
  if (values.kind !== ProductType.Ability) throw wrongType(product, ProductType.Ability)

  return {
    productId: product.productId.value,
    sku: product.sku.value,
    name: product.name.value,
    compatibleHeroSubtypes: [...values.compatibleHeroSubtypes],
    powerCostMode: values.powerCostMode,
    ...(values.powerCost === undefined ? {} : { powerCost: values.powerCost }),
    chargeTurns: values.chargeTurns,
    effects: values.effects,
  }
}

const toEquipment = (product: CanonicalProduct): CombatEquipmentDefinition => {
  const values = product.attributes.values
  if (
    values.kind !== ProductType.Weapon &&
    values.kind !== ProductType.Armor &&
    values.kind !== ProductType.Item
  ) {
    throw wrongType(product, 'ARMA/ARMADURA/ITEM')
  }

  return {
    productId: product.productId.value,
    sku: product.sku.value,
    type: values.kind,
    compatibilityScope: values.compatibilityScope,
    ...(values.compatibleHeroSubtypes === undefined
      ? {}
      : { compatibleHeroSubtypes: [...values.compatibleHeroSubtypes] }),
    effects: values.effects,
    ...(values.kind === ProductType.Armor ? { slot: values.slot } : {}),
    ...('setCode' in values && values.setCode !== undefined ? { setCode: values.setCode } : {}),
  }
}

const toEpic = (product: CanonicalProduct): CombatEpicDefinition => {
  const values = product.attributes.values
  if (values.kind !== ProductType.Epic) throw wrongType(product, ProductType.Epic)

  return {
    productId: product.productId.value,
    sku: product.sku.value,
    name: product.name.value,
    compatibleHeroSubtype: values.compatibleHeroSubtype,
    ...(values.generalEffect === undefined ? {} : { generalEffect: values.generalEffect }),
    specificEffects: values.specificEffects,
    powerCost: values.powerCost,
    cooldownTurns: values.cooldownTurns,
  }
}

const wrongType = (
  product: CanonicalProduct,
  expected: string,
): CombatBotCatalogInconsistencyError =>
  new CombatBotCatalogInconsistencyError(
    `El producto ${product.productId.value} debía ser ${expected}, pero sus atributos son ${product.attributes.values.kind}.`,
  )
