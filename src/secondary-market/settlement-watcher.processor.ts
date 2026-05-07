import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const CURSOR_NAME = 'marketplace_events';

/**
 * Polls Soroban RPC for marketplace contract events every 30 seconds.
 *
 * STUB: actual `getEvents` call is deferred until Soroban submission helpers
 * land in StellarService. This service compiles, registers the cron, and is a
 * safe no-op until the real implementation drops in.
 */
@Injectable()
export class SettlementWatcher implements OnModuleInit {
  private readonly logger = new Logger(SettlementWatcher.name);
  private readonly contractId: string | undefined;
  private enabled = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {
    this.contractId = this.cfg.get<string>('stellar.marketplaceContractId');
  }

  onModuleInit() {
    this.enabled =
      !!this.contractId && this.cfg.get<boolean>('features.marketplace') === true;
    if (this.enabled) {
      this.logger.log(
        `SettlementWatcher armed for marketplace ${this.contractId} — Soroban impl is a stub`,
      );
    } else {
      this.logger.log(
        'SettlementWatcher disabled (FEATURE_MARKETPLACE off or contract ID missing)',
      );
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick() {
    if (!this.enabled) return;

    // Read cursor (last processed ledger). Default 0 = start from genesis.
    const cursor = await this.prisma.cursor.findUnique({ where: { name: CURSOR_NAME } });
    const startLedger = cursor ? Number(cursor.value) : 0;

    // TODO Plan D follow-up: real Soroban event fetch
    //   const events = await this.sorobanRpc.getEvents({
    //     startLedger, filters: [{ type: 'contract', contractIds: [this.contractId] }],
    //   });
    //   for (const ev of events.events) {
    //     const topic = StellarSdk.scValToNative(ev.topic[0]);
    //     if (topic === 'sale') await this.handleSale(ev);
    //   }
    //   await this.upsertCursor(events.latestLedger);

    // For now: no-op. Logged once at boot via onModuleInit.
    void startLedger; // suppress unused-var lint
  }

  /** Persist a row in SecondaryRoyaltyPayment for each sale event we observe. */
  private async handleSale(ev: any): Promise<void> {
    // TODO: parse ev.value (buyer, seller, tokenId, price, royalty, fee)
    //   const [buyer, seller, tokenId, price, royalty, fee] = scValToNative(ev.value);
    //   const nft = await this.prisma.nftToken.findFirst({
    //     where: { contractTokenId: String(tokenId), contractAddress: ev.contractId },
    //   });
    //   if (!nft) return;
    //   await this.prisma.secondaryRoyaltyPayment.upsert({
    //     where: { saleTxHash: ev.txHash },
    //     create: {
    //       nftTokenId: nft.id, saleTxHash: ev.txHash,
    //       saleAmountUsdc: Number(price) / 1e7,
    //       totalRoyalty: Number(royalty) / 1e7,
    //       splits: [], ledger: ev.ledger,
    //     },
    //     update: {},
    //   });
    void ev; // suppress unused-var lint until impl lands
  }

  private async upsertCursor(latestLedger: number): Promise<void> {
    await this.prisma.cursor.upsert({
      where: { name: CURSOR_NAME },
      create: { name: CURSOR_NAME, value: String(latestLedger) },
      update: { value: String(latestLedger) },
    });
  }
}

/**
 * Daily reconciliation sweep: flag ACTIVE listings whose on-chain owner ≠ marketplace
 * as STALE for ops investigation. Doesn't auto-create payment rows (can't fabricate
 * price/buyer); only catches drift the cursor-based watcher missed.
 *
 * STUB: depends on SteloNftService.ownerOf which is a stub.
 */
@Injectable()
export class MarketplaceReconciliation {
  private readonly logger = new Logger(MarketplaceReconciliation.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: ConfigService,
  ) {}

  @Cron('0 4 * * *') // 04:00 UTC daily
  async sweep() {
    if (!this.cfg.get<boolean>('features.marketplace')) return;
    // TODO Plan D follow-up: see plan spec for full impl
    //   stale = listings WHERE status='ACTIVE' AND listedAt < now()-1h
    //   for each: nft.ownerOf(contractAddress, contractTokenId)
    //     if owner != cfg.marketplaceContractId → mark STALE + alert
    this.logger.log('SettlementWatcher reconciliation sweep — stub no-op');
  }
}
