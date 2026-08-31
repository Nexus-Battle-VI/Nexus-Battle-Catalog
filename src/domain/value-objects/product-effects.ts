import { DomainError } from '../errors/DomainError'
import {
  asStrictObject,
  optionalValue,
  parseEnum,
  parseInteger,
  parseString,
  requiredValue,
  type UnknownObject,
} from './schema-validation'

export const EffectTarget = {
  Self: 'SELF',
  Ally: 'ALLY',
  AlliedGroup: 'ALLIED_GROUP',
  Opponent: 'OPPONENT',
  EnemyGroup: 'ENEMY_GROUP',
} as const

export type EffectTarget = (typeof EffectTarget)[keyof typeof EffectTarget]

export const Statistic = {
  Power: 'POWER',
  Health: 'HEALTH',
  Defense: 'DEFENSE',
  Attack: 'ATTACK',
  Damage: 'DAMAGE',
  Healing: 'HEALING',
  CriticalChance: 'CRITICAL_CHANCE',
} as const

export type Statistic = (typeof Statistic)[keyof typeof Statistic]

export const EffectOperation = {
  Increase: 'INCREASE',
  Decrease: 'DECREASE',
  Multiply: 'MULTIPLY',
  Set: 'SET',
  Block: 'BLOCK',
  Restore: 'RESTORE',
} as const

export type EffectOperation = (typeof EffectOperation)[keyof typeof EffectOperation]

export interface FixedMagnitude {
  readonly mode: 'FIXED'
  readonly amount: number
}

export interface PercentageMagnitude {
  readonly mode: 'PERCENTAGE'
  readonly basisPoints: number
}

export interface DiceMagnitude {
  readonly mode: 'DICE'
  readonly count: number
  readonly sides: number
}

export type Magnitude = FixedMagnitude | PercentageMagnitude | DiceMagnitude
export type BaseCombatValue = FixedMagnitude | DiceMagnitude

export interface ConditionOperand {
  readonly subject: 'SELF' | 'OPPONENT'
  readonly statistic: Statistic
}

export type ActivationCondition =
  | { readonly kind: 'EVERY_N_TURNS'; readonly intervalTurns: number }
  | {
      readonly kind: 'STAT_COMPARISON'
      readonly leftOperand: ConditionOperand
      readonly operator: 'LT'
      readonly rightOperand: ConditionOperand
    }
  | { readonly kind: 'ON_LINKED_ALLY_DEATH' }
  | { readonly kind: 'PREVIOUS_TURN_DAMAGE_RECEIVED' }

interface EffectBase {
  readonly target: EffectTarget
  readonly durationTurns?: number
  readonly activationCondition?: ActivationCondition
  readonly stackable: false
}

export type ProductEffect =
  | (EffectBase & {
      readonly kind: 'STAT_MODIFIER'
      readonly statistic: Statistic
      readonly operation: EffectOperation
      readonly magnitude: Magnitude
    })
  | (EffectBase & { readonly kind: 'DAMAGE'; readonly magnitude: Magnitude })
  | (EffectBase & { readonly kind: 'HEALING'; readonly magnitude: Magnitude })
  | (EffectBase & { readonly kind: 'IMMUNITY'; readonly immunityCode: string })
  | (EffectBase & {
      readonly kind: 'REFLECT_DAMAGE'
      readonly magnitude: PercentageMagnitude
    })
  | (EffectBase & {
      readonly kind: 'REVIVE'
      readonly magnitude: FixedMagnitude | PercentageMagnitude
    })
  | (EffectBase & {
      readonly kind: 'TEMPORARY_STATUS'
      readonly statusCode: string
      readonly durationTurns: number
    })

const EFFECT_TARGETS = Object.values(EffectTarget)
const STATISTICS = Object.values(Statistic)
const OPERATIONS = Object.values(EffectOperation)
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

