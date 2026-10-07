import { Controller, Get, Inject } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

import type { CombatBotCandidatesResponse } from '../../../application/dto/CombatBotCandidatesDto'
import type { ListCombatBotCandidates } from '../../../application/use-cases/ListCombatBotCandidates'
import { InternalOnly, Public } from './auth/decorators'
import { LIST_COMBAT_BOT_CANDIDATES } from './tokens'

/** Contrato interno gameplay-only que desbloquea HU-93.1 en Combat. */
@ApiExcludeController()
@Controller('internal/v1/catalog/combat')
export class InternalCombatBotCandidatesController {
  constructor(
    @Inject(LIST_COMBAT_BOT_CANDIDATES)
    private readonly listCandidates: ListCombatBotCandidates,
  ) {}

  @Public()
  @InternalOnly('combat')
  @Get('bot-candidates')
  list(): Promise<CombatBotCandidatesResponse> {
    return this.listCandidates.execute()
  }
}
