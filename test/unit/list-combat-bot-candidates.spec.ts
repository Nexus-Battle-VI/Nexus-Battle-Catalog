import { ListCombatBotCandidates } from '../../src/application/use-cases/ListCombatBotCandidates'
import type { CombatBotCandidatesQueryPort } from '../../src/application/ports/CombatBotCandidatesQueryPort'
import { ProductType } from '../../src/domain/value-objects/canonical-product-values'
import { CombatBotCatalogInconsistencyError } from '../../src/application/errors/ApplicationError'
import {
  combatCatalogProduct,
  combatProductId,
  damageEffect,
  fixedMagnitude,
  healingEffect,
} from '../support/combat-bot-candidates-fixtures'

const ability = (sequence: number, subtype: string) =>
  combatCatalogProduct(sequence, ProductType.Ability, {
    kind: 'HABILIDAD',
    compatibleHeroSubtypes: [subtype],
    powerCostMode: 'FIXED',
    powerCost: 2,
    effects: [damageEffect(sequence)],
  })

describe('ListCombatBotCandidates', () => {
  it('proyecta solo definiciones ACTIVE, las clasifica y las ordena por productId', async () => {
    const abilities = [
      ability(13, 'GUERRERO_ARMAS'),
      ability(11, 'GUERRERO_ARMAS'),
      ability(12, 'GUERRERO_ARMAS'),
    ]
    const hero = combatCatalogProduct(20, ProductType.Hero, {
      kind: 'HEROE',
      heroSubtype: 'GUERRERO_ARMAS',
      basePower: 9,
      baseHealth: 44,
      baseDefense: 7,
      baseAttack: fixedMagnitude(4),
      baseDamage: { mode: 'DICE', count: 2, sides: 6 },
      abilities: abilities.map((entry) => entry.productId.value),
    })
    const supportAbilities = [ability(31, 'CHAMAN'), ability(32, 'CHAMAN'), ability(33, 'CHAMAN')]
    const support = combatCatalogProduct(10, ProductType.Hero, {
      kind: 'HEROE',
      heroSubtype: 'CHAMAN',
      basePower: 10,
      baseHealth: 40,
      baseDefense: 8,
      baseHealing: fixedMagnitude(6),
      abilities: supportAbilities.map((entry) => entry.productId.value),
    })
    const weapon = combatCatalogProduct(41, ProductType.Weapon, {
      kind: 'ARMA',
      compatibilityScope: 'SELECTED_SUBTYPES',
      compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
      effects: [damageEffect(5)],
      setCode: 'SET_PRUEBA',
    })
    const armor = combatCatalogProduct(42, ProductType.Armor, {
      kind: 'ARMADURA',
      compatibilityScope: 'ALL_HEROES',
      slot: 'CHEST',
      effects: [
        {
          kind: 'STAT_MODIFIER',
          target: 'SELF',
          statistic: 'DEFENSE',
          operation: 'INCREASE',
          magnitude: fixedMagnitude(3),
        },
      ],
    })
    const item = combatCatalogProduct(43, ProductType.Item, {
      kind: 'ITEM',
      compatibilityScope: 'ALL_HEROES',
      effects: [healingEffect(4)],
    })
    const epic = combatCatalogProduct(50, ProductType.Epic, {
      kind: 'EPICA',
      compatibleHeroSubtype: 'CHAMAN',
      generalEffect: healingEffect(3),
      specificEffects: [healingEffect(8)],
    })
    const suspended = combatCatalogProduct(
      99,
      ProductType.Weapon,
      {
        kind: 'ARMA',
        compatibilityScope: 'ALL_HEROES',
        effects: [damageEffect(99)],
      },
      { suspended: true },
    )
    const source = [
      epic,
      suspended,
      item,
      hero,
      ...abilities,
      armor,
      support,
      weapon,
      ...supportAbilities,
    ]
    const query: CombatBotCandidatesQueryPort = {
      listActiveGameplayDefinitions: () => Promise.resolve(source),
    }

    const result = await new ListCombatBotCandidates(query).execute()

    expect(result.schemaVersion).toBe('1')
    expect(result.heroes.map((entry) => entry.productId)).toEqual([
      combatProductId(10),
      combatProductId(20),
    ])
    expect(result.abilities.map((entry) => entry.productId)).toEqual([
      combatProductId(11),
      combatProductId(12),
      combatProductId(13),
      combatProductId(31),
      combatProductId(32),
      combatProductId(33),
    ])
    expect(result.equipment.map((entry) => entry.productId)).toEqual([
      combatProductId(41),
      combatProductId(42),
      combatProductId(43),
    ])
    expect(result.epics.map((entry) => entry.productId)).toEqual([combatProductId(50)])

    expect(result.heroes[0]).toEqual({
      productId: combatProductId(10),
      sku: 'combat-010',
      heroSubtype: 'CHAMAN',
      basePower: 10,
      baseHealth: 40,
      baseDefense: 8,
      baseHealing: { mode: 'FIXED', amount: 6 },
      abilities: [combatProductId(31), combatProductId(32), combatProductId(33)],
    })
    expect(result.heroes[1]).toMatchObject({
      heroSubtype: 'GUERRERO_ARMAS',
      baseAttack: { mode: 'FIXED', amount: 4 },
      baseDamage: { mode: 'DICE', count: 2, sides: 6 },
    })
    expect(result.heroes[0]).not.toHaveProperty('baseAttack')
    expect(result.heroes[0]).not.toHaveProperty('baseDamage')
    expect(result.heroes[1]).not.toHaveProperty('baseHealing')
    expect(result.equipment[0]).toMatchObject({
      type: 'ARMA',
      compatibilityScope: 'SELECTED_SUBTYPES',
      compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
      setCode: 'SET_PRUEBA',
    })
    expect(result.equipment[1]).toMatchObject({ type: 'ARMADURA', slot: 'CHEST' })
    expect(result.epics[0]).toMatchObject({
      compatibleHeroSubtype: 'CHAMAN',
      powerCost: 0,
      cooldownTurns: 2,
      specificEffects: [expect.objectContaining({ kind: 'HEALING' })],
    })

    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'name',
      'description',
      'imageUrl',
      'creditsPrice',
      'realMoneyPrice',
      'availableUnits',
      'averageRating',
      'reviewCount',
      'premium',
      'hasRealMoneyPurchase',
      'printRun',
      'createdAt',
      'updatedAt',
      'version',
    ]) {
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
  })

  it('devuelve colecciones vacías para un catálogo ACTIVE vacío', async () => {
    const query: CombatBotCandidatesQueryPort = {
      listActiveGameplayDefinitions: () => Promise.resolve([]),
    }

    await expect(new ListCombatBotCandidates(query).execute()).resolves.toEqual({
      schemaVersion: '1',
      heroes: [],
      abilities: [],
      equipment: [],
      epics: [],
    })
  })

  it('falla cerrado si un héroe ACTIVE referencia una habilidad no ACTIVE', async () => {
    const missingIds = [combatProductId(71), combatProductId(72), combatProductId(73)]
    const hero = combatCatalogProduct(70, ProductType.Hero, {
      kind: 'HEROE',
      heroSubtype: 'MAGO_FUEGO',
      basePower: 12,
      baseHealth: 25,
      baseDefense: 3,
      baseAttack: fixedMagnitude(2),
      baseDamage: fixedMagnitude(7),
      abilities: missingIds,
    })
    const query: CombatBotCandidatesQueryPort = {
      listActiveGameplayDefinitions: () => Promise.resolve([hero]),
    }

    await expect(new ListCombatBotCandidates(query).execute()).rejects.toBeInstanceOf(
      CombatBotCatalogInconsistencyError,
    )
  })

  it('falla cerrado si una habilidad referenciada no es compatible con el subtipo', async () => {
    const abilities = [81, 82, 83].map((sequence) => ability(sequence, 'MEDICO'))
    const hero = combatCatalogProduct(80, ProductType.Hero, {
      kind: 'HEROE',
      heroSubtype: 'MAGO_FUEGO',
      basePower: 12,
      baseHealth: 25,
      baseDefense: 3,
      baseAttack: fixedMagnitude(2),
      baseDamage: fixedMagnitude(7),
      abilities: abilities.map((entry) => entry.productId.value),
    })
    const query: CombatBotCandidatesQueryPort = {
      listActiveGameplayDefinitions: () => Promise.resolve([hero, ...abilities]),
    }

    await expect(new ListCombatBotCandidates(query).execute()).rejects.toBeInstanceOf(
      CombatBotCatalogInconsistencyError,
    )
  })
})
