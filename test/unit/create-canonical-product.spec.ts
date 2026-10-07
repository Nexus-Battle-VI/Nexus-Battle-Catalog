import type { CanonicalProduct } from '../../src/domain/entities/CanonicalProduct'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  LifecycleStatus,
  PrintRunMode,
  ProductType,
  type ProductId,
} from '../../src/domain/value-objects/canonical-product-values'
import { CreateCanonicalProduct } from '../../src/application/use-cases/CreateCanonicalProduct'
import {
  CanonicalProductAlreadyExistsError,
  HeroSubtypeBranchMismatchError,
  InvalidAbilityReferenceError,
  InvalidHeroSubtypeError,
} from '../../src/application/errors/ApplicationError'
import {
  HeroCombatBranch,
  type CanonicalProductWritePort,
  type HeroSubtypeDefinition,
  type HeroSubtypeRegistryPort,
  type OutboxEntry,
  type ProductAuditEntry,
  type ProductReferenceQueryPort,
} from '../../src/application/ports/CanonicalProductPorts'
import type { RequestTraceContext } from '../../src/application/ports/RequestTraceContext'
import { HeroSubtypeRegistryV1 } from '../../src/adapters/outbound/registry/HeroSubtypeRegistryV1'

const TRACE: RequestTraceContext = { correlationId: 'req-create-canonical-product-test' }
const NOW = new Date('2026-08-31T20:00:00.000Z')
const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ABILITY_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const

class ProductWriterFake implements CanonicalProductWritePort {
  readonly created: CanonicalProduct[] = []
  duplicate = false
  checkedName: string | null = null
  checkedType: ProductType | null = null

  existsByNormalizedNameAndType(normalizedName: string, type: ProductType): Promise<boolean> {
    this.checkedName = normalizedName
    this.checkedType = type
    return Promise.resolve(this.duplicate)
  }

  create(product: CanonicalProduct): Promise<void> {
    this.created.push(product)
    return Promise.resolve()
  }

  // Esta suite cubre la CREACION. Los tres metodos que HU-34 anadio al puerto
  // tienen su propia suite; aqui se declaran sin comportamiento para que un uso
  // accidental falle en voz alta en lugar de devolver un vacio plausible.
  findById(): Promise<CanonicalProduct | null> {
    return Promise.reject(new Error('findById no se usa en la creacion.'))
  }

  update(): Promise<void> {
    return Promise.reject(new Error('update no se usa en la creacion.'))
  }

  decrementAvailability(): Promise<never> {
    return Promise.reject(new Error('decrementAvailability no se usa en la creacion.'))
  }

  updateRating(): Promise<never> {
    return Promise.reject(new Error('updateRating no se usa en la creacion.'))
  }

  markRealMoneyPurchase(): Promise<never> {
    return Promise.reject(new Error('markRealMoneyPurchase no se usa en la creacion.'))
  }
}

class HeroSubtypeRegistryFake implements HeroSubtypeRegistryPort {
  readonly definitions = new Map<string, HeroSubtypeDefinition>([
    ['GUERRERO_ARMAS', { code: 'GUERRERO_ARMAS', combatBranch: HeroCombatBranch.Offensive }],
    ['MAGO_FUEGO', { code: 'MAGO_FUEGO', combatBranch: HeroCombatBranch.Offensive }],
    ['CHAMAN', { code: 'CHAMAN', combatBranch: HeroCombatBranch.Healing }],
    ['MEDICO', { code: 'MEDICO', combatBranch: HeroCombatBranch.Healing }],
  ])

  findByCode(code: string): Promise<HeroSubtypeDefinition | null> {
    return Promise.resolve(this.definitions.get(code) ?? null)
  }
}

class ProductReferencesFake implements ProductReferenceQueryPort {
  readonly types = new Map<string, ProductType>(ABILITY_IDS.map((id) => [id, ProductType.Ability]))

  findTypeById(productId: ProductId): Promise<ProductType | null> {
    return Promise.resolve(this.types.get(productId.value) ?? null)
  }
}