export const parseMagnitude = (value: unknown, path: string): Magnitude => {
  const record = asStrictObject(value, path, ['mode', 'amount', 'basisPoints', 'count', 'sides'])
  const mode = parseEnum(requiredValue(record, 'mode', path), `${path}.mode`, [
    'FIXED',
    'PERCENTAGE',
    'DICE',
  ] as const)

  if (mode === 'FIXED') {
    assertOnlyMagnitudeKeys(record, path, ['mode', 'amount'])
    return {
      mode,
      amount: parseInteger(requiredValue(record, 'amount', path), `${path}.amount`, {
        minimum: 1,
      }),
    }
  }

  if (mode === 'PERCENTAGE') {
    assertOnlyMagnitudeKeys(record, path, ['mode', 'basisPoints'])
    return {
      mode,
      basisPoints: parseInteger(requiredValue(record, 'basisPoints', path), `${path}.basisPoints`, {
        minimum: 1,
        maximum: 10_000,
      }),
    }
  }

  assertOnlyMagnitudeKeys(record, path, ['mode', 'count', 'sides'])
  return {
    mode,
    count: parseInteger(requiredValue(record, 'count', path), `${path}.count`, { minimum: 1 }),
    sides: parseInteger(requiredValue(record, 'sides', path), `${path}.sides`, { minimum: 2 }),
  }
}

export const parseBaseCombatValue = (value: unknown, path: string): BaseCombatValue => {
  const magnitude = parseMagnitude(value, path)

  if (magnitude.mode === 'PERCENTAGE') {
    throw new DomainError(`${path} solo admite magnitud FIXED o DICE.`)
  }

  return magnitude
}

export const parseProductEffect = (value: unknown, path: string): ProductEffect => {
  const untyped = asStrictObject(value, path, [
    'kind',
    'target',
    'durationTurns',
    'activationCondition',
    'statistic',
    'operation',
    'magnitude',
    'immunityCode',
    'statusCode',
  ])
  const kind = parseEnum(requiredValue(untyped, 'kind', path), `${path}.kind`, [
    'STAT_MODIFIER',
    'DAMAGE',
    'HEALING',
    'IMMUNITY',
    'REFLECT_DAMAGE',
    'REVIVE',
    'TEMPORARY_STATUS',
  ] as const)
  const base = parseEffectBase(untyped, path)

  if (kind === 'STAT_MODIFIER') {
    assertEffectKeys(untyped, path, ['statistic', 'operation', 'magnitude'])
    return {
      ...base,
      kind,
      statistic: parseEnum(
        requiredValue(untyped, 'statistic', path),
        `${path}.statistic`,
        STATISTICS,
      ),
      operation: parseEnum(
        requiredValue(untyped, 'operation', path),
        `${path}.operation`,
        OPERATIONS,
      ),
      magnitude: parseMagnitude(requiredValue(untyped, 'magnitude', path), `${path}.magnitude`),
    }
  }

  if (kind === 'DAMAGE' || kind === 'HEALING') {
    assertEffectKeys(untyped, path, ['magnitude'])
    return {
      ...base,
      kind,
      magnitude: parseMagnitude(requiredValue(untyped, 'magnitude', path), `${path}.magnitude`),
    }
  }

  if (kind === 'IMMUNITY') {
    assertEffectKeys(untyped, path, ['immunityCode'])
    return {
      ...base,
      kind,
      immunityCode: parseEffectCode(
        requiredValue(untyped, 'immunityCode', path),
        `${path}.immunityCode`,
      ),
    }
  }

  if (kind === 'REFLECT_DAMAGE') {
    assertEffectKeys(untyped, path, ['magnitude'])
    const magnitude = parseMagnitude(requiredValue(untyped, 'magnitude', path), `${path}.magnitude`)

    if (magnitude.mode !== 'PERCENTAGE') {
      throw new DomainError(`${path}.magnitude debe usar modo PERCENTAGE.`)
    }

    return { ...base, kind, magnitude }
  }

  if (kind === 'REVIVE') {
    assertEffectKeys(untyped, path, ['magnitude'])
    const magnitude = parseMagnitude(requiredValue(untyped, 'magnitude', path), `${path}.magnitude`)

    if (magnitude.mode === 'DICE') {
      throw new DomainError(`${path}.magnitude solo admite FIXED o PERCENTAGE.`)
    }

    return { ...base, kind, magnitude }
  }

  assertEffectKeys(untyped, path, ['statusCode'])
  const durationTurns = base.durationTurns

  if (durationTurns === undefined) {
    throw new DomainError(`${path}.durationTurns es obligatorio para TEMPORARY_STATUS.`)
  }

  return {
    ...base,
    kind,
    durationTurns,
    statusCode: parseEffectCode(requiredValue(untyped, 'statusCode', path), `${path}.statusCode`),
  }
}

