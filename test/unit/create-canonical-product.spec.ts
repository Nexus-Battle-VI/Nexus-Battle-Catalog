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
import { HeroSubtypeRegistryV1 } from '../../src/adapters/outbound/registry/HeroSubtypeRegistryV1'

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

    const result = await harness.useCase.execute(heroCommand())

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

    await harness.useCase.execute({ ...heroCommand(), name: '  GUERRERO   de Acero  ' })

    expect(harness.products.checkedName).toBe('guerrero de acero')
    expect(harness.products.checkedType).toBe(ProductType.Hero)
  })

  it('genera SKU legible y único cuando el alias temporal se omite', async () => {
    const harness = buildHarness()
    const command = heroCommand() as Record<string, unknown>
    delete command.sku

    await expect(harness.useCase.execute(command)).resolves.toMatchObject({
      productId: PRODUCT_ID,
      sku: 'guerrero-de-acero-aaaaaaaa',
    })
  })

  it('rechaza nombre y tipo duplicados sin invocar escritura ni generar identidad', async () => {
    const harness = buildHarness()
    harness.products.duplicate = true

    await expect(harness.useCase.execute(heroCommand())).rejects.toBeInstanceOf(
      CanonicalProductAlreadyExistsError,
    )
    expect(harness.products.created).toHaveLength(0)
    expect(harness.generate).not.toHaveBeenCalled()
  })

  it('rechaza un subtipo ausente del registro sin escribir', async () => {
    const harness = buildHarness()
    const command = heroCommand() as { attributes: { values: { heroSubtype: string } } }
    command.attributes.values.heroSubtype = 'MASTER'

    await expect(harness.useCase.execute(command)).rejects.toBeInstanceOf(InvalidHeroSubtypeError)
    expect(harness.products.created).toHaveLength(0)
  })

  it('rechaza una rama de estadisticas incompatible con el subtipo', async () => {
    const harness = buildHarness()
    const command = heroCommand() as {
      attributes: { values: Record<string, unknown> }
    }
    command.attributes.values.heroSubtype = 'CHAMAN'

    await expect(harness.useCase.execute(command)).rejects.toBeInstanceOf(
      HeroSubtypeBranchMismatchError,
    )
  })

  it('rechaza una referencia que no corresponde a HABILIDAD', async () => {
    const harness = buildHarness()
    harness.references.types.set(ABILITY_IDS[1], ProductType.Weapon)

    await expect(harness.useCase.execute(heroCommand())).rejects.toBeInstanceOf(
      InvalidAbilityReferenceError,
    )
    expect(harness.products.created).toHaveLength(0)
  })

  it('crea un producto premium con importe real positivo', async () => {
    const harness = buildHarness()
    const result = await harness.useCase.execute({
      ...heroCommand(),
      sku: 'guerrero-premium',
      premium: true,
      realMoneyPrice: { amount: 999, currency: 'USD' },
      printRun: -1,
    })

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

    await expect(harness.useCase.execute(command)).resolves.toMatchObject({
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

    await expect(harness.useCase.execute(command)).rejects.toBeInstanceOf(DomainError)
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
    const result = await useCase.execute(heroCommand(), actor)

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

    await expect(useCase.execute(heroCommand())).rejects.toThrow('Fallo forzado en transaccion')
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
