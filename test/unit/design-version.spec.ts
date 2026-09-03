import { DesignVersion, DesignVersionStatus } from '../../src/domain/entities/DesignVersion'
import { DomainError } from '../../src/domain/errors/DomainError'
import {
  GraphicResource,
  GraphicResourceType,
} from '../../src/domain/value-objects/GraphicResource'
import {
  toDesignVersionDto,
  toExportableDesignTemplateDto,
} from '../../src/application/dto/DesignVersionDto'
import { ProductType } from '../../src/domain/value-objects/canonical-product-values'

const PRODUCT_ID = 'f293ce6b-98e9-41da-99ef-0ad4e3a95120'
const VERSION_ID = '5f2a1c9d-7b3e-4a11-9c5d-2e8f0a6b4c37'
const RESTORED_VERSION_ID = '6b3f2d8e-9c4a-4db6-8d62-3efbd5c39021'
const NOW = new Date('2026-09-03T12:00:00.000Z')
const ASSET_ID = '7d0e3f1a-21b4-4e5f-9c90-7d6a3b2c1e0f'

const primaryImage = () => ({
  type: GraphicResourceType.PrimaryImage,
  assetId: ASSET_ID,
  reference: `https://catalog.example.test/api/v1/catalog/product-assets/${ASSET_ID}/content`,
  contentType: 'image/webp',
  contentLength: 5 * 1024 * 1024,
})

describe('GraphicResource', () => {
  it.each([
    [GraphicResourceType.PrimaryImage, 'image/jpeg'],
    [GraphicResourceType.PrimaryImage, 'image/png'],
    [GraphicResourceType.Icon, 'image/webp'],
    [GraphicResourceType.Animation, 'image/gif'],
    [GraphicResourceType.Animation, 'image/png'],
  ])('acepta %s con formato %s admitido', (type, contentType) => {
    expect(
      GraphicResource.create({
        ...primaryImage(),
        type,
        contentType,
      }),
    ).toBeInstanceOf(GraphicResource)
  })

  it.each([
    [GraphicResourceType.PrimaryImage, 'image/gif'],
    [GraphicResourceType.Icon, 'image/bmp'],
    [GraphicResourceType.Animation, 'image/jpeg'],
  ])('rechaza %s con formato %s no admitido', (type, contentType) => {
    expect(() => GraphicResource.create({ ...primaryImage(), type, contentType })).toThrow(
      DomainError,
    )
  })

  it('rechaza un tamaño por encima del límite de la política', () => {
    expect(() => {
      GraphicResource.create({ ...primaryImage(), contentLength: 5 * 1024 * 1024 + 1 })
    }).toThrow(/supera el máximo/i)
  })

  it('exige la referencia canónica que entrega HU-37.7', () => {
    expect(() => {
      GraphicResource.create({ ...primaryImage(), reference: 'https://bucket.example.test/object' })
    }).toThrow(/URL canónica/i)
  })

  it('es inmutable en tiempo de ejecución', () => {
    const resource = GraphicResource.create(primaryImage())

    expect(Object.isFrozen(resource)).toBe(true)
  })
})

describe('DesignVersion', () => {
  it('distingue un borrador de una versión aplicada', () => {
    const draft = DesignVersion.createDraft({
      designVersionId: VERSION_ID,
      productId: PRODUCT_ID,
      resources: [primaryImage()],
      authorId: 'admin-42',
      createdAt: NOW,
    })
    const applied = DesignVersion.createApplied({
      designVersionId: VERSION_ID,
      productId: PRODUCT_ID,
      resources: [primaryImage()],
      authorId: 'admin-42',
      createdAt: NOW,
      versionNumber: 2,
      appliedAt: NOW,
      restoredFromVersionId: RESTORED_VERSION_ID,
    })

    expect(draft.isDraft()).toBe(true)
    expect(draft.versionNumber).toBeUndefined()
    expect(applied.isApplied()).toBe(true)
    expect(applied.status).toBe(DesignVersionStatus.Applied)
    expect(applied.versionNumber).toBe(2)
  })

  it('rechaza datos de historial dentro de un borrador', () => {
    expect(() =>
      DesignVersion.fromSnapshot({
        designVersionId: VERSION_ID,
        productId: PRODUCT_ID,
        status: DesignVersionStatus.Draft,
        resources: [primaryImage()],
        authorId: 'admin-42',
        createdAt: NOW,
        versionNumber: 1,
      }),
    ).toThrow(/borrador/i)
  })

  it('protege fechas y recursos de una versión aplicada contra mutaciones externas', () => {
    const version = DesignVersion.createApplied({
      designVersionId: VERSION_ID,
      productId: PRODUCT_ID,
      resources: [primaryImage()],
      authorId: 'admin-42',
      createdAt: NOW,
      versionNumber: 1,
      appliedAt: NOW,
    })
    const leakedDate = version.appliedAt as Date
    leakedDate.setFullYear(2030)

    expect(Object.isFrozen(version)).toBe(true)
    expect(Object.isFrozen(version.resources)).toBe(true)
    expect(version.appliedAt).toEqual(NOW)
  })

  it('rechaza una aplicación anterior a la creación y un rollback sobre sí misma', () => {
    expect(() =>
      DesignVersion.createApplied({
        designVersionId: VERSION_ID,
        productId: PRODUCT_ID,
        resources: [primaryImage()],
        authorId: 'admin-42',
        createdAt: NOW,
        versionNumber: 1,
        appliedAt: new Date('2026-09-03T11:59:59.999Z'),
      }),
    ).toThrow(/anterior/i)

    expect(() =>
      DesignVersion.createApplied({
        designVersionId: VERSION_ID,
        productId: PRODUCT_ID,
        resources: [primaryImage()],
        authorId: 'admin-42',
        createdAt: NOW,
        versionNumber: 1,
        appliedAt: NOW,
        restoredFromVersionId: VERSION_ID,
      }),
    ).toThrow(/sí misma/i)
  })

  it('exporta una plantilla sin identidad del producto de origen', () => {
    const version = DesignVersion.createApplied({
      designVersionId: VERSION_ID,
      productId: PRODUCT_ID,
      resources: [primaryImage()],
      authorId: 'admin-42',
      createdAt: NOW,
      versionNumber: 1,
      appliedAt: NOW,
    })

    const template = toExportableDesignTemplateDto(version, ProductType.Hero)

    expect(template).toEqual({
      schemaVersion: '1',
      applicableProductType: ProductType.Hero,
      resources: [primaryImage()],
      visualReference: undefined,
    })
    expect(template).not.toHaveProperty('productId')
    expect(toDesignVersionDto(version).productId).toBe(PRODUCT_ID)
  })
})
