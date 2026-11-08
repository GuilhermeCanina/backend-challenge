import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  BadRequestException,
  Post,
  Query,
  Res
} from '@nestjs/common';
import type { Response } from 'express';
import { WageringService, type CreateWalletInput, type SubmitWagerInput } from './wagering.service.js';

@Controller()
export class WageringController {
  constructor(private readonly wagering: WageringService) {}

  @Post('wallets')
  createWallet(@Body() body: CreateWalletInput): Promise<Record<string, unknown>> {
    return this.wagering.createWallet(body);
  }

  @Get('wallets/:walletId')
  getWallet(@Param('walletId') walletId: string): Promise<Record<string, unknown>> {
    return this.wagering.getWallet(walletId);
  }

  @Get('wallets/:walletId/ledger')
  getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ): Promise<Record<string, unknown>> {
    const parsedLimit = limit === undefined ? 50 : Number.parseInt(limit, 10);
    if (!Number.isInteger(parsedLimit)) throw new BadRequestException('limit must be an integer');
    return this.wagering.getLedger(walletId, cursor, parsedLimit);
  }

  @Post('wallets/:walletId/reconciliation')
  reconcile(@Param('walletId') walletId: string): Promise<Record<string, unknown>> {
    return this.wagering.reconcileWallet(walletId);
  }

  @Post('wagering/transactions')
  async submitWager(
    @Body() body: SubmitWagerInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res() response: Response
  ): Promise<Response> {
    const result = await this.wagering.processWager(body, idempotencyKey ?? '', correlationId);
    const statusCode = result.status === 'PENDING_REFERENCE' ? 202 : result.status === 'REJECTED' ? 422 : 200;
    return response.status(statusCode).json(result);
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(@Param('transactionId') transactionId: string): Promise<Record<string, unknown>> {
    return this.wagering.getTransaction(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getProviderTransaction(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string
  ): Promise<Record<string, unknown>> {
    return this.wagering.getProviderTransaction(providerId, externalTransactionId);
  }
}
