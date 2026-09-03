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
  OutboxPayloadTooLargeError,
  ProductAssetInvalidContentError,
} from '../errors/ApplicationError'
import type { ClockPort } from '../ports/ClockPort'
import type { IdGeneratorPort } from '../ports/IdGeneratorPort'
import type { ProductAssetRepositoryPort } from '../ports/ProductAssetRepositoryPort'
import {
  HeroCombatBranch,
  OutboxStatus,
  type AuditActor,
  type CanonicalProductUnitOfWorkPort,
  type CanonicalProductWritePort,
  type HeroSubtypeDefinition,
  type HeroSubtypeRegistryPort,
  type OutboxEntry,
  type ProductAuditEntry,
  type ProductAuditPort,
  type ProductOutboxPort,
  type ProductReferenceQueryPort,
} from '../ports/CanonicalProductPorts'
import { ProductIdFactory } from '../services/ProductIdFactory'

export interface CreateCanonicalProductDependencies {
  readonly products: CanonicalProductWritePort
  readonly heroSubtypes: HeroSubtypeRegistryPort
  readonly productReferences: ProductReferenceQueryPort
  readonly idGenerator: IdGeneratorPort
  readonly clock: ClockPort
  readonly unitOfWork?: CanonicalProductUnitOfWorkPort
  readonly audit?: ProductAuditPort
  readonly outbox?: ProductOutboxPort
  readonly productAssets?: ProductAssetRepositoryPort
  readonly assetsEnforceStrict?: boolean
}

interface ParsedCreateCommand {
  readonly sku: Sku | undefined
  readonly name: ProductName
  readonly imageUrl: ProductImageUrl
  readonly description: ProductDescription
  readonly type: ProductType
  readonly attributes: ProductAttributes
  readonly printRun: PrintRun
  readonly pricing: ProductPricing
}

/** Caso de uso canónico; coordina persistencia, auditoría inmutable y outbox (ADR-015). */
export class CreateCanonicalProduct {
  constructor(private readonly deps: CreateCanonicalProductDependencies) {}

  async execute(rawCommand: unknown, actor?: AuditActor): Promise<CanonicalProductDto> {
    const command = parseCreateCommand(rawCommand)
    const normalizedName = normalizeProductName(command.name.value)

    if (await this.deps.products.existsByNormalizedNameAndType(normalizedName, command.type)) {
      throw new CanonicalProductAlreadyExistsError(command.name.value, command.type)
    }

    await this.validateReferences(command.attributes)
    const referencedAssetId = await this.validateImageAsset(command.imageUrl)

    const now = this.deps.clock.now()
    const productId = new ProductIdFactory(this.deps.idGenerator).create()
    const eventId = this.deps.idGenerator.generate()
    const product = CanonicalProduct.create({
      productId,
      sku: command.sku ?? generateCanonicalSku(command.name, productId),
      name: command.name,
      imageUrl: command.imageUrl,
      description: command.description,
      type: command.type,
      attributes: command.attributes,
      printRun: command.printRun,
      pricing: command.pricing,
      createdAt: now,
    })

    const snapshot = product.toSnapshot()
    const dto = toCanonicalProductDto(snapshot)

    const auditEntry: ProductAuditEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      action: 'PRODUCT_CREATED',
      actor: actor ?? { subject: 'anonymous' },
      timestamp: now,
      snapshot,
    }

    const payload = dto as unknown as Record<string, unknown>
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (payloadBytes > 256 * 1024) {
      throw new OutboxPayloadTooLargeError(payloadBytes)
    }

    const outboxEntry: OutboxEntry = {
      eventId,
      aggregateId: productId.value,
      aggregateType: 'CanonicalProduct',
      eventType: 'catalog.product.created',
      eventVersion: 1,
      status: OutboxStatus.Pending,
      payload,
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: null,
      attempts: 0,
      lastError: null,
      dispatchedAt: null,
      purgeAt: null,
    }

    if (this.deps.unitOfWork) {
      await this.deps.unitOfWork.executeTransaction(async (tx) => {
        await this.deps.products.create(product, tx)
        if (this.deps.audit) await this.deps.audit.record(auditEntry, tx)
        if (this.deps.outbox) await this.deps.outbox.record(outboxEntry, tx)
      })
    } else {
      await this.deps.products.create(product)
      if (this.deps.audit) await this.deps.audit.record(auditEntry)
      if (this.deps.outbox) await this.deps.outbox.record(outboxEntry)
    }

    if (referencedAssetId && this.deps.productAssets) {
      await this.deps.productAssets.associateProduct(referencedAssetId, productId.value)
    }

    return dto
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

  private async validateImageAsset(imageUrl: ProductImageUrl): Promise<string | null> {
    const assetRegex =
      /\/api\/v1\/catalog\/product-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/content/i
    const match = assetRegex.exec(imageUrl.value)

    if (match?.[1]) {
      const assetId = match[1]
      if (this.deps.productAssets) {
        const asset = await this.deps.productAssets.findById(assetId)
        if (!asset?.isReady()) {
          throw new ProductAssetInvalidContentError(
            `El recurso visual "${assetId}" referenciado en imageUrl no existe o no ha sido finalizado con exito.`,
          )
        }
      }
      return assetId
    }

    if (this.deps.assetsEnforceStrict) {
      throw new ProductAssetInvalidContentError(
        'Solo se admiten URLs de recursos visuales gestionados en /api/v1/catalog/product-assets/{assetId}/content.',
      )
    }

    return null
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
    sku: parseOptionalSku(optionalValue(record, 'sku')),
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

const parseOptionalSku = (raw: unknown): Sku | undefined =>
  raw === undefined ? undefined : Sku.create(parseString(raw, 'command.sku'))

/**
 * SKU es un alias transitorio, no la identidad del producto. Cuando el
 * administrador no lo informa, se obtiene una forma legible del nombre y un
 * sufijo derivado del productId que evita colisiones entre nombres equivalentes.
 */
export const generateCanonicalSku = (name: ProductName, productId: ProductId): Sku => {
  const slug = name.value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')

  return Sku.create(`${slug.length === 0 ? 'producto' : slug}-${productId.value.slice(0, 8)}`)
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
