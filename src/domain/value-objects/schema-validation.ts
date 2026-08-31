import { DomainError } from '../errors/DomainError'

export type UnknownObject = Readonly<Record<string, unknown>>

export const asStrictObject = (
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): UnknownObject => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError(`${path} debe ser un objeto.`)
  }

  const record = value as Record<string, unknown>
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.includes(key))

  if (unknownKey !== undefined) {
    throw new DomainError(`${path}.${unknownKey} no es una propiedad admitida.`)
  }

  return record
}

export const requiredValue = (record: UnknownObject, key: string, path: string): unknown => {
  if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) {
    throw new DomainError(`${path}.${key} es obligatorio.`)
  }

  return record[key]
}

export const optionalValue = (record: UnknownObject, key: string): unknown =>
  Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined

export const parseString = (
  value: unknown,
  path: string,
  options: { minLength?: number; maxLength?: number; pattern?: RegExp } = {},
): string => {
  if (typeof value !== 'string') {
    throw new DomainError(`${path} debe ser texto.`)
  }

  const normalized = value.trim()
  const minLength = options.minLength ?? 0

  if (normalized.length < minLength) {
    throw new DomainError(`${path} debe tener al menos ${String(minLength)} caracteres.`)
  }

  if (options.maxLength !== undefined && normalized.length > options.maxLength) {
    throw new DomainError(`${path} debe tener como maximo ${String(options.maxLength)} caracteres.`)
  }

  if (options.pattern !== undefined && !options.pattern.test(normalized)) {
    throw new DomainError(`${path} tiene un formato invalido.`)
  }

  return normalized
}

export const parseInteger = (
  value: unknown,
  path: string,
  options: { minimum?: number; maximum?: number } = {},
): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new DomainError(`${path} debe ser un entero.`)
  }

  if (options.minimum !== undefined && value < options.minimum) {
    throw new DomainError(`${path} debe ser mayor o igual a ${String(options.minimum)}.`)
  }

  if (options.maximum !== undefined && value > options.maximum) {
    throw new DomainError(`${path} debe ser menor o igual a ${String(options.maximum)}.`)
  }

  return value
}

export const parseBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new DomainError(`${path} debe ser booleano.`)
  }

  return value
}

export const parseEnum = <T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new DomainError(`${path} debe ser uno de: ${allowed.join(', ')}.`)
  }

  return value as T
}

export const parseArray = (value: unknown, path: string, minimum = 0): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw new DomainError(`${path} debe ser una lista.`)
  }

  if (value.length < minimum) {
    throw new DomainError(`${path} debe contener al menos ${String(minimum)} elemento(s).`)
  }

  return value
}

export const assertUnique = (values: readonly string[], path: string): void => {
  if (new Set(values).size !== values.length) {
    throw new DomainError(`${path} no admite valores duplicados.`)
  }
}
