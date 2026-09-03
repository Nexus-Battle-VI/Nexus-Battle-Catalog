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

export const storefrontMatches = (product: CanonicalProductSnapshot, query?: string): boolean => {
  if (query === undefined || query.trim() === '') return true
  const text = searchableValues([
    product.sku,
    product.name,
    product.description,
    product.type,
    product.attributes,
    product.creditsPrice,
    product.realMoneyPrice,
  ])
    .normalize('NFKC')
    .toLocaleLowerCase('es')
  return text.includes(query.trim().normalize('NFKC').toLocaleLowerCase('es'))
}
