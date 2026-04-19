import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { EmailService } from '../notifications/email.service';

@Injectable()
export class SystemBalanceMonitor {
  private readonly logger = new Logger(SystemBalanceMonitor.name);
  private readonly warnThreshold: number;
  private readonly criticalThreshold: number;
  private readonly adminEmail: string;
  private mintPaused = false;

  constructor(
    private readonly stellar: StellarService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
  ) {
    this.warnThreshold = this.config.get<number>('nft.systemXlmWarnThreshold') || 500;
    this.criticalThreshold = this.config.get<number>('nft.systemXlmCriticalThreshold') || 200;
    this.adminEmail = this.config.get<string>('nft.adminEmail') || 'admin@stelo.life';
  }

  isMintPaused(): boolean {
    return this.mintPaused;
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkBalance() {
    try {
      const systemPublicKey = this.stellar.getSystemPublicKey();
      if (!systemPublicKey) return;

      const balance = await this.stellar.getXlmBalance(systemPublicKey);
      if (balance === null || balance === undefined) return;

      if (balance < this.criticalThreshold) {
        this.mintPaused = true;
        this.logger.error(`CRITICAL: SYSTEM account balance ${balance} XLM < ${this.criticalThreshold} — mint paused`);
        await this.emailService.sendRaw({
          to: this.adminEmail,
          subject: `[CRITICAL] Stelo SYSTEM account low: ${balance} XLM`,
          html: `<p>SYSTEM account balance is <b>${balance} XLM</b>. NFT minting has been paused. Top up immediately.</p>`,
        }).catch(() => {});
      } else if (balance < this.warnThreshold) {
        this.mintPaused = false;
        this.logger.warn(`WARNING: SYSTEM account balance ${balance} XLM < ${this.warnThreshold}`);
        await this.emailService.sendRaw({
          to: this.adminEmail,
          subject: `[WARNING] Stelo SYSTEM account low: ${balance} XLM`,
          html: `<p>SYSTEM account balance is <b>${balance} XLM</b>. Consider topping up soon.</p>`,
        }).catch(() => {});
      } else {
        if (this.mintPaused) {
          this.logger.log(`SYSTEM account balance restored: ${balance} XLM — mint resumed`);
        }
        this.mintPaused = false;
      }
    } catch (err) {
      this.logger.error(`Balance check failed: ${(err as Error).message}`);
    }
  }
}