const parseEffectBase = (record: UnknownObject, path: string): EffectBase => {
  const durationValue = optionalValue(record, 'durationTurns')
  const conditionValue = optionalValue(record, 'activationCondition')

  return {
    target: parseEnum(requiredValue(record, 'target', path), `${path}.target`, EFFECT_TARGETS),
    ...(durationValue === undefined
      ? {}
      : {
          durationTurns: parseInteger(durationValue, `${path}.durationTurns`, { minimum: 1 }),
        }),
    ...(conditionValue === undefined
      ? {}
      : {
          activationCondition: parseActivationCondition(
            conditionValue,
            `${path}.activationCondition`,
          ),
        }),
    stackable: false,
  }
}

const parseActivationCondition = (value: unknown, path: string): ActivationCondition => {
  const record = asStrictObject(value, path, [
    'kind',
    'intervalTurns',
    'leftOperand',
    'operator',
    'rightOperand',
  ])
  const kind = parseEnum(requiredValue(record, 'kind', path), `${path}.kind`, [
    'EVERY_N_TURNS',
    'STAT_COMPARISON',
    'ON_LINKED_ALLY_DEATH',
    'PREVIOUS_TURN_DAMAGE_RECEIVED',
  ] as const)

  if (kind === 'EVERY_N_TURNS') {
    assertConditionKeys(record, path, ['intervalTurns'])
    return {
      kind,
      intervalTurns: parseInteger(
        requiredValue(record, 'intervalTurns', path),
        `${path}.intervalTurns`,
        { minimum: 1 },
      ),
    }
  }

  if (kind === 'STAT_COMPARISON') {
    assertConditionKeys(record, path, ['leftOperand', 'operator', 'rightOperand'])
    return {
      kind,
      leftOperand: parseConditionOperand(
        requiredValue(record, 'leftOperand', path),
        `${path}.leftOperand`,
      ),
      operator: parseEnum(requiredValue(record, 'operator', path), `${path}.operator`, [
        'LT',
      ] as const),
      rightOperand: parseConditionOperand(
        requiredValue(record, 'rightOperand', path),
        `${path}.rightOperand`,
      ),
    }
  }

  assertConditionKeys(record, path, [])
  return { kind }
}

const parseConditionOperand = (value: unknown, path: string): ConditionOperand => {
  const record = asStrictObject(value, path, ['subject', 'statistic'])

  return {
    subject: parseEnum(requiredValue(record, 'subject', path), `${path}.subject`, [
      'SELF',
      'OPPONENT',
    ] as const),
    statistic: parseEnum(requiredValue(record, 'statistic', path), `${path}.statistic`, STATISTICS),
  }
}

const parseEffectCode = (value: unknown, path: string): string =>
  parseString(value, path, { minLength: 1, maxLength: 64, pattern: CODE_PATTERN })

const assertOnlyMagnitudeKeys = (
  record: UnknownObject,
  path: string,
  allowed: readonly string[],
): void => {
  assertExactKeys(record, path, allowed)
}

const assertEffectKeys = (
  record: UnknownObject,
  path: string,
  specificKeys: readonly string[],
): void => {
  assertExactKeys(record, path, [
    'kind',
    'target',
    'durationTurns',
    'activationCondition',
    ...specificKeys,
  ])
}

const assertConditionKeys = (
  record: UnknownObject,
  path: string,
  specificKeys: readonly string[],
): void => {
  assertExactKeys(record, path, ['kind', ...specificKeys])
}

const assertExactKeys = (record: UnknownObject, path: string, allowed: readonly string[]): void => {
  const unknownKey = Object.keys(record).find((key) => !allowed.includes(key))

  if (unknownKey !== undefined) {
    throw new DomainError(`${path}.${unknownKey} no corresponde a la variante seleccionada.`)
  }
}