const buildHarness = (): {
  useCase: CreateCanonicalProduct
  products: ProductWriterFake
  subtypes: HeroSubtypeRegistryFake
  references: ProductReferencesFake
  generate: jest.Mock<string, []>
} => {
  const products = new ProductWriterFake()
  const subtypes = new HeroSubtypeRegistryFake()
  const references = new ProductReferencesFake()
  const generate = jest.fn(() => PRODUCT_ID)

  return {
    products,
    subtypes,
    references,
    generate,
    useCase: new CreateCanonicalProduct({
      products,
      heroSubtypes: subtypes,
      productReferences: references,
      idGenerator: { generate },
      clock: { now: () => NOW },
    }),
  }
}

const heroCommand = (): object => ({
  sku: 'guerrero-de-acero',
  name: 'Guerrero de Acero',
  imageUrl: 'https://assets.example.test/guerrero.png',
  description: 'Héroe ofensivo del catálogo.',
  type: 'HEROE',
  attributes: {
    schemaVersion: '1',
    values: {
      kind: 'HEROE',
      heroSubtype: 'GUERRERO_ARMAS',
      basePower: 3,
      baseHealth: 12,
      baseDefense: 4,
      baseAttack: { mode: 'FIXED', amount: 3 },
      baseDamage: { mode: 'DICE', count: 2, sides: 6 },
      abilities: ABILITY_IDS,
    },
  },
  printRun: 1,
  creditsPrice: 0,
  premium: false,
})

