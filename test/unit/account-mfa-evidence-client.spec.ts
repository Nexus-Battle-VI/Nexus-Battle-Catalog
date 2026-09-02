import {
  AccountMfaEvidenceClient,
  EVIDENCE_PATH,
} from '../../src/adapters/outbound/identity/AccountMfaEvidenceClient'
import {
  MfaEvidenceOutcome,
  SecondFactorMethod,
} from '../../src/application/ports/MfaEvidenceVerifierPort'
import {
  INTERNAL_SERVICE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from '../../src/adapters/outbound/identity/internal-signature'

/** Secreto FICTICIO, exclusivo de estas pruebas. */
const SECRETO = 'secreto-de-pruebas-no-usado-en-ningun-entorno'
const BASE = 'http://account:3000'

const registros: { message: string; context?: Record<string, unknown> }[] = []

const logger = {
  info: (message: string, context?: Record<string, unknown>): void => {
    registros.push({ message, context })
  },
  warn: (message: string, context?: Record<string, unknown>): void => {
    registros.push({ message, context })
  },
}

const clienteCon = (fetchImpl: typeof fetch): AccountMfaEvidenceClient =>
  new AccountMfaEvidenceClient({
    baseUrl: BASE,
    secret: SECRETO,
    serviceName: 'catalog',
    timeoutMs: 50,
    logger,
    fetchImpl,
  })

const respuesta = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  registros.length = 0
})

describe('AccountMfaEvidenceClient', () => {
  it('traduce valid=true a evidencia valida', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta({ valid: true })))

    await expect(
      cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp),
    ).resolves.toBe(MfaEvidenceOutcome.Valid)
  })

  it('traduce valid=false a evidencia ausente', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta({ valid: false })))

    await expect(
      cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp),
    ).resolves.toBe(MfaEvidenceOutcome.Absent)
  })

  /**
   * La firma cubre servicio, metodo, ruta, sello y resumen del cuerpo. Sin esta
   * prueba, «el cliente firma» podria cumplirse enviando una cabecera constante.
   */
  it('firma la peticion de forma que Account pueda reproducirla', async () => {
    let enviado: { url: string; init: RequestInit } | null = null

    const cliente = clienteCon((url, init) => {
      enviado = { url: url as string, init: init ?? {} }

      return Promise.resolve(respuesta({ valid: true }))
    })

    await cliente.verify('sujeto-1', 'jti-1', SecondFactorMethod.AuthenticatorApp)

    const { url, init } = enviado!
    const headers = init.headers as Record<string, string>

    expect(url).toBe(`${BASE}${EVIDENCE_PATH}`)
    expect(headers[INTERNAL_SERVICE_HEADER]).toBe('catalog')

    const esperada = signInternalRequest(SECRETO, {
      service: 'catalog',
      method: 'POST',
      path: EVIDENCE_PATH,
      timestamp: headers[INTERNAL_TIMESTAMP_HEADER]!,
      body: {
        subject: 'sujeto-1',
        jti: 'jti-1',
        method: SecondFactorMethod.AuthenticatorApp,
      },
    })

    expect(headers[INTERNAL_SIGNATURE_HEADER]).toBe(esperada)
  })

  /**
   * FALLO CERRADO. Ninguna de estas situaciones puede convertirse en «adelante»,
   * y todas se distinguen de una denegacion: el sistema no pudo comprobarlo.
   */
  it.each([
    ['un error del servidor', (): Promise<Response> => Promise.resolve(respuesta({}, 503))],
    ['un rechazo de la firma', (): Promise<Response> => Promise.resolve(respuesta({}, 401))],
    ['un fallo de red', (): Promise<Response> => Promise.reject(new Error('ECONNREFUSED'))],
    [
      'una respuesta sin el campo esperado',
      (): Promise<Response> => Promise.resolve(respuesta({ otra: 'cosa' })),
    ],
    [
      'un valid que no es booleano',
      (): Promise<Response> => Promise.resolve(respuesta({ valid: 'false' })),
    ],
  ])('responde "no verificable" ante %s', async (_caso, impl: typeof fetch) => {
    const cliente = clienteCon(impl)

    await expect(
      cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp),
    ).resolves.toBe(MfaEvidenceOutcome.Unavailable)
  })

  /**
   * `"false"` en texto es veraz en JavaScript. Interpretarlo por conveniencia
   * autorizaria la operacion, que es justo el fallo que el caso anterior fija.
   */
  it('NO interpreta un valid textual como verdadero', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta({ valid: 'true' })))

    await expect(
      cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp),
    ).resolves.not.toBe(MfaEvidenceOutcome.Valid)
  })

  it('aborta cuando se agota el tiempo de espera', async () => {
    const cliente = clienteCon(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )

    await expect(
      cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp),
    ).resolves.toBe(MfaEvidenceOutcome.Unavailable)
  })

  it('NUNCA registra el secreto ni la firma completa', async () => {
    const cliente = clienteCon(() => Promise.resolve(respuesta({}, 503)))

    await cliente.verify('sujeto', 'jti', SecondFactorMethod.AuthenticatorApp)

    const volcado = JSON.stringify(registros)

    expect(volcado).not.toContain(SECRETO)
  })
})
