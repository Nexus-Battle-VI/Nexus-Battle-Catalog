import { closeMongoTestResources } from '../support/mongo-test-resources'

describe('Limpieza de recursos MongoDB de prueba', () => {
  it('no falla cuando el setup termino antes de crear recursos', async () => {
    await expect(closeMongoTestResources({})).resolves.toBeUndefined()
  })

  it('libera el unico recurso que alcanzo a inicializarse', async () => {
    let clientClosed = false

    await expect(
      closeMongoTestResources({
        client: {
          close: (): Promise<void> => {
            clientClosed = true

            return Promise.resolve()
          },
        },
      }),
    ).resolves.toBeUndefined()

    expect(clientClosed).toBe(true)
  })

  it('intenta detener el contenedor aunque cerrar el cliente falle', async () => {
    let containerStopped = false

    await expect(
      closeMongoTestResources({
        client: {
          close: (): Promise<void> => Promise.reject(new Error('fallo al cerrar el cliente')),
        },
        container: {
          stop: (): Promise<void> => {
            containerStopped = true

            return Promise.resolve()
          },
        },
      }),
    ).rejects.toThrow('fallo al cerrar el cliente')

    expect(containerStopped).toBe(true)
  })
})
