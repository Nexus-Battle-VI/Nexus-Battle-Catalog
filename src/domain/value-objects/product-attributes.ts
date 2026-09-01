import { DomainError } from '../errors/DomainError'
import { ProductId, type ProductType } from './canonical-product-values'
import {
  parseBaseCombatValue,
  parseProductEffect,
  type BaseCombatValue,
  type ProductEffect,
} from './product-effects'
import {
  asStrictObject,
  assertUnique,
  optionalValue,
  parseArray,
  parseEnum,
  parseInteger,
  parseString,
  requiredValue,
  type UnknownObject,
} from './schema-validation'

export const CompatibilityScope = {
  AllHeroes: 'ALL_HEROES',
  SelectedSubtypes: 'SELECTED_SUBTYPES',
} as const

export type CompatibilityScope = (typeof CompatibilityScope)[keyof typeof CompatibilityScope]

export const ArmorSlot = {
  Head: 'HEAD',
  Chest: 'CHEST',
  Gloves: 'GLOVES',
  Bracers: 'BRACERS',
  Pants: 'PANTS',
  Shoes: 'SHOES',
} as const

export type ArmorSlot = (typeof ArmorSlot)[keyof typeof ArmorSlot]

export interface HeroAttributes {
  readonly kind: 'HEROE'
  readonly heroSubtype: string
  readonly basePower: number
  readonly baseHealth: number
  readonly baseDefense: number
  readonly baseAttack?: BaseCombatValue
  readonly baseDamage?: BaseCombatValue
  readonly baseHealing?: BaseCombatValue
  readonly abilities: readonly string[]
}

export interface AbilityAttributes {
  readonly kind: 'HABILIDAD'
  readonly compatibleHeroSubtypes: readonly string[]
  readonly powerCostMode: 'FIXED' | 'ALL_AVAILABLE'
  readonly powerCost?: number
  readonly chargeTurns: 1
  readonly effects: readonly ProductEffect[]
}

interface CompatibleAttributes {
  readonly compatibilityScope: CompatibilityScope
  readonly compatibleHeroSubtypes?: readonly string[]
  readonly effects: readonly ProductEffect[]
}

export interface WeaponAttributes extends CompatibleAttributes {
  readonly kind: 'ARMA'
  readonly setCode?: string
}

export interface ArmorAttributes extends CompatibleAttributes {
  readonly kind: 'ARMADURA'
  readonly slot: ArmorSlot
  readonly setCode?: string
}

export interface ItemAttributes extends CompatibleAttributes {
  readonly kind: 'ITEM'
}

export interface EpicAttributes {
  readonly kind: 'EPICA'
  readonly compatibleHeroSubtype: string
  readonly generalEffect?: ProductEffect
  readonly specificEffect: ProductEffect
  readonly powerCost: 0
  readonly cooldownTurns: 2
}

export type ProductAttributeValues =
  | HeroAttributes
  | AbilityAttributes
  | WeaponAttributes
  | ArmorAttributes
  | ItemAttributes
  | EpicAttributes

export interface ProductAttributes {
  readonly schemaVersion: '1'
  readonly values: ProductAttributeValues
}

const HERO_SUBTYPE_PATTERN = /^[A-Z][A-Z0-9_]*$/
const SET_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
const COMPATIBILITY_SCOPES = Object.values(CompatibilityScope)
const ARMOR_SLOTS = Object.values(ArmorSlot)

export const parseProductAttributes = (
  raw: unknown,
  productType: ProductType,
): ProductAttributes => {
  const envelope = asStrictObject(raw, 'attributes', ['schemaVersion', 'values'])
  const schemaVersion = parseEnum(
    requiredValue(envelope, 'schemaVersion', 'attributes'),
    'attributes.schemaVersion',
    ['1'] as const,
  )
  const values = parseAttributeValues(requiredValue(envelope, 'values', 'attributes'), productType)

  return { schemaVersion, values }
}

export const referencedHeroSubtypes = (attributes: ProductAttributes): readonly string[] => {
  const values = attributes.values

  if (values.kind === 'HEROE') return [values.heroSubtype]
  if (values.kind === 'HABILIDAD') return values.compatibleHeroSubtypes
  if (values.kind === 'EPICA') return [values.compatibleHeroSubtype]

  return values.compatibleHeroSubtypes ?? []
}

export const referencedAbilities = (attributes: ProductAttributes): readonly string[] =>
  attributes.values.kind === 'HEROE' ? attributes.values.abilities : []

