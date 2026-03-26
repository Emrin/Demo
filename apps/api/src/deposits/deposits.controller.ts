import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { DepositsService } from './deposits.service';

interface AuthenticatedRequest extends Request {
  user: { id: number; email: string };
  rawBody: Buffer;
}

@Controller('deposits')
export class DepositsController {
  constructor(private readonly depositsService: DepositsService) {}

  @UseGuards(JwtAuthGuard)
  @Post()
  createDeposit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateDepositDto,
  ) {
    return this.depositsService.createDeposit(req.user.id, dto.amountSats);
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  handleWebhook(@Req() req: AuthenticatedRequest) {
    const rawBody: Buffer = req.rawBody;
    const signature = (req.headers['btcpay-sig'] as string) ?? '';
    const payload = JSON.parse(rawBody.toString('utf8'));
    return this.depositsService.handleWebhook(payload, signature, rawBody);
  }

  @Get('status/:invoiceId')
  getInvoiceStatus(@Param('invoiceId') invoiceId: string) {
    return this.depositsService.getInvoiceStatus(invoiceId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('transactions')
  getTransactions(@Req() req: AuthenticatedRequest) {
    return this.depositsService.getUserTransactions(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  softDelete(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.depositsService.softDeleteTransaction(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('balance')
  getUserBalance(@Req() req: AuthenticatedRequest) {
    return this.depositsService.getUserBalance(req.user.id);
  }
}
