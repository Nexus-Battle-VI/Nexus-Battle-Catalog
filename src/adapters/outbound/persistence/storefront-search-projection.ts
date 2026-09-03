import { Long, type Document, type Filter } from 'mongodb'
import type { CanonicalProductSnapshot } from '../../../domain/entities/CanonicalProduct'
import {
  normalizeStorefrontText,
  storefrontSearchText,
} from '../../../domain/services/storefront-search'
import {
  STOREFRONT_PAGE_SIZE,
  type CatalogStorefrontQuery,
} from '../../../application/ports/CatalogStorefrontPort'
import type { CanonicalProductDocument } from './canonical-mapping'

export const STOREFRONT_SEARCH_INDEX = 'idx_products_storefront_search_v1'
export const STOREFRONT_ORDER_INDEX = 'idx_products_storefront_order'
// Bounded index footprint, not a domain/query limit. Hash collisions only admit
// extra candidates; Mongo's literal post-filter always decides the result.
export const SEARCH_BUCKETS = 4096

const bucket = (text: string): number => {
  let hash = 2166136261
  for (let n = 0; n < text.length; n++) {
    hash = Math.imul(hash ^ text.charCodeAt(n), 16777619)
  }
  return (hash >>> 0) % SEARCH_BUCKETS
}

const grams = (text: string, widths: readonly number[]): number[] => {
  const tokens = new Set<number>()
  for (const width of widths) {
    for (let start = 0; start + width <= text.length; start++) {
      tokens.add(bucket(text.slice(start, start + width)))
    }
  }
  return [...tokens].sort((a, b) => a - b)
}

/** Versioned V1 projection; changing normalization/buckets requires a new migration. */
export const storefrontProjection = (
  product: CanonicalProductSnapshot,
): {
  readonly storefrontSearchText: string
  readonly storefrontSearchTokens: number[]
} => {
  const text = storefrontSearchText(product)
  return { storefrontSearchText: text, storefrontSearchTokens: grams(text, [1, 2, 3]) }
}

export const storefrontMongoQuery = (
  query: CatalogStorefrontQuery,
): {
  readonly pipeline: Document[]
  readonly hint: string
} => {
  const text = normalizeStorefrontText(query.query?.trim() ?? '')
  const filter: Filter<CanonicalProductDocument> = {
    lifecycleStatus: 'ACTIVE',
    type: query.type ?? { $exists: true },
  }
  if (query.currency !== undefined) filter['realMoneyPrice.currency'] = query.currency
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    filter['realMoneyPrice.amount'] = {
      ...(query.minPrice === undefined ? {} : { $gte: Long.fromNumber(query.minPrice) }),
      ...(query.maxPrice === undefined ? {} : { $lte: Long.fromNumber(query.maxPrice) }),
    }
  }
  return {
    hint: text === '' ? STOREFRONT_ORDER_INDEX : STOREFRONT_SEARCH_INDEX,
    pipeline: [
      {
        $match: {
          ...filter,
          ...(text === ''
            ? {}
            : { storefrontSearchTokens: { $all: grams(text, [Math.min(3, text.length)]) } }),
        },
      },
      ...(text === ''
        ? []
        : [
            {
              $match: {
                $expr: { $gte: [{ $indexOfCP: ['$storefrontSearchText', { $literal: text }] }, 0] },
              },
            },
          ]),
      { $sort: { normalizedName: 1, _id: 1 } },
      { $project: { storefrontSearchText: 0, storefrontSearchTokens: 0 } },
      {
        $facet: {
          items: [
            { $skip: (query.page - 1) * STOREFRONT_PAGE_SIZE },
            { $limit: STOREFRONT_PAGE_SIZE },
          ],
          count: [{ $count: 'total' }],
        },
      },
    ],
  }
}
