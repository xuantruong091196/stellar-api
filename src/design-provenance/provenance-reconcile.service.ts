import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { StellarService } from '../stellar/stellar.service';
import { ProvenanceStatus } from '../../generated/prisma';
import { decrypt } from '../common/crypto.util';

/**
 * Sentinel value stored in `transferTxHash` while a transfer is in flight.
 * Replaced with the real hash on success, or NULLed on failure so the next
 * cron tick can re-claim. Any non-null value (including this sentinel) makes
 * the reconcile query skip the row, which is what gives us the atomic claim.
 */
const TRANSFER_PENDING_SENTINEL = 'PENDING';

/**
 * Reconciles provenance NFTs that were minted to the issuer (because the
 * merchant hadn't linked their wallet yet) once the merchant opens a
 * trustline on their linked wallet.
 *
 * Why this exists:
 *   `ensureTrustlineOrFallback` returns `targetWallet=issuer, needsTransferOnLink=true`
 *   when the merchant uploads a design before linking. The mint succeeds but
 *   the asset stays on the issuer until this cron moves it.
 *
 * Concurrency:
 *   We claim each row atomically by setting `transferTxHash = 'PENDING'`
 *   before submitting the on-chain payment. Only the worker whose
 *   `updateMany` returns `count === 1` is authorized to submit. On failure,
 *   we revert to NULL so the next tick re-claims. If the on-chain payment
 *   succeeds but the post-update fails (server crash mid-flight), the row
 *   is left in PENDING state and requires manual recovery — surfaceable via
 *   `SELECT * FROM design_provenance WHERE "transferTxHash" = 'PENDING'`.
 */
@Injectable()
export class ProvenanceReconcileService {
  private readonly logger = new Logger(ProvenanceReconcileService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = this.config.get<string>('encryption.key')!;
  }

  /**
   * Find candidates: minted, asset still on issuer, store has linked wallet,
   * not already in a transfer attempt. The trustline check (which requires a
   * Horizon round-trip) happens per-candidate inside the loop — we don't
   * filter for it in SQL because we don't track it in the DB.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileTransferOnLink(): Promise<void> {
    const candidates = await this.prisma.designProvenance.findMany({
      where: {
        status: ProvenanceStatus.MINTED,
        assetCode: { not: null },
        transferTxHash: null,
        // Asset is still on the issuer (mint fell back to issuer at create time)
        ownerWallet: { equals: this.prisma.designProvenance.fields.issuerPublicKey },
        // Merchant has linked a wallet at some point after upload
        store: { walletAddress: { not: null } },
      },
      include: {
        store: { include: { storeIssuer: true } },
      },
    });

    if (candidates.length === 0) return;
    this.logger.log(`Transfer-on-link: ${candidates.length} candidate(s)`);

    for (const prov of candidates) {
      await this.tryTransfer(prov.id).catch((err) => {
        this.logger.warn(
          `Transfer-on-link failed for ${prov.id}: ${(err as Error).message}`,
        );
      });
    }
  }

  /**
   * Per-row transfer with atomic claim. Public so admin endpoints / manual
   * scripts can re-trigger a single row without waiting for the cron tick.
   */
  async tryTransfer(provenanceId: string): Promise<void> {
    const prov = await this.prisma.designProvenance.findUniqueOrThrow({
      where: { id: provenanceId },
      include: { store: { include: { storeIssuer: true } } },
    });

    // Re-check preconditions in case state drifted between findMany and now.
    if (
      prov.status !== ProvenanceStatus.MINTED ||
      !prov.assetCode ||
      prov.transferTxHash !== null ||
      prov.ownerWallet !== prov.issuerPublicKey ||
      !prov.store.walletAddress ||
      !prov.store.storeIssuer
    ) {
      return;
    }

    const merchantWallet = prov.store.walletAddress;
    const issuerPubkey = prov.store.storeIssuer.stellarPublicKey;
    const assetCode = prov.assetCode;

    // Confirm trustline NOW — if the merchant hasn't actually opened it yet,
    // skip cleanly without burning a claim or hitting submit. Cheaper than
    // the full transferProvenanceAsset call (which also pre-checks but
    // wastes a Stellar lock acquisition first).
    let hasTrustline = false;
    try {
      const dest = await this.stellar.server.loadAccount(merchantWallet);
      hasTrustline = (dest.balances ?? []).some(
        (b: any) =>
          b.asset_code === assetCode && b.asset_issuer === issuerPubkey,
      );
    } catch (err: any) {
      // 404 = wallet doesn't exist on-chain yet → not ready, skip silently.
      if (err?.response?.status !== 404) throw err;
    }
    if (!hasTrustline) return;

    // Atomic claim: set sentinel ONLY if still in the unclaimed shape.
    const claim = await this.prisma.designProvenance.updateMany({
      where: {
        id: provenanceId,
        transferTxHash: null,
        ownerWallet: issuerPubkey,
        status: ProvenanceStatus.MINTED,
      },
      data: { transferTxHash: TRANSFER_PENDING_SENTINEL },
    });
    if (claim.count === 0) {
      this.logger.debug(`${provenanceId} claimed by another worker, skipping`);
      return;
    }

    try {
      const issuerSecret = decrypt(
        prov.store.storeIssuer.encryptedSecretKey,
        this.encryptionKey,
      );
      const { txHash } = await this.stellar.transferProvenanceAsset({
        issuerSecret,
        assetCode,
        destinationWallet: merchantWallet,
      });

      await this.prisma.designProvenance.update({
        where: { id: provenanceId },
        data: {
          ownerWallet: merchantWallet,
          transferTxHash: txHash,
          transferredAt: new Date(),
        },
      });

      this.logger.log(
        `Transfer-on-link complete: ${assetCode} → ${merchantWallet} (tx ${txHash})`,
      );
    } catch (err) {
      // Release the claim so the next tick can retry. The on-chain payment
      // either didn't happen or failed; either way, NULLing transferTxHash
      // is correct — if it DID submit and we just lost the response, the
      // next attempt's pre-flight (`issuer holds asset`) will throw and we
      // surface a manual-recovery alert via the PENDING-stuck query.
      await this.prisma.designProvenance
        .updateMany({
          where: {
            id: provenanceId,
            transferTxHash: TRANSFER_PENDING_SENTINEL,
          },
          data: { transferTxHash: null },
        })
        .catch(() => {
          /* best-effort — claim release */
        });
      throw err;
    }
  }
}

// Export the sentinel for tests + ops queries (e.g.
// `WHERE "transferTxHash" = 'PENDING'` to find stuck rows).
export { TRANSFER_PENDING_SENTINEL };
