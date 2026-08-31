import { DomainError } from '../../src/domain/errors/DomainError'
import { ProductType } from '../../src/domain/value-objects/canonical-product-values'
import { parseProductAttributes } from '../../src/domain/value-objects/product-attributes'
import { parseProductEffect } from '../../src/domain/value-objects/product-effects'

const IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const

const fixed = (amount = 2): object => ({ mode: 'FIXED', amount })
const dice = (): object => ({ mode: 'DICE', count: 2, sides: 6 })
const damage = (): object => ({ kind: 'DAMAGE', target: 'OPPONENT', magnitude: dice() })

const envelope = (values: object): object => ({ schemaVersion: '1', values })

describe('ProductAttributes schemaVersion 1', () => {
  it.each([
    [
      ProductType.Hero,
      {
        kind: 'HEROE',
        heroSubtype: 'GUERRERO_ARMAS',
        basePower: 3,
        baseHealth: 10,
        baseDefense: 2,
        baseAttack: fixed(),
        baseDamage: dice(),
        abilities: IDS,
      },
    ],
    [
      ProductType.Ability,
      {
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['MAGO_FUEGO'],
        powerCostMode: 'FIXED',
        powerCost: 2,
        effects: [damage()],
      },
    ],
    [
      ProductType.Weapon,
      {
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [damage()],
        setCode: 'SET_FUEGO',
      },
    ],
    [
      ProductType.Armor,
      {
        kind: 'ARMADURA',
        compatibilityScope: 'SELECTED_SUBTYPES',
        compatibleHeroSubtypes: ['CHAMAN'],
        slot: 'CHEST',
        effects: [
          {
            kind: 'STAT_MODIFIER',
            target: 'SELF',
            statistic: 'DEFENSE',
            operation: 'INCREASE',
            magnitude: fixed(),
          },
        ],
      },
    ],
    [
      ProductType.Item,
      {
        kind: 'ITEM',
        compatibilityScope: 'ALL_HEROES',
        effects: [{ kind: 'HEALING', target: 'SELF', magnitude: fixed(5) }],
      },
    ],
    [
      ProductType.Epic,
      {
        kind: 'EPICA',
        compatibleHeroSubtype: 'MEDICO',
        generalEffect: { kind: 'HEALING', target: 'ALLIED_GROUP', magnitude: fixed(3) },
        specificEffect: { kind: 'HEALING', target: 'ALLY', magnitude: fixed(8) },
      },
    ],
  ] as const)('acepta un ejemplo valido de %s', (type, values) => {
    expect(parseProductAttributes(envelope(values), type).values.kind).toBe(type)
  })

  it('deriva los campos readOnly de HABILIDAD, efectos y EPICA', () => {
    const ability = parseProductAttributes(
      envelope({
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['MAGO_HIELO'],
        powerCostMode: 'ALL_AVAILABLE',
        effects: [damage()],
      }),
      ProductType.Ability,
    )
    const epic = parseProductAttributes(
      envelope({
        kind: 'EPICA',
        compatibleHeroSubtype: 'MEDICO',
        specificEffect: { kind: 'HEALING', target: 'ALLY', magnitude: fixed() },
      }),
      ProductType.Epic,
    )

    expect(ability.values).toMatchObject({ chargeTurns: 1 })
    expect(ability.values.kind === ProductType.Ability && ability.values.effects[0]).toMatchObject({
      stackable: false,
    })
    expect(epic.values).toMatchObject({ powerCost: 0, cooldownTurns: 2 })
  })

  it.each([
    ['version de esquema desconocida', { schemaVersion: '2', values: {} }, ProductType.Item],
    [
      'propiedad desconocida en el sobre',
      { schemaVersion: '1', values: {}, extra: true },
      ProductType.Item,
    ],
    [
      'kind distinto de type',
      envelope({ kind: 'ITEM', compatibilityScope: 'ALL_HEROES', effects: [damage()] }),
      ProductType.Weapon,
    ],
    [
      'rama de heroe incompleta',
      envelope({
        kind: 'HEROE',
        heroSubtype: 'GUERRERO_ARMAS',
        basePower: 1,
        baseHealth: 1,
        baseDefense: 1,
        baseAttack: fixed(),
        abilities: IDS,
      }),
      ProductType.Hero,
    ],
    [
      'habilidades duplicadas de HEROE',
      envelope({
        kind: 'HEROE',
        heroSubtype: 'CHAMAN',
        basePower: 1,
        baseHealth: 1,
        baseDefense: 1,
        baseHealing: fixed(),
        abilities: [IDS[0], IDS[0], IDS[2]],
      }),
      ProductType.Hero,
    ],
    [
      'coste ausente con FIXED',
      envelope({
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['MAGO_FUEGO'],
        powerCostMode: 'FIXED',
        effects: [damage()],
      }),
      ProductType.Ability,
    ],
    [
      'heroe con menos de tres habilidades',
      envelope({
        kind: 'HEROE',
        heroSubtype: 'CHAMAN',
        basePower: 1,
        baseHealth: 1,
        baseDefense: 1,
        baseHealing: fixed(),
        abilities: IDS.slice(0, 2),
      }),
      ProductType.Hero,
    ],
    [
      'coste presente con ALL_AVAILABLE',
      envelope({
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['MAGO_FUEGO'],
        powerCostMode: 'ALL_AVAILABLE',
        powerCost: 2,
        effects: [damage()],
      }),
      ProductType.Ability,
    ],
    [
      'chargeTurns recibido del cliente',
      envelope({
        kind: 'HABILIDAD',
        compatibleHeroSubtypes: ['MAGO_FUEGO'],
        powerCostMode: 'FIXED',
        powerCost: 2,
        chargeTurns: 1,
        effects: [damage()],
      }),
      ProductType.Ability,
    ],
    [
      'subtipos enviados para ALL_HEROES',
      envelope({
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        compatibleHeroSubtypes: ['MEDICO'],
        effects: [damage()],
      }),
      ProductType.Weapon,
    ],
    [
      'subtipos ausentes para SELECTED_SUBTYPES',
      envelope({
        kind: 'ARMA',
        compatibilityScope: 'SELECTED_SUBTYPES',
        effects: [damage()],
      }),
      ProductType.Weapon,
    ],
    [
      'subtipos duplicados',
      envelope({
        kind: 'ITEM',
        compatibilityScope: 'SELECTED_SUBTYPES',
        compatibleHeroSubtypes: ['MEDICO', 'MEDICO'],
        effects: [damage()],
      }),
      ProductType.Item,
    ],
    [
      'lista vacia para SELECTED_SUBTYPES',
      envelope({
        kind: 'ITEM',
        compatibilityScope: 'SELECTED_SUBTYPES',
        compatibleHeroSubtypes: [],
        effects: [damage()],
      }),
      ProductType.Item,
    ],
    [
      'slot de armadura desconocido',
      envelope({
        kind: 'ARMADURA',
        compatibilityScope: 'ALL_HEROES',
        slot: 'BOOTS',
        effects: [damage()],
      }),
      ProductType.Armor,
    ],
    [
      'setCode invalido',
      envelope({
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [damage()],
        setCode: 'set-invalido',
      }),
      ProductType.Weapon,
    ],
    [
      'efectos vacios',
      envelope({ kind: 'ARMA', compatibilityScope: 'ALL_HEROES', effects: [] }),
      ProductType.Weapon,
    ],
    [
      'EPICA sin efecto especifico',
      envelope({ kind: 'EPICA', compatibleHeroSubtype: 'MEDICO' }),
      ProductType.Epic,
    ],
  ] as const)('rechaza %s', (_case, attributes, type) => {
    expect(() => parseProductAttributes(attributes, type)).toThrow(DomainError)
  })
})

