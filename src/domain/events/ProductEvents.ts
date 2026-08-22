import type { DomainEvent } from './DomainEvent'

export interface ProductPublished extends DomainEvent {
  readonly name: 'catalog.product.published'
  readonly productName: string
  readonly category: string
  readonly priceAmount: number
  readonly priceCurrency: string
}

export interface ProductPriceChanged extends DomainEvent {
  readonly name: 'catalog.product.price-changed'
  readonly previousAmount: number
  readonly newAmount: number
  readonly currency: string
}

export interface ProductArchived extends DomainEvent {
  readonly name: 'catalog.product.archived'
}

export const productPublished = (params: {
  aggregateId: string
  name: string
  category: string
  priceAmount: number
  priceCurrency: string
  occurredAt: Date
}): ProductPublished => ({
  name: 'catalog.product.published',
  aggregateId: params.aggregateId,
  productName: params.name,
  category: params.category,
  priceAmount: params.priceAmount,
  priceCurrency: params.priceCurrency,
  occurredAt: params.occurredAt,
})

export const productPriceChanged = (params: {
  aggregateId: string
  previousAmount: number
  newAmount: number
  currency: string
  occurredAt: Date
}): ProductPriceChanged => ({
  name: 'catalog.product.price-changed',
  aggregateId: params.aggregateId,
  previousAmount: params.previousAmount,
  newAmount: params.newAmount,
  currency: params.currency,
  occurredAt: params.occurredAt,
})

export const productArchived = (params: {
  aggregateId: string
  occurredAt: Date
}): ProductArchived => ({
  name: 'catalog.product.archived',
  aggregateId: params.aggregateId,
  occurredAt: params.occurredAt,
})
