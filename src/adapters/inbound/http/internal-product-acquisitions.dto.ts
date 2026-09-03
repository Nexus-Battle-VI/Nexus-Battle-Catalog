import { ApiProperty } from '@nestjs/swagger'
import { IsNotEmpty, IsString, IsUUID } from 'class-validator'

/**
 * Cuerpo de una adquisición interna (HU-34).
 *
 * `acquisitionId` LO PONE QUIEN LLAMA, y es lo que da idempotencia: un reintento
 * con el mismo identificador no resta una segunda unidad. Generarlo aqui
 * eliminaria esa garantia, porque cada reintento traeria uno nuevo.
 */
export class AcquireUnitRequest {
  @ApiProperty({
    description:
      'Identificador unico de esta adquisicion, en formato UUID. Un reintento debe repetirlo.',
  })
  @IsUUID()
  acquisitionId!: string

  @ApiProperty({ description: 'Jugador que adquiere la unidad.' })
  @IsString()
  @IsNotEmpty()
  playerId!: string
}