describe('Effect union', () => {
  it.each([
    {
      kind: 'STAT_MODIFIER',
      target: 'SELF',
      statistic: 'POWER',
      operation: 'INCREASE',
      magnitude: fixed(),
    },
    damage(),
    { kind: 'HEALING', target: 'ALLY', magnitude: fixed() },
    { kind: 'IMMUNITY', target: 'SELF', immunityCode: 'POISON' },
    {
      kind: 'REFLECT_DAMAGE',
      target: 'OPPONENT',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 2500 },
      activationCondition: { kind: 'PREVIOUS_TURN_DAMAGE_RECEIVED' },
    },
    {
      kind: 'REVIVE',
      target: 'ALLY',
      magnitude: { mode: 'PERCENTAGE', basisPoints: 5000 },
      activationCondition: { kind: 'ON_LINKED_ALLY_DEATH' },
    },
    { kind: 'TEMPORARY_STATUS', target: 'OPPONENT', statusCode: 'STUNNED', durationTurns: 2 },
  ] as const)('acepta la variante $kind', (effect) => {
    expect(parseProductEffect(effect, 'effect')).toMatchObject({ stackable: false })
  })

  it.each([
    {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(),
      stackable: false,
    },
    {
      kind: 'REFLECT_DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(),
    },
    { kind: 'TEMPORARY_STATUS', target: 'OPPONENT', statusCode: 'STUNNED' },
    {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(),
      activationCondition: { kind: 'ALWAYS' },
    },
    {
      kind: 'DAMAGE',
      target: 'OPPONENT',
      magnitude: fixed(),
      activationCondition: {
        kind: 'STAT_COMPARISON',
        leftOperand: { subject: 'OPPONENT', statistic: 'ATTACK' },
        operator: 'GT',
        rightOperand: { subject: 'SELF', statistic: 'DEFENSE' },
      },
    },
  ] as const)('rechaza una variante o condicion fuera del contrato', (effect) => {
    expect(() => parseProductEffect(effect, 'effect')).toThrow(DomainError)
  })

  it('acepta EVERY_N_TURNS y STAT_COMPARISON con LT', () => {
    expect(
      parseProductEffect(
        {
          kind: 'DAMAGE',
          target: 'OPPONENT',
          magnitude: dice(),
          activationCondition: { kind: 'EVERY_N_TURNS', intervalTurns: 2 },
        },
        'effect',
      ),
    ).toMatchObject({ activationCondition: { kind: 'EVERY_N_TURNS', intervalTurns: 2 } })

    expect(
      parseProductEffect(
        {
          kind: 'IMMUNITY',
          target: 'SELF',
          immunityCode: 'PHYSICAL_DAMAGE',
          activationCondition: {
            kind: 'STAT_COMPARISON',
            leftOperand: { subject: 'OPPONENT', statistic: 'ATTACK' },
            operator: 'LT',
            rightOperand: { subject: 'SELF', statistic: 'DEFENSE' },
          },
        },
        'effect',
      ),
    ).toMatchObject({ activationCondition: { kind: 'STAT_COMPARISON', operator: 'LT' } })
  })
})
