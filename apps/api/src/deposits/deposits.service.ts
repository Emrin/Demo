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
    currency: string,
  ): Promise<{
    invoiceId: string;
    amountSats: string;
    address: string;
    currency: string;
    status: string;
  }> {
    // Enforce 1 pending invoice per user per currency
    const existing = await this.prisma.transaction.findFirst({
      where: { userId, currency, status: 'pending', deletedAt: null },
    });
    if (existing) {
      throw new ConflictException({
        message: `You already have a pending ${currency} deposit`,
        invoiceId: existing.invoiceId,
        amountSats: existing.amountSats.toString(),
        address: existing.address,
        currency: existing.currency,
      });
    }

    const amountDecimal = (amountSats / 1e8).toFixed(8);

    const invoiceRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${this.apiKey}`,
        },
        body: JSON.stringify({
          amount: amountDecimal,
          currency,
          metadata: { userId },
          paymentMethods: [`${currency}-CHAIN`],
        }),
      },
    );

    if (!invoiceRes.ok) {
      const text = await invoiceRes.text();
      this.logger.error(`BtcPayServer invoice creation failed: ${text}`);
      throw new InternalServerErrorException('Failed to create payment invoice');
    }

    const invoice = (await invoiceRes.json()) as { id: string; status: string };
    const invoiceId = invoice.id;

    // Fetch payment methods to get the on-chain address
    const pmRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices/${invoiceId}/payment-methods`,
      { headers: { Authorization: `token ${this.apiKey}` } },
    );

    if (!pmRes.ok) {
      const text = await pmRes.text();
      this.logger.error(`BtcPayServer payment-methods fetch failed: ${text}`);
      throw new InternalServerErrorException('Failed to retrieve payment address');
    }

    const paymentMethods = (await pmRes.json()) as Array<{
      paymentMethodId: string;
      destination: string;
    }>;

    const method = paymentMethods.find(
      (pm) => pm.paymentMethodId === `${currency}-CHAIN`,
    );

    if (!method) {
      throw new InternalServerErrorException(
        `${currency} on-chain payment method not found`,
      );
    }

    await this.prisma.transaction.create({
      data: {
        userId,
        invoiceId,
        amountSats: BigInt(amountSats),
        address: method.destination,
        currency,
        status: 'pending',
      },
    });

    return {
      invoiceId,
      amountSats: amountSats.toString(),
      address: method.destination,
      currency,
      status: 'pending',
    };
  }

  async handleWebhook(
    payload: any,
    signature: string,
    rawBody: Buffer,
  ): Promise<void> {
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
      afterExpiration?: boolean;
      payment?: { value: string };
    };

    this.logger.log(`Webhook event: ${event.type} invoiceId=${event.invoiceId}`);

    switch (event.type) {
      case 'InvoiceExpired':
        if (event.invoiceId) await this.handleExpired(event.invoiceId);
        break;
      case 'InvoiceSettled':
        if (!event.invoiceId) throw new BadRequestException('Missing invoiceId');
        await this.handleSettled(event.invoiceId);
        break;
      case 'InvoicePaymentSettled':
        // Only act on payments that arrived after the invoice expired —
        // normal on-time payments are covered by InvoiceSettled above.
        if (event.afterExpiration && event.invoiceId) {
          await this.handleLatePayment(event.invoiceId, event.payment?.value);
        }
        break;
      default:
        // Other event types (InvoiceCreated, InvoiceProcessing, …) — ignore
    }
  }

  private async handleExpired(invoiceId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { invoiceId } });
    if (!tx || tx.status !== 'pending') return;
    await this.prisma.transaction.update({
      where: { invoiceId },
      data: { status: 'expired' },
    });
    this.logger.log(`Invoice ${invoiceId} marked as expired`);
  }

  private async handleSettled(invoiceId: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { invoiceId } });
    if (!tx) {
      this.logger.warn(`No transaction found for invoiceId=${invoiceId}`);
      return;
    }
    if (tx.status === 'settled') {
      this.logger.log(`Invoice ${invoiceId} already settled, skipping`);
      return;
    }

    // Fetch actual paid amount from BtcPayServer to handle overpayments
    const pmRes = await fetch(
      `${this.btcpayUrl}/api/v1/stores/${this.storeId}/invoices/${invoiceId}/payment-methods`,
      { headers: { Authorization: `token ${this.apiKey}` } },
    );

    let creditUnits = tx.amountSats;
    if (pmRes.ok) {
      const methods = (await pmRes.json()) as Array<{
        paymentMethodId: string;
        totalPaid: string;
      }>;
      const method = methods.find((m) => m.paymentMethodId === `${tx.currency}-CHAIN`);
      if (method?.totalPaid) {
        const paid = BigInt(Math.round(parseFloat(method.totalPaid) * 1e8));
        if (paid > 0n) creditUnits = paid;
      }
    }

    await this.creditUser(tx, invoiceId, creditUnits);
  }

  private async handleLatePayment(invoiceId: string, paymentValue?: string): Promise<void> {
    const tx = await this.prisma.transaction.findUnique({ where: { invoiceId } });
    if (!tx) {
      this.logger.warn(`No transaction found for late payment invoiceId=${invoiceId}`);
      return;
    }
    if (tx.status === 'settled') {
      this.logger.log(`Invoice ${invoiceId} already settled, skipping late payment`);
      return;
    }

    let creditUnits = tx.amountSats;
    if (paymentValue) {
      const paid = BigInt(Math.round(parseFloat(paymentValue) * 1e8));
      if (paid > 0n) creditUnits = paid;
    }

    await this.creditUser(tx, invoiceId, creditUnits);
    this.logger.log(`Late payment credited for invoice ${invoiceId}`);
  }

  private async creditUser(
    tx: { userId: number; currency: string },
    invoiceId: string,
    creditUnits: bigint,
  ): Promise<void> {
    const balanceField = tx.currency === 'LTC' ? 'balanceLitoshi' : 'balanceSats';
    await this.prisma.$transaction([
      this.prisma.transaction.update({
        where: { invoiceId },
        data: { status: 'settled', amountSats: creditUnits },
      }),
      this.prisma.user.update({
        where: { id: tx.userId },
        data: { [balanceField]: { increment: creditUnits } },
      }),
    ]);
    this.logger.log(`Credited ${creditUnits} ${tx.currency} to user ${tx.userId}`);
  }

  async getInvoiceStatus(invoiceId: string): Promise<{ status: string }> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { invoiceId },
      select: { status: true },
    });

    if (!transaction) throw new BadRequestException('Invoice not found');
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
    if (tx.userId !== userId) throw new ForbiddenException();
    if (tx.status === 'pending') {
      throw new BadRequestException('Cannot remove a pending invoice');
    }

    await this.prisma.transaction.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async getUserBalance(
    userId: number,
  ): Promise<{ balanceSats: string; balanceLitoshi: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balanceSats: true, balanceLitoshi: true },
    });

    if (!user) throw new BadRequestException('User not found');

    return {
      balanceSats: user.balanceSats.toString(),
      balanceLitoshi: user.balanceLitoshi.toString(),
    };
  }
}
