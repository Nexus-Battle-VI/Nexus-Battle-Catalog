import { Controller, Get, Inject, NotFoundException, Param } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'

import { CanonicalProductNotFoundError } from '../../../application/errors/ApplicationError'
import type {
  GetOfficialAuctionEligibility,
  OfficialAuctionEligibility,
} from '../../../application/use-cases/GetOfficialAuctionEligibility'
import { InternalOnly, Public } from './auth/decorators'
import { GET_OFFICIAL_AUCTION_ELIGIBILITY } from './tokens'

/** Contrato interno v1: Catalog decide exclusividad, marca y publicabilidad. */
@ApiExcludeController()
@Controller('internal/v1/catalog/products')
export class InternalOfficialAuctionEligibilityController {
  constructor(
    @Inject(GET_OFFICIAL_AUCTION_ELIGIBILITY)
    private readonly getEligibility: GetOfficialAuctionEligibility,
  ) {}

  @Public()
  @InternalOnly('auction')
  @Get(':id/official-auction-eligibility')
  async get(@Param('id') id: string): Promise<OfficialAuctionEligibility> {
    try {
      return await this.getEligibility.execute(id)
    } catch (error: unknown) {
      if (error instanceof CanonicalProductNotFoundError) {
        throw new NotFoundException(error.message)
      }
      throw error instanceof Error ? error : new Error('Fallo desconocido del servicio.')
    }
  }
}
