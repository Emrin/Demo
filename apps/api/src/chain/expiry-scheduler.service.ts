import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ExpirySchedulerService {
  private readonly logger = new Logger(ExpirySchedulerService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async expireInvoices(): Promise<void> {
    const result = await this.prisma.transaction.updateMany({
      where: {
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });

    if (result.count > 0) {
      this.logger.log(`Expired ${result.count} invoice(s)`);
    }
  }

  // Unconfirmed accounts older than 24 h are permanently unrecoverable — the mnemonic
  // was shown once and never written down, so the stored hash is useless. Deleting
  // frees the username and keeps the DB clean.
  @Cron(CronExpression.EVERY_HOUR)
  async deleteStaleUnconfirmedAccounts(): Promise<void> {
    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await this.prisma.user.deleteMany({
      where: {
        mnemonicConfirmed: false,
        createdAt: { lt: threshold },
      },
    });

    if (result.count > 0) {
      this.logger.log(`Deleted ${result.count} stale unconfirmed account(s)`);
    }
  }
}
