import type { CanonicalProductSnapshot } from '../entities/CanonicalProduct'

/** Literal search across public product information, including nested abilities/effects and prices. */
const searchableValues = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(searchableValues).join(' ')
  if (typeof value === 'object') return Object.values(value).map(searchableValues).join(' ')
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''
}

export const normalizeStorefrontText = (text: string): string =>
  text.normalize('NFKC').toLocaleLowerCase('es')

export const storefrontSearchText = (product: CanonicalProductSnapshot): string =>
  normalizeStorefrontText(
    searchableValues([
      product.sku,
      product.name,
      product.description,
      product.type,
      product.attributes,
      product.creditsPrice,
      product.realMoneyPrice,
    ]),
  )

export const storefrontMatches = (product: CanonicalProductSnapshot, query?: string): boolean => {
  if (query === undefined || query.trim() === '') return true
  return storefrontSearchText(product).includes(normalizeStorefrontText(query.trim()))
}