const parseAttributeValues = (raw: unknown, productType: ProductType): ProductAttributeValues => {
  const discriminator = asStrictObject(raw, 'attributes.values', attributeKeys(productType))
  const kind = parseString(
    requiredValue(discriminator, 'kind', 'attributes.values'),
    'attributes.values.kind',
  )

  if (kind !== productType) {
    throw new DomainError('attributes.values.kind debe coincidir con type.')
  }

  switch (productType) {
    case 'HEROE':
      return parseHeroAttributes(discriminator)
    case 'HABILIDAD':
      return parseAbilityAttributes(discriminator)
    case 'ARMA':
      return parseWeaponAttributes(discriminator)
    case 'ARMADURA':
      return parseArmorAttributes(discriminator)
    case 'ITEM':
      return parseItemAttributes(discriminator)
    case 'EPICA':
      return parseEpicAttributes(discriminator)
  }
}

const parseHeroAttributes = (record: UnknownObject): HeroAttributes => {
  const path = 'attributes.values'
  const baseAttack = parseOptionalCombatValue(record, 'baseAttack', path)
  const baseDamage = parseOptionalCombatValue(record, 'baseDamage', path)
  const baseHealing = parseOptionalCombatValue(record, 'baseHealing', path)
  const offensive =
    baseAttack !== undefined && baseDamage !== undefined && baseHealing === undefined
  const healing = baseAttack === undefined && baseDamage === undefined && baseHealing !== undefined

  if (!offensive && !healing) {
    throw new DomainError(
      `${path} debe definir baseAttack y baseDamage, o exclusivamente baseHealing.`,
    )
  }

  const abilities = parseProductIdList(
    requiredValue(record, 'abilities', path),
    `${path}.abilities`,
    3,
    3,
  )

  return {
    kind: 'HEROE',
    heroSubtype: parseHeroSubtype(
      requiredValue(record, 'heroSubtype', path),
      `${path}.heroSubtype`,
    ),
    basePower: parseInteger(requiredValue(record, 'basePower', path), `${path}.basePower`, {
      minimum: 0,
    }),
    baseHealth: parseInteger(requiredValue(record, 'baseHealth', path), `${path}.baseHealth`, {
      minimum: 1,
    }),
    baseDefense: parseInteger(requiredValue(record, 'baseDefense', path), `${path}.baseDefense`, {
      minimum: 0,
    }),
    ...(baseAttack === undefined ? {} : { baseAttack }),
    ...(baseDamage === undefined ? {} : { baseDamage }),
    ...(baseHealing === undefined ? {} : { baseHealing }),
    abilities,
  }
}

const parseAbilityAttributes = (record: UnknownObject): AbilityAttributes => {
  const path = 'attributes.values'
  const powerCostMode = parseEnum(
    requiredValue(record, 'powerCostMode', path),
    `${path}.powerCostMode`,
    ['FIXED', 'ALL_AVAILABLE'] as const,
  )
  const rawPowerCost = optionalValue(record, 'powerCost')

  if (powerCostMode === 'FIXED' && rawPowerCost === undefined) {
    throw new DomainError(`${path}.powerCost es obligatorio cuando powerCostMode es FIXED.`)
  }

  if (powerCostMode === 'ALL_AVAILABLE' && rawPowerCost !== undefined) {
    throw new DomainError(`${path}.powerCost no se admite cuando powerCostMode es ALL_AVAILABLE.`)
  }

  return {
    kind: 'HABILIDAD',
    compatibleHeroSubtypes: parseHeroSubtypeList(
      requiredValue(record, 'compatibleHeroSubtypes', path),
      `${path}.compatibleHeroSubtypes`,
    ),
    powerCostMode,
    ...(rawPowerCost === undefined
      ? {}
      : {
          powerCost: parseInteger(rawPowerCost, `${path}.powerCost`, { minimum: 1 }),
        }),
    chargeTurns: 1,
    effects: parseEffects(requiredValue(record, 'effects', path), `${path}.effects`),
  }
}

const parseWeaponAttributes = (record: UnknownObject): WeaponAttributes => {
  const path = 'attributes.values'
  const compatible = parseCompatibility(record, path)
  const setCode = optionalValue(record, 'setCode')

  return {
    kind: 'ARMA',
    ...compatible,
    ...(setCode === undefined ? {} : { setCode: parseSetCode(setCode, `${path}.setCode`) }),
  }
}

const parseArmorAttributes = (record: UnknownObject): ArmorAttributes => {
  const path = 'attributes.values'
  const compatible = parseCompatibility(record, path)
  const setCode = optionalValue(record, 'setCode')

  return {
    kind: 'ARMADURA',
    ...compatible,
    slot: parseEnum(requiredValue(record, 'slot', path), `${path}.slot`, ARMOR_SLOTS),
    ...(setCode === undefined ? {} : { setCode: parseSetCode(setCode, `${path}.setCode`) }),
  }
}

