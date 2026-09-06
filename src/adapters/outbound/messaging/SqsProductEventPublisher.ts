import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'

import {
  ProductEventDestination,
  type ProductEventEnvelope,
  type ProductEventPublisherPort,
} from '../../../application/ports/ProductEventPublisherPort'

export interface SqsProductEventPublisherOptions {
  readonly region: string
  readonly eventsQueueUrl: string
  readonly lifecycleQueueUrl: string
}

/**
 * Unico adaptador que conoce el SDK de AWS para este transporte (HU-38,
 * seccion 10/11). Las credenciales las resuelve la cadena de proveedores por
 * defecto del SDK (rol de instancia/tarea); nunca claves estaticas.
 */
export class SqsProductEventPublisher implements ProductEventPublisherPort {
  private readonly client: SQSClient
  private readonly queueUrlByDestination: Readonly<Record<ProductEventDestination, string>>

  constructor(options: SqsProductEventPublisherOptions) {
    this.client = new SQSClient({ region: options.region })
    this.queueUrlByDestination = {
      [ProductEventDestination.Created]: options.eventsQueueUrl,
      [ProductEventDestination.Lifecycle]: options.lifecycleQueueUrl,
    }
  }

  async publish(
    destination: ProductEventDestination,
    envelope: ProductEventEnvelope,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrlByDestination[destination],
        MessageBody: JSON.stringify(envelope),
      }),
    )
  }
}
