import { CanonicalProduct, normalizeProductName } from '../../domain/entities/CanonicalProduct'
import {
  CreditsPrice,
  PrintRun,
  ProductDescription,
  ProductId,
  ProductImageUrl,
  ProductPricing,
  ProductType,
  parseProductType,
} from '../../domain/value-objects/canonical-product-values'
import {
  parseProductAttributes,
  referencedAbilities,
  referencedHeroSubtypes,
  type ProductAttributes,
} from '../../domain/value-objects/product-attributes'
import { Money, ProductName, Sku } from '../../domain/value-objects/catalog-values'
import {
  asStrictObject,
  optionalValue,
  parseBoolean,
  parseInteger,
  parseString,
  requiredValue,
} from '../../domain/value-objects/schema-validation'
import { toCanonicalProductDto, type CanonicalProductDto } from '../dto/CanonicalProductDto'
import {
  CanonicalProductAlreadyExistsError,
  HeroSubtypeBranchMismatchError,
  InvalidAbilityReferenceError,
  InvalidHeroSubtypeError,
} from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import {
  HeroCombatBranch,
  type CanonicalProductWritePort,
  type HeroSubtypeDefinition,
  type HeroSubtypeRegistryPort,
  type ProductReferenceQueryPort,
} from '../ports/CanonicalProductPorts'
import { ProductIdFactory } from '../services/ProductIdFactory'

export interface CreateCanonicalProductDependencies {
  readonly products: CanonicalProductWritePort
  readonly heroSubtypes: HeroSubtypeRegistryPort
  readonly productReferences: ProductReferenceQueryPort
  readonly idGenerator: IdGeneratorPort
  readonly clock: ClockPort
}

interface ParsedCreateCommand {
  readonly sku: Sku
  readonly name: ProductName
  readonly imageUrl: ProductImageUrl
  readonly description: ProductDescription
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: PrintRun
  readonly pricing: ProductPricing
}

/** Caso de uso canónico; no conoce HTTP, NestJS, MongoDB ni transporte. */
export class CreateCanonicalProduct {
  constructor(private readonly deps: CreateCanonicalProductDependencies) {}

  async execute(rawCommand: unknown): Promise<CanonicalProductDto> {
    const command = parseCreateCommand(rawCommand)
    const normalizedName = normalizeProductName(command.name.value)

    if (await this.deps.products.existsByNormalizedNameAndType(normalizedName, command.type)) {
      throw new CanonicalProductAlreadyExistsError(command.name.value, command.type)
    }

    await this.validateReferences(command.attributes)

    const product = CanonicalProduct.create({
      productId: new ProductIdFactory(this.deps.idGenerator).create(),
      sku: command.sku,
      name: command.name,
      imageUrl: command.imageUrl,
      description: command.description,
      type: command.type,
      attributes: command.attributes,
      printRun: command.printRun,
      pricing: command.pricing,
      createdAt: this.deps.clock.now(),
    })

    await this.deps.products.create(product)
    return toCanonicalProductDto(product.toSnapshot())
  }

  private async validateReferences(attributes: ProductAttributes): Promise<void> {
    const subtypeCodes = [...new Set(referencedHeroSubtypes(attributes))]
    const definitions = await Promise.all(
      subtypeCodes.map(async (code) => ({
        code,
        definition: await this.deps.heroSubtypes.findByCode(code),
      })),
    )

    for (const { code, definition } of definitions) {
      if (definition === null) throw new InvalidHeroSubtypeError(code)
    }

    this.validateHeroBranch(attributes, definitions)

    for (const rawProductId of referencedAbilities(attributes)) {
      const productId = ProductId.create(rawProductId)
      const referencedType = await this.deps.productReferences.findTypeById(productId)

      if (referencedType !== ProductType.Ability) {
        throw new InvalidAbilityReferenceError(productId.value)
      }
    }
  }

  private validateHeroBranch(
    attributes: ProductAttributes,
    definitions: readonly {
      code: string
      definition: HeroSubtypeDefinition | null
    }[],
  ): void {
    if (attributes.values.kind !== ProductType.Hero) return

    const heroAttributes = attributes.values
    const definition = definitions.find(
      ({ code }) => code === heroAttributes.heroSubtype,
    )?.definition
    if (definition === null || definition === undefined) return

    const expectedBranch =
      heroAttributes.baseHealing === undefined
        ? HeroCombatBranch.Offensive
        : HeroCombatBranch.Healing

    if (definition.combatBranch !== expectedBranch) {
      throw new HeroSubtypeBranchMismatchError(definition.code, expectedBranch)
    }
  }
}

const parseCreateCommand = (raw: unknown): ParsedCreateCommand => {
  const path = 'command'
  const record = asStrictObject(raw, path, [
    'sku',
    'name',
    'imageUrl',
    'description',
    'type',
    'attributes',
    'printRun',
    'creditsPrice',
    'premium',
    'realMoneyPrice',
  ])
  const type = parseProductType(parseString(requiredValue(record, 'type', path), `${path}.type`))
  const premium = parseBoolean(requiredValue(record, 'premium', path), `${path}.premium`)
  const realMoneyPrice = parseRealMoneyPrice(optionalValue(record, 'realMoneyPrice'))

  return {
    sku: Sku.create(parseString(requiredValue(record, 'sku', path), `${path}.sku`)),
    name: ProductName.create(parseString(requiredValue(record, 'name', path), `${path}.name`)),
    imageUrl: ProductImageUrl.create(
      parseString(requiredValue(record, 'imageUrl', path), `${path}.imageUrl`),
    ),
    description: ProductDescription.create(
      parseString(requiredValue(record, 'description', path), `${path}.description`),
    ),
    type,
    attributes: parseProductAttributes(requiredValue(record, 'attributes', path), type),
    printRun: PrintRun.create(
      parseInteger(requiredValue(record, 'printRun', path), `${path}.printRun`),
    ),
    pricing: ProductPricing.create({
      creditsPrice: CreditsPrice.create(
        parseInteger(requiredValue(record, 'creditsPrice', path), `${path}.creditsPrice`),
      ),
      premium,
      realMoneyPrice,
    }),
  }
}

const parseRealMoneyPrice = (raw: unknown): Money | null => {
  if (raw === undefined || raw === null) return null

  const path = 'command.realMoneyPrice'
  const record = asStrictObject(raw, path, ['amount', 'currency'])

  return Money.create(
    parseInteger(requiredValue(record, 'amount', path), `${path}.amount`),
    parseString(requiredValue(record, 'currency', path), `${path}.currency`),
  )
}