const parseItemAttributes = (record: UnknownObject): ItemAttributes => ({
  kind: 'ITEM',
  ...parseCompatibility(record, 'attributes.values'),
})

const parseEpicAttributes = (record: UnknownObject): EpicAttributes => {
  const path = 'attributes.values'
  const generalEffect = optionalValue(record, 'generalEffect')

  return {
    kind: 'EPICA',
    compatibleHeroSubtype: parseHeroSubtype(
      requiredValue(record, 'compatibleHeroSubtype', path),
      `${path}.compatibleHeroSubtype`,
    ),
    ...(generalEffect === undefined
      ? {}
      : { generalEffect: parseProductEffect(generalEffect, `${path}.generalEffect`) }),
    specificEffect: parseProductEffect(
      requiredValue(record, 'specificEffect', path),
      `${path}.specificEffect`,
    ),
    powerCost: 0,
    cooldownTurns: 2,
  }
}

const parseCompatibility = (record: UnknownObject, path: string): CompatibleAttributes => {
  const compatibilityScope = parseEnum(
    requiredValue(record, 'compatibilityScope', path),
    `${path}.compatibilityScope`,
    COMPATIBILITY_SCOPES,
  )
  const rawSubtypes = optionalValue(record, 'compatibleHeroSubtypes')

  if (compatibilityScope === CompatibilityScope.AllHeroes && rawSubtypes !== undefined) {
    throw new DomainError(
      `${path}.compatibleHeroSubtypes no se admite cuando compatibilityScope es ALL_HEROES.`,
    )
  }

  if (compatibilityScope === CompatibilityScope.SelectedSubtypes && rawSubtypes === undefined) {
    throw new DomainError(`${path}.compatibleHeroSubtypes es obligatorio para SELECTED_SUBTYPES.`)
  }

  return {
    compatibilityScope,
    ...(rawSubtypes === undefined
      ? {}
      : {
          compatibleHeroSubtypes: parseHeroSubtypeList(
            rawSubtypes,
            `${path}.compatibleHeroSubtypes`,
          ),
        }),
    effects: parseEffects(requiredValue(record, 'effects', path), `${path}.effects`),
  }
}

const parseEffects = (raw: unknown, path: string): readonly ProductEffect[] =>
  parseArray(raw, path, 1).map((effect, index) =>
    parseProductEffect(effect, `${path}[${String(index)}]`),
  )

const parseHeroSubtypeList = (raw: unknown, path: string): readonly string[] => {
  const values = parseArray(raw, path, 1).map((value, index) =>
    parseHeroSubtype(value, `${path}[${String(index)}]`),
  )
  assertUnique(values, path)

  return values
}

const parseProductIdList = (
  raw: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly string[] => {
  const values = parseArray(raw, path, minimum).map((value, index) => {
    if (typeof value !== 'string') {
      throw new DomainError(`${path}[${String(index)}] debe ser texto UUID.`)
    }

    return ProductId.create(value).value
  })

  if (values.length > maximum) {
    throw new DomainError(`${path} debe contener como maximo ${String(maximum)} elemento(s).`)
  }

  assertUnique(values, path)
  return values
}

const parseHeroSubtype = (raw: unknown, path: string): string =>
  parseString(raw, path, {
    minLength: 1,
    maxLength: 64,
    pattern: HERO_SUBTYPE_PATTERN,
  })

const parseSetCode = (raw: unknown, path: string): string =>
  parseString(raw, path, { minLength: 1, maxLength: 64, pattern: SET_CODE_PATTERN })

const parseOptionalCombatValue = (
  record: UnknownObject,
  key: string,
  path: string,
): BaseCombatValue | undefined => {
  const raw = optionalValue(record, key)
  return raw === undefined ? undefined : parseBaseCombatValue(raw, `${path}.${key}`)
}

const attributeKeys = (productType: ProductType): readonly string[] => {
  switch (productType) {
    case 'HEROE':
      return [
        'kind',
        'heroSubtype',
        'basePower',
        'baseHealth',
        'baseDefense',
        'baseAttack',
        'baseDamage',
        'baseHealing',
        'abilities',
      ]
    case 'HABILIDAD':
      return ['kind', 'compatibleHeroSubtypes', 'powerCostMode', 'powerCost', 'effects']
    case 'ARMA':
      return ['kind', 'compatibilityScope', 'compatibleHeroSubtypes', 'effects', 'setCode']
    case 'ARMADURA':
      return ['kind', 'compatibilityScope', 'compatibleHeroSubtypes', 'slot', 'effects', 'setCode']
    case 'ITEM':
      return ['kind', 'compatibilityScope', 'compatibleHeroSubtypes', 'effects']
    case 'EPICA':
      return ['kind', 'compatibleHeroSubtype', 'generalEffect', 'specificEffect']
  }
}