describe('CreateCanonicalProduct', () => {
  it('crea una proyeccion canónica activa y guarda el agregado', async () => {
    const harness = buildHarness()

    const result = await harness.useCase.execute(heroCommand(), undefined, TRACE)

    expect(result).toMatchObject({
      productId: PRODUCT_ID,
      sku: 'guerrero-de-acero',
      name: 'Guerrero de Acero',
      type: ProductType.Hero,
      lifecycleStatus: LifecycleStatus.Active,
      printRun: 1,
      printRunMode: PrintRunMode.Unique,
      creditsPrice: 0,
      premium: false,
      realMoneyPrice: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
    expect(result.attributes.values).toMatchObject({ kind: ProductType.Hero })
    expect(harness.products.created).toHaveLength(1)
    expect(harness.generate).toHaveBeenCalledTimes(2)
  })

  it('normaliza nombre para la consulta de unicidad por tipo', async () => {
    const harness = buildHarness()

    await harness.useCase.execute(
      { ...heroCommand(), name: '  GUERRERO   de Acero  ' },
      undefined,
      TRACE,
    )

    expect(harness.products.checkedName).toBe('guerrero de acero')
    expect(harness.products.checkedType).toBe(ProductType.Hero)
  })

  it('genera SKU legible y único cuando el alias temporal se omite', async () => {
    const harness = buildHarness()
    const command = heroCommand() as Record<string, unknown>
    delete command.sku

    await expect(harness.useCase.execute(command, undefined, TRACE)).resolves.toMatchObject({
      productId: PRODUCT_ID,
      sku: 'guerrero-de-acero-aaaaaaaa',
    })
  })

  it('rechaza nombre y tipo duplicados sin invocar escritura ni generar identidad', async () => {
    const harness = buildHarness()
    harness.products.duplicate = true

    await expect(harness.useCase.execute(heroCommand(), undefined, TRACE)).rejects.toBeInstanceOf(
      CanonicalProductAlreadyExistsError,
    )
    expect(harness.products.created).toHaveLength(0)
    expect(harness.generate).not.toHaveBeenCalled()
  })

  it('rechaza un subtipo ausente del registro sin escribir', async () => {
    const harness = buildHarness()
    const command = heroCommand() as { attributes: { values: { heroSubtype: string } } }
    command.attributes.values.heroSubtype = 'MASTER'

    await expect(harness.useCase.execute(command, undefined, TRACE)).rejects.toBeInstanceOf(
      InvalidHeroSubtypeError,
    )
    expect(harness.products.created).toHaveLength(0)
  })

  it('rechaza una rama de estadisticas incompatible con el subtipo', async () => {
    const harness = buildHarness()
    const command = heroCommand() as {
      attributes: { values: Record<string, unknown> }
    }
    command.attributes.values.heroSubtype = 'CHAMAN'

    await expect(harness.useCase.execute(command, undefined, TRACE)).rejects.toBeInstanceOf(
      HeroSubtypeBranchMismatchError,
    )
  })

  it('rechaza una referencia que no corresponde a HABILIDAD', async () => {
    const harness = buildHarness()
    harness.references.types.set(ABILITY_IDS[1], ProductType.Weapon)

    await expect(harness.useCase.execute(heroCommand(), undefined, TRACE)).rejects.toBeInstanceOf(
      InvalidAbilityReferenceError,
    )
    expect(harness.products.created).toHaveLength(0)
  })

  it('crea un producto premium con importe real positivo', async () => {
    const harness = buildHarness()
    const result = await harness.useCase.execute(
      {
        ...heroCommand(),
        sku: 'guerrero-premium',
        premium: true,
        realMoneyPrice: { amount: 999, currency: 'USD' },
        printRun: -1,
      },
      undefined,
      TRACE,
    )

    expect(result).toMatchObject({
      premium: true,
      realMoneyPrice: { amount: 999, currency: 'USD' },
      printRunMode: PrintRunMode.Infinite,
    })
  })

  it('acepta la rama sanadora cuando corresponde al registro funcional', async () => {
    const harness = buildHarness()
    const command = heroCommand() as {
      attributes: { values: Record<string, unknown> }
    }
    command.attributes.values.heroSubtype = 'CHAMAN'
    delete command.attributes.values.baseAttack
    delete command.attributes.values.baseDamage
    command.attributes.values.baseHealing = { mode: 'FIXED', amount: 5 }

    await expect(harness.useCase.execute(command, undefined, TRACE)).resolves.toMatchObject({
      attributes: { values: { kind: ProductType.Hero, heroSubtype: 'CHAMAN' } },
    })
  })

  it.each([
    ['campo raiz desconocido', { ...heroCommand(), unexpected: true }],
    ['descripcion vacia', { ...heroCommand(), description: '   ' }],
    ['URI invalida', { ...heroCommand(), imageUrl: 'no-es-uri' }],
    ['tiraje invalido', { ...heroCommand(), printRun: 0 }],
    ['premium sin precio', { ...heroCommand(), premium: true }],
    [
      'no premium con precio real',
      { ...heroCommand(), realMoneyPrice: { amount: 10, currency: 'USD' } },
    ],
  ])('rechaza %s sin escribir', async (_case, command) => {
    const harness = buildHarness()

    await expect(harness.useCase.execute(command, undefined, TRACE)).rejects.toBeInstanceOf(
      DomainError,
    )
    expect(harness.products.created).toHaveLength(0)
  })

  it('ejecuta producto, auditoria y outbox de forma atomica con el mismo eventId', async () => {
    const products = new ProductWriterFake()
    const subtypes = new HeroSubtypeRegistryFake()
    const references = new ProductReferencesFake()
    const auditEntries: ProductAuditEntry[] = []
    const outboxEntries: OutboxEntry[] = []
    let executedTx = 0

    const useCase = new CreateCanonicalProduct({
      products,
      heroSubtypes: subtypes,
      productReferences: references,
      idGenerator: {
        generate: jest.fn().mockReturnValueOnce(PRODUCT_ID).mockReturnValueOnce('event-123'),
      },
      clock: { now: () => NOW },
      unitOfWork: {
        executeTransaction: async (work) => {
          executedTx += 1
          return work({ session: 'fake-session' })
        },
      },
      audit: {
        record: (entry) => {
          auditEntries.push(entry)
          return Promise.resolve()
        },
      },
      outbox: {
        record: (entry) => {
          outboxEntries.push(entry)
          return Promise.resolve()
        },
        claim: () => Promise.resolve([]),
        complete: () => Promise.resolve(),
        fail: () => Promise.resolve(),
      },
    })

    const actor = { subject: 'admin-user-1', email: 'admin@example.test', role: 'ADMINISTRATOR' }
    const trace: RequestTraceContext = { correlationId: 'req-create-1' }
    const result = await useCase.execute(heroCommand(), actor, trace)

    expect(result.version).toBe(0)
    expect(executedTx).toBe(1)
    expect(products.created).toHaveLength(1)
    expect(products.created[0]?.version).toBe(0)

    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0]).toMatchObject({
      eventId: 'event-123',
      aggregateId: PRODUCT_ID,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_CREATED',
      actor,
      timestamp: NOW,
    })

    expect(outboxEntries).toHaveLength(1)
    expect(outboxEntries[0]).toMatchObject({
      eventId: 'event-123',
      aggregateId: PRODUCT_ID,
      aggregateType: 'CanonicalProduct',
      eventType: 'catalog.product.created',
      eventVersion: 1,
      status: 'PENDING',
      attempts: 0,
      correlationId: 'req-create-1',
    })
    expect(outboxEntries[0]?.payload).toMatchObject({ productId: PRODUCT_ID, version: 0 })
  })

  it('un fallo en la unidad de trabajo aborta y no persiste nada', async () => {
    const products = new ProductWriterFake()
    const subtypes = new HeroSubtypeRegistryFake()
    const references = new ProductReferencesFake()

    const useCase = new CreateCanonicalProduct({
      products,
      heroSubtypes: subtypes,
      productReferences: references,
      idGenerator: { generate: () => PRODUCT_ID },
      clock: { now: () => NOW },
      unitOfWork: {
        executeTransaction: () => Promise.reject(new Error('Fallo forzado en transaccion')),
      },
    })

    await expect(useCase.execute(heroCommand(), undefined, TRACE)).rejects.toThrow(
      'Fallo forzado en transaccion',
    )
  })

  // HU-30 (correccion post-incidente): ARMA/ARMADURA/ITEM nuevos deben declarar
  // su tasa de caida Versus DESDE que nacen. HEROE/HABILIDAD/EPICA no se tocan
  // (seccion 15 del fix): su creacion sigue exactamente igual.
  describe('HU-30: tasa de caida Versus obligatoria al crear equipables', () => {
    const weaponCommand = (overrides: Record<string, unknown> = {}): object => ({
      sku: 'hacha-de-prueba',
      name: 'Hacha de Prueba',
      imageUrl: 'https://assets.example.test/hacha.png',
      description: 'Arma de prueba para HU-30.',
      type: 'ARMA',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'ARMA',
          compatibilityScope: 'ALL_HEROES',
          effects: [
            { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 2 } },
          ],
          ...overrides,
        },
      },
      printRun: 1,
      creditsPrice: 0,
      premium: false,
    })

    const armorCommand = (overrides: Record<string, unknown> = {}): object => ({
      sku: 'coraza-de-prueba',
      name: 'Coraza de Prueba',
      imageUrl: 'https://assets.example.test/coraza.png',
      description: 'Armadura de prueba para HU-30.',
      type: 'ARMADURA',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'ARMADURA',
          compatibilityScope: 'ALL_HEROES',
          slot: 'CHEST',
          effects: [
            {
              kind: 'STAT_MODIFIER',
              target: 'SELF',
              statistic: 'DEFENSE',
              operation: 'INCREASE',
              magnitude: { mode: 'FIXED', amount: 2 },
            },
          ],
          ...overrides,
        },
      },
      printRun: 1,
      creditsPrice: 0,
      premium: false,
    })

    const itemCommand = (overrides: Record<string, unknown> = {}): object => ({
      sku: 'pocion-de-prueba',
      name: 'Pocion de Prueba',
      imageUrl: 'https://assets.example.test/pocion.png',
      description: 'Item de prueba para HU-30.',
      type: 'ITEM',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'ITEM',
          compatibilityScope: 'ALL_HEROES',
          effects: [{ kind: 'HEALING', target: 'SELF', magnitude: { mode: 'FIXED', amount: 2 } }],
          ...overrides,
        },
      },
      printRun: 1,
      creditsPrice: 0,
      premium: false,
    })

    const abilityCommand = (): object => ({
      sku: 'habilidad-de-prueba',
      name: 'Habilidad de Prueba',
      imageUrl: 'https://assets.example.test/habilidad.png',
      description: 'Habilidad de prueba, ajena a HU-30.',
      type: 'HABILIDAD',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'HABILIDAD',
          compatibleHeroSubtypes: ['GUERRERO_ARMAS'],
          powerCostMode: 'FIXED',
          powerCost: 2,
          effects: [
            { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 3 } },
          ],
        },
      },
      printRun: 1,
      creditsPrice: 0,
      premium: false,
    })

    const epicCommand = (): object => ({
      sku: 'epica-de-prueba',
      name: 'Epica de Prueba',
      imageUrl: 'https://assets.example.test/epica.png',
      description: 'Epica de prueba, ajena a HU-30.',
      type: 'EPICA',
      attributes: {
        schemaVersion: '1',
        values: {
          kind: 'EPICA',
          compatibleHeroSubtype: 'GUERRERO_ARMAS',
          specificEffects: [
            { kind: 'DAMAGE', target: 'OPPONENT', magnitude: { mode: 'FIXED', amount: 4 } },
          ],
        },
      },
      printRun: 1,
      creditsPrice: 0,
      premium: false,
    })

    it('CAT-01: crea un ARMA con dropChanceBasisPoints=300', async () => {
      const harness = buildHarness()

      const result = await harness.useCase.execute(
        weaponCommand({ dropChanceBasisPoints: 300 }),
        undefined,
        TRACE,
      )

      expect(result.attributes.values).toMatchObject({ dropChanceBasisPoints: 300 })
    })

    it('CAT-02: crea una ARMADURA con dropChanceBasisPoints=0 (explicito, valido)', async () => {
      const harness = buildHarness()

      const result = await harness.useCase.execute(
        armorCommand({ dropChanceBasisPoints: 0 }),
        undefined,
        TRACE,
      )

      expect(result.attributes.values).toMatchObject({ dropChanceBasisPoints: 0 })
    })

    it('CAT-03: crea un ITEM con dropChanceBasisPoints=10000 (100%)', async () => {
      const harness = buildHarness()

      const result = await harness.useCase.execute(
        itemCommand({ dropChanceBasisPoints: 10_000 }),
        undefined,
        TRACE,
      )

      expect(result.attributes.values).toMatchObject({ dropChanceBasisPoints: 10_000 })
    })

    it('CAT-04: rechaza un ARMA sin dropChanceBasisPoints', async () => {
      const harness = buildHarness()

      await expect(harness.useCase.execute(weaponCommand(), undefined, TRACE)).rejects.toThrow(
        DomainError,
      )
      expect(harness.products.created).toHaveLength(0)
    })

    it('CAT-05: rechaza una ARMADURA con dropChanceBasisPoints=-1', async () => {
      const harness = buildHarness()

      await expect(
        harness.useCase.execute(armorCommand({ dropChanceBasisPoints: -1 }), undefined, TRACE),
      ).rejects.toThrow(DomainError)
      expect(harness.products.created).toHaveLength(0)
    })

    it('CAT-06: rechaza un ITEM con dropChanceBasisPoints=10001', async () => {
      const harness = buildHarness()

      await expect(
        harness.useCase.execute(itemCommand({ dropChanceBasisPoints: 10_001 }), undefined, TRACE),
      ).rejects.toThrow(DomainError)
      expect(harness.products.created).toHaveLength(0)
    })

    it('CAT-07: crea un HEROE sin dropChanceBasisPoints (no aplica, permitido)', async () => {
      const harness = buildHarness()

      await expect(harness.useCase.execute(heroCommand(), undefined, TRACE)).resolves.toBeDefined()
      expect(harness.products.created).toHaveLength(1)
    })

    it('CAT-08: crea una HABILIDAD sin dropChanceBasisPoints (no aplica, permitido)', async () => {
      const harness = buildHarness()

      await expect(
        harness.useCase.execute(abilityCommand(), undefined, TRACE),
      ).resolves.toBeDefined()
      expect(harness.products.created).toHaveLength(1)
    })

    it('CAT-09: crea una EPICA sin dropChanceBasisPoints (no aplica, permitido)', async () => {
      const harness = buildHarness()

      await expect(harness.useCase.execute(epicCommand(), undefined, TRACE)).resolves.toBeDefined()
      expect(harness.products.created).toHaveLength(1)
    })
  })
})

describe('HeroSubtypeRegistryV1', () => {
  it('proyecta los ocho subtipos aprobados y excluye MASTER', async () => {
    const registry = new HeroSubtypeRegistryV1()
    const approved = [
      'GUERRERO_TANQUE',
      'GUERRERO_ARMAS',
      'MAGO_FUEGO',
      'MAGO_HIELO',
      'PICARO_VENENO',
      'PICARO_MACHETE',
      'CHAMAN',
      'MEDICO',
    ]

    await expect(
      Promise.all(approved.map((code) => registry.findByCode(code))),
    ).resolves.not.toContain(null)
    await expect(registry.findByCode('MASTER')).resolves.toBeNull()
    await expect(registry.findByCode('MEDICO')).resolves.toMatchObject({
      combatBranch: HeroCombatBranch.Healing,
    })
  })
})
