import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NbxplorerService } from './nbxplorer.service';

// LTC needs more confirmations than BTC — it's a smaller PoW chain and
// meaningfully more susceptible to reorgs on mainnet.
// NOTE: reorgs after these thresholds are not actively unwound — the thresholds
// are chosen to make reorgs practically impossible, not to handle them.
// These are security parameters and are intentionally hardcoded, not derived
// from NETWORK — an accidental env var change should not lower the bar.
const CONFIRMATIONS_REQUIRED: Record<string, number> = { BTC: 2, LTC: 6 };

@Injectable()
export class NbxplorerPollerService implements OnModuleInit {
  private readonly logger = new Logger(NbxplorerPollerService.name);

  constructor(
    private readonly nbx: NbxplorerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    for (const currency of ['BTC', 'LTC']) {
      void this.pollLoop(currency);
    }
  }

  private async pollLoop(currency: string): Promise<void> {
    let lastEventId = 0;

    while (true) {
      try {
        const events = await this.nbx.longPollEvents(currency, lastEventId);

        for (const event of events) {
          if (event.eventId > lastEventId) lastEventId = event.eventId;
          await this.handleEvent(currency, event);
        }
      } catch (err) {
        const e = err as Error;
        // TimeoutError is expected while NBXplorer is starting up or when the
        // long-poll window closes with no events — retry immediately, no log noise.
        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
          continue;
        }
        this.logger.error(`${currency} poll error: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  private async handleEvent(
    currency: string,
    event: Awaited<ReturnType<NbxplorerService['longPollEvents']>>[number],
  ): Promise<void> {
    if (event.type === 'newblock') {
      await this.handleNewBlock(currency);
      return;
    }

    if (event.type !== 'newtransaction') return;

    // newtransaction: first detection — record txid and initial confirmations.
    const txData = event.data.transactionData;
    if (!txData) return;

    const required = CONFIRMATIONS_REQUIRED[currency] ?? 2;
    const confirmations = txData.confirmations ?? 0;

    for (const output of event.data.outputs ?? []) {
      if (!output.address) continue;
      const pending = await this.prisma.transaction.findFirst({
        where: { address: output.address, currency, status: 'pending' },
      });
      if (!pending) continue;

      if (confirmations < required) {
        // Store the actual on-chain amount now so handleNewBlock credits the
        // received amount (not the invoice amount) when it later settles.
        const receivedUnits = BigInt(Math.round(output.value ?? 0));
        await this.prisma.transaction.update({
          where: { id: pending.id },
          data: { confirmations, txid: txData.transactionHash, amountSats: receivedUnits },
        });
        this.logger.log(
          `${currency} tx ${txData.transactionHash} has ${confirmations}/${required} confirmations`,
        );
      } else {
        await this.settle(
          pending,
          BigInt(Math.round(output.value ?? 0)),
          txData.transactionHash,
          confirmations,
        );
      }
    }
  }

  /** On each new block, re-query confirmation counts for all in-flight transactions.
   *  NBXplorer only emits newtransaction once (first detection) — subsequent
   *  confirmation increments are only visible by querying the transaction directly. */
  private async handleNewBlock(currency: string): Promise<void> {
    const inFlight = await this.prisma.transaction.findMany({
      where: { currency, status: 'pending', txid: { not: null } },
    });
    if (inFlight.length === 0) return;

    const required = CONFIRMATIONS_REQUIRED[currency] ?? 2;

    for (const tx of inFlight) {
      if (!tx.txid) continue;
      try {
        const confirmations = await this.nbx.getTransactionConfirmations(currency, tx.txid);
        if (confirmations === null) continue; // tx not found — likely a reorg, leave pending

        if (confirmations >= required) {
          await this.settle(tx, tx.amountSats, tx.txid, confirmations);
        } else if (confirmations > tx.confirmations) {
          await this.prisma.transaction.update({
            where: { id: tx.id },
            data: { confirmations },
          });
          this.logger.log(
            `${currency} tx ${tx.txid} has ${confirmations}/${required} confirmations`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `${currency} confirmation check failed for ${tx.txid}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async settle(
    pending: { id: number; userId: number; currency: string; amountSats: bigint },
    creditUnits: bigint,
    txid: string,
    confirmations: number,
  ): Promise<void> {
    const balanceField =
      pending.currency === 'LTC' ? 'balanceLitoshi' : 'balanceSats';

    const updated = await this.prisma.transaction.updateMany({
      where: { id: pending.id, status: 'pending' },
      data: { status: 'settled', amountSats: creditUnits, txid, confirmations },
    });

    if (updated.count === 0) return; // already settled or expired — bail

    await this.prisma.user.update({
      where: { id: pending.userId },
      data: { [balanceField]: { increment: creditUnits } },
    });

    this.logger.log(
      `Settled ${pending.currency} tx ${txid}: credited ${creditUnits} to user ${pending.userId}`,
    );
  }
}
