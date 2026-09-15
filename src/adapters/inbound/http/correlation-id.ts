import { randomUUID } from 'node:crypto'

const MIN_LENGTH = 1
const MAX_LENGTH = 128

/**
 * Resuelve el `correlationId` de una solicitud entrante (HU-38, ADR-017:
 * trazabilidad de la solicitud original que exige el envelope externo).
 *
 * Si `x-correlation-id` trae un valor valido (1..128 tras recortar espacios),
 * se preserva exactamente. En cualquier otro caso -ausente, vacio, solo
 * espacios, o mayor a 128 caracteres- se genera uno propio para esa
 * solicitud: una cabecera de tracing invalida no debe romper una operacion
 * funcional, y NUNCA se trunca en silencio un valor externo fuera de rango.
 *
 * Un array (Express puede repetir la cabecera) usa solo el primer valor.
 */
export const resolveCorrelationId = (raw: string | readonly string[] | undefined): string => {
  const candidate: string | undefined = typeof raw === 'string' ? raw : raw?.[0]
  const trimmed = typeof candidate === 'string' ? candidate.trim() : ''

  if (trimmed.length >= MIN_LENGTH && trimmed.length <= MAX_LENGTH) {
    return trimmed
  }

  return randomUUID()
}
