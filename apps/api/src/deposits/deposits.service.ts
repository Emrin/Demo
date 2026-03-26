import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);
  private readonly btcpayUrl =
    process.env.BTCPAY_URL || 'http://btcpayserver:14142';
  private readonly apiKey = process.env.BTCPAY_API_KEY!;
  private readonly storeId = process.env.BTCPAY_STORE_ID!;
  private readonly webhookSecret = process.env.BTCPAY_WEBHOOK_SECRET!;

  constructor(private readonly prisma: PrismaService) {}

  async createDeposit(
    userId: number,
    amountSats: number,
  ): Promise<{
    invoiceId: string;
    amountSats: string;
    address: string;
    status: string;
  }> {
    // Enforce 1 pending invoice per user
    const existing = await this.prisma.transaction.findFirst({
      where: { userId, status: 'pending', deletedAt: null },
    });
    if (existing) {
      throw new ConflictException({
        message: 'You already have a pending deposit',
        invoiceId: existing.invoiceId,
        amountSats: existing.amountSats.toString(),
      });
    }

    const amountBtc = (amountSats / 1e8).toFixed(8);

    // Create invoice via BtcPayServer Greenfield API
    const invoiceRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${this.apiKey}`,
        },
        body: JSON.stringify({
          amount: amountBtc,
          currency: 'BTC',
          metadata: { userId },
        }),
      },
    );

    if (!invoiceRes.ok) {
      const text = await invoiceRes.text();
      this.logger.error(`BtcPayServer invoice creation failed: ${text}`);
      throw new InternalServerErrorException(
        'Failed to create payment invoice',
      );
    }

    const invoice = (await invoiceRes.json()) as { id: string; status: string };
    const invoiceId = invoice.id;

    // Fetch payment methods to get on-chain BTC address
    const pmRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices/${invoiceId}/payment-methods`,
      {
        headers: {
          Authorization: `token ${this.apiKey}`,
        },
      },
    );

    if (!pmRes.ok) {
      const text = await pmRes.text();
      this.logger.error(`BtcPayServer payment-methods fetch failed: ${text}`);
      throw new InternalServerErrorException('Failed to retrieve BTC address');
    }

    const paymentMethods = (await pmRes.json()) as Array<{
      paymentMethodId: string;
      destination: string;
    }>;

    const btcMethod = paymentMethods.find(
      (pm) => pm.paymentMethodId === 'BTC-CHAIN',
    );

    if (!btcMethod) {
      throw new InternalServerErrorException(
        'BTC on-chain payment method not found',
      );
    }

    const address = btcMethod.destination;

    // Store pending transaction in DB
    await this.prisma.transaction.create({
      data: {
        userId,
        invoiceId,
        amountSats: BigInt(amountSats),
        status: 'pending',
      },
    });

    return {
      invoiceId,
      amountSats: amountSats.toString(),
      address,
      status: 'pending',
    };
  }

  async handleWebhook(
    payload: any,
    signature: string,
    rawBody: Buffer,
  ): Promise<void> {
    // Verify HMAC-SHA256 signature: header format "sha256=<hex>"
    const expectedSig =
      'sha256=' +
      createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

    if (signature !== expectedSig) {
      this.logger.warn('Webhook signature mismatch');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const event = payload as {
      type: string;
      invoiceId?: string;
      metadata?: { userId?: number };
    };

    this.logger.log(`Webhook event: ${event.type} invoiceId=${event.invoiceId}`);

    if (event.type !== 'InvoiceSettled') {
      // Acknowledge but take no action for other event types
      return;
    }

    const invoiceId = event.invoiceId;
    if (!invoiceId) {
      throw new BadRequestException('Missing invoiceId in webhook payload');
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { invoiceId },
    });

    if (!transaction) {
      this.logger.warn(`No transaction found for invoiceId=${invoiceId}`);
      return;
    }

    if (transaction.status === 'settled') {
      this.logger.log(
        `Transaction ${invoiceId} already settled, skipping duplicate webhook`,
      );
      return;
    }

    // Fetch actual paid amount from BtcPayServer (covers overpayment)
    const pmRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices/${invoiceId}/payment-methods`,
      { headers: { Authorization: `token ${this.apiKey}` } },
    );

    let creditSats = transaction.amountSats;
    if (pmRes.ok) {
      const methods = (await pmRes.json()) as Array<{
        paymentMethodId: string;
        totalPaid: string;
      }>;
      const btc = methods.find((m) => m.paymentMethodId === 'BTC-CHAIN');
      if (btc && btc.totalPaid) {
        const paidSats = BigInt(Math.round(parseFloat(btc.totalPaid) * 1e8));
        if (paidSats > 0n) creditSats = paidSats;
      }
    }

    // Credit actual paid amount atomically
    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { invoiceId },
        data: { status: 'settled', amountSats: creditSats },
      }),
      this.prisma.user.update({
        where: { id: transaction.userId },
        data: { balanceSats: { increment: creditSats } },
      }),
    ]);

    this.logger.log(
      `Credited ${creditSats} sats to user ${transaction.userId} (invoiced ${transaction.amountSats})`,
    );
  }

  async getInvoiceStatus(
    invoiceId: string,
  ): Promise<{ status: string }> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { invoiceId },
      select: { status: true },
    });

    if (!transaction) {
      throw new BadRequestException('Invoice not found');
    }

    return { status: transaction.status };
  }

  async getUserTransactions(userId: number): Promise<{
    pending: object[];
    history: object[];
  }> {
    const txs = await this.prisma.transaction.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    const serialize = (tx: (typeof txs)[number]) => ({
      ...tx,
      amountSats: tx.amountSats.toString(),
    });

    return {
      pending: txs.filter((t) => t.status === 'pending').map(serialize),
      history: txs.filter((t) => t.status !== 'pending').map(serialize),
    };
  }

  async softDeleteTransaction(id: number, userId: number): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { id } });

    if (!tx || tx.deletedAt !== null) {
      throw new BadRequestException('Transaction not found');
    }
    if (tx.userId !== userId) {
      throw new ForbiddenException();
    }
    if (tx.status === 'pending') {
      throw new BadRequestException('Cannot remove a pending invoice');
    }

    await this.prisma.transaction.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async getUserBalance(userId: number): Promise<{ balanceSats: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balanceSats: true },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    return { balanceSats: user.balanceSats.toString() };
  }
}
