import { resolveCorrelationId } from '../../src/adapters/inbound/http/correlation-id'

/**
 * HU-38: resolucion de `x-correlation-id` en la entrada HTTP (ADR-017:
 * trazabilidad de la solicitud original que exige el envelope externo).
 */
describe('resolveCorrelationId', () => {
  it('preserva exactamente un valor valido', () => {
    expect(resolveCorrelationId('req-abc-123')).toBe('req-abc-123')
  })

  it('recorta espacios exteriores antes de validar y preservar', () => {
    expect(resolveCorrelationId('  req-con-espacios  ')).toBe('req-con-espacios')
  })

  it('genera un identificador propio cuando la cabecera esta ausente', () => {
    const generated = resolveCorrelationId(undefined)

    expect(generated.length).toBeGreaterThan(0)
    expect(generated.length).toBeLessThanOrEqual(128)
  })

  it('genera un identificador propio cuando la cabecera llega vacia', () => {
    const generated = resolveCorrelationId('')

    expect(generated.length).toBeGreaterThan(0)
    expect(generated.length).toBeLessThanOrEqual(128)
  })

  it('genera un identificador propio cuando la cabecera es solo espacios', () => {
    const generated = resolveCorrelationId('   ')

    expect(generated.length).toBeGreaterThan(0)
    expect(generated.length).toBeLessThanOrEqual(128)
  })

  it('genera un identificador propio cuando el valor externo supera 128 caracteres, sin truncarlo', () => {
    const demasiadoLargo = 'x'.repeat(300)
    const generated = resolveCorrelationId(demasiadoLargo)

    expect(generated).not.toBe(demasiadoLargo)
    expect(generated.length).toBeLessThanOrEqual(128)
  })

  it('acepta exactamente el limite de 128 caracteres', () => {
    const limite = 'x'.repeat(128)
    expect(resolveCorrelationId(limite)).toBe(limite)
  })

  it('acepta exactamente 1 caracter', () => {
    expect(resolveCorrelationId('a')).toBe('a')
  })

  it('usa el primer valor cuando la cabecera llega repetida como arreglo', () => {
    expect(resolveCorrelationId(['req-primero', 'req-segundo'])).toBe('req-primero')
  })

  it('genera uno propio si el primer valor del arreglo es invalido', () => {
    const generated = resolveCorrelationId(['', 'req-segundo'])

    expect(generated).not.toBe('')
    expect(generated.length).toBeGreaterThan(0)
  })

  it('dos llamadas sin cabecera generan identificadores distintos (no hay un valor fijo reutilizado)', () => {
    expect(resolveCorrelationId(undefined)).not.toBe(resolveCorrelationId(undefined))
  })
})
