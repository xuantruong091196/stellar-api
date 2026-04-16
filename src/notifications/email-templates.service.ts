import { Injectable } from '@nestjs/common';
import { NotificationType } from './notifications.types';

interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * Renders English email templates inline (no React Email build step needed).
 * Templates use the Stelo branding via inline styles so most email clients
 * render them correctly.
 */
@Injectable()
export class EmailTemplatesService {
  private readonly EXPLORER_BASE = 'https://stellar.expert/explorer/testnet';
  private readonly APP_BASE = 'https://stelo.life';

  async render(
    type: NotificationType,
    _locale: string,
    payload: Record<string, unknown>,
  ): Promise<RenderedEmail> {
    const template = this.templates[type];
    if (!template) {
      throw new Error(`No email template for type: ${type}`);
    }
    return template(payload, this);
  }

  /** Wrap content in the Stelo branded layout. */
  layout(title: string, body: string, link?: { url: string; label: string }): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#121317;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e3e2e8;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#121317;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:rgba(31,31,36,0.8);border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:linear-gradient(135deg,#0b1e3f 0%,#6366f1 50%,#22d3ee 100%);padding:24px 32px;">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">Stelo</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              <h2 style="margin:0 0 16px 0;color:#ffffff;font-size:20px;font-weight:700;">${title}</h2>
              ${body}
              ${
                link
                  ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
                      <tr>
                        <td style="background:linear-gradient(135deg,#6366f1 0%,#22d3ee 100%);border-radius:9999px;">
                          <a href="${link.url}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-weight:700;text-decoration:none;font-size:14px;">${link.label}</a>
                        </td>
                      </tr>
                    </table>`
                  : ''
              }
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px;border-top:1px solid rgba(255,255,255,0.05);">
              <p style="margin:0;color:#94a3b8;font-size:12px;">Stelo &mdash; Print-on-demand on the Stellar blockchain.</p>
              <p style="margin:8px 0 0 0;color:#94a3b8;font-size:12px;">
                <a href="${this.APP_BASE}/settings" style="color:#22d3ee;text-decoration:none;">Manage notifications</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  /** Helper to format USDC amounts. */
  fmt(n: unknown): string {
    if (typeof n !== 'number') return String(n);
    return n.toFixed(2);
  }

  /**
   * HTML-escape any string for safe interpolation into email templates.
   * Email clients render HTML, so payload fields that originate from user
   * or external input (product titles, customer names, dispute reasons,
   * error messages) must be escaped to prevent tag/attribute injection
   * and the phishing-by-email vector that enables.
   */
  esc(value: unknown): string {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** English-only template registry. */
  private templates: Record<
    string,
    (p: Record<string, unknown>, ctx: EmailTemplatesService) => RenderedEmail
  > = {
    'order.created': (p, ctx) => {
      const orderNumber = ctx.esc(p.shopifyOrderNumber || p.orderId);
      const total = ctx.fmt(p.totalUsdc);
      const customerName = ctx.esc(p.customerName || 'a customer');
      return {
        subject: `New order #${String(p.shopifyOrderNumber || p.orderId || '')}`,
        html: ctx.layout(
          `New order #${orderNumber}`,
          `<p style="color:#cbd5e1;font-size:14px;line-height:1.6;">You received a new order from ${customerName}. Total: <strong style="color:#22d3ee;">${total} USDC</strong>.</p>`,
          { url: `${ctx.APP_BASE}/orders/${encodeURIComponent(String(p.orderId ?? ''))}`, label: 'View order' },
        ),
      };
    },

    'order.cancelled': (p, ctx) => {
      const orderNumber = ctx.esc(p.shopifyOrderNumber || p.orderId);
      return {
        subject: `Order #${String(p.shopifyOrderNumber || p.orderId || '')} cancelled`,
        html: ctx.layout(
          `Order cancelled`,
          `<p style="color:#cbd5e1;">Order #${orderNumber} has been cancelled.</p>`,
          { url: `${ctx.APP_BASE}/orders/${encodeURIComponent(String(p.orderId ?? ''))}`, label: 'View details' },
        ),
      };
    },

    'order.refunded': (p, ctx) => {
      const orderNumber = ctx.esc(p.shopifyOrderNumber || p.orderId);
      return {
        subject: `Order #${String(p.shopifyOrderNumber || p.orderId || '')} refunded`,
        html: ctx.layout(
          `Order refunded`,
          `<p style="color:#cbd5e1;">Order #${orderNumber} refunded ${ctx.fmt(p.amountUsdc)} USDC.</p>`,
        ),
      };
    },

    'escrow.action_required': (p, ctx) => {
      const amount = ctx.fmt(p.amountUsdc);
      const providerName = ctx.esc(p.providerName || 'Provider');
      return {
        subject: `Sign escrow — ${amount} USDC`,
        html: ctx.layout(
          `Escrow signature required`,
          `<p style="color:#cbd5e1;font-size:14px;line-height:1.6;">${providerName} is ready. Please lock <strong style="color:#22d3ee;">${amount} USDC</strong> into escrow to start production.</p>`,
          { url: `${ctx.APP_BASE}/escrow`, label: 'Sign escrow' },
        ),
      };
    },

    'escrow.locking': (p, ctx) => ({
      subject: `Locking ${ctx.fmt(p.amountUsdc)} USDC in escrow`,
      html: ctx.layout(
        `Escrow locking in progress`,
        `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC is being locked for the order.</p>`,
      ),
    }),

    'escrow.locked': (p, ctx) => {
      const txLink = p.txHash ? `${ctx.EXPLORER_BASE}/tx/${p.txHash}` : null;
      return {
        subject: `Escrow locked: ${ctx.fmt(p.amountUsdc)} USDC`,
        html: ctx.layout(
          `Escrow locked successfully`,
          `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC has been securely locked on the Stellar blockchain.</p>${txLink ? `<p style="margin-top:12px;"><a href="${txLink}" style="color:#22d3ee;font-size:12px;">View transaction on Stellar Explorer →</a></p>` : ''}`,
        ),
      };
    },

    'escrow.released': (p, ctx) => {
      const txLink = p.txHash ? `${ctx.EXPLORER_BASE}/tx/${p.txHash}` : null;
      return {
        subject: `Payment released: ${ctx.fmt(p.providerAmount)} USDC`,
        html: ctx.layout(
          `Payment released`,
          `<p style="color:#cbd5e1;">${ctx.fmt(p.providerAmount)} USDC has been sent to the provider.</p>${txLink ? `<p><a href="${txLink}" style="color:#22d3ee;font-size:12px;">View on Stellar Explorer →</a></p>` : ''}`,
        ),
      };
    },

    'escrow.refunded': (p, ctx) => ({
      subject: `Escrow refunded: ${ctx.fmt(p.amountUsdc)} USDC`,
      html: ctx.layout(
        `Escrow refunded`,
        `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC has been returned to your wallet.</p>`,
      ),
    }),

    'escrow.lock_failed': (p, ctx) => ({
      subject: `⚠ Escrow lock failed`,
      html: ctx.layout(
        `Escrow lock failed`,
        `<p style="color:#fca5a5;">Locking escrow failed after ${p.attempts || 'multiple'} attempts. The order needs manual processing.</p>`,
        { url: `${ctx.APP_BASE}/orders`, label: 'View orders' },
      ),
    }),

    'escrow.expired': (p, ctx) => ({
      subject: `Escrow expired — auto-refunded`,
      html: ctx.layout(
        `Escrow expired`,
        `<p style="color:#cbd5e1;">An escrow of ${ctx.fmt(p.amountUsdc)} USDC expired and was auto-refunded.</p>`,
      ),
    }),

    'provider_order.created': (p, ctx) => {
      const orderNumber = ctx.esc(p.shopifyOrderNumber || p.orderId);
      return {
        subject: `New order assigned — #${String(p.shopifyOrderNumber || p.orderId || '')}`,
        html: ctx.layout(
          `New order assigned`,
          `<p style="color:#cbd5e1;font-size:14px;line-height:1.6;">Order <strong>#${orderNumber}</strong> has been assigned to you. Review the details and get ready for production.</p>`,
          { url: `${ctx.APP_BASE}/provider/orders`, label: 'View order' },
        ),
      };
    },

    'provider_order.shipped': (p, ctx) => {
      const trackingEsc = p.trackingNumber ? ctx.esc(p.trackingNumber) : '';
      // Only trust https:// URLs for the tracking link to avoid javascript:
      // or data: URIs slipping through into an email's clickable button.
      const trackingUrlStr = typeof p.trackingUrl === 'string' ? p.trackingUrl : '';
      const safeTrackingUrl = /^https?:\/\//.test(trackingUrlStr) ? trackingUrlStr : '';
      return {
        subject: `Order shipped${p.trackingNumber ? ` — ${String(p.trackingNumber)}` : ''}`,
        html: ctx.layout(
          `Order shipped`,
          `<p style="color:#cbd5e1;">The provider has shipped your order.${trackingEsc ? `<br>Tracking: <strong>${trackingEsc}</strong>` : ''}</p>`,
          safeTrackingUrl ? { url: safeTrackingUrl, label: 'Track shipment' } : undefined,
        ),
      };
    },

    'provider_order.delivered': (_p, ctx) => ({
      subject: `Order delivered`,
      html: ctx.layout(
        `Delivered`,
        `<p style="color:#cbd5e1;">The order has been delivered to the customer.</p>`,
      ),
    }),

    'dispute.opened': (p, ctx) => {
      const raisedBy = p.raisedBy === 'merchant' ? 'merchant' : 'provider';
      const reason = ctx.esc(p.reason || 'Not specified');
      return {
        subject: `⚠ New dispute opened`,
        html: ctx.layout(
          `Dispute opened`,
          `<p style="color:#fca5a5;">A ${raisedBy} has opened a dispute on this escrow.<br>Reason: ${reason}</p>`,
          { url: `${ctx.APP_BASE}/escrow`, label: 'View dispute' },
        ),
      };
    },

    'dispute.resolved': (p, ctx) => {
      const pct = typeof p.providerPercent === 'number' ? p.providerPercent : 0;
      return {
        subject: `Dispute resolved`,
        html: ctx.layout(
          `Dispute resolved`,
          `<p style="color:#cbd5e1;">The dispute has been resolved with ${pct}% to the provider.</p>`,
        ),
      };
    },

    'product.published': (p, ctx) => {
      const title = ctx.esc(p.title);
      return {
        subject: `Product "${String(p.title ?? '')}" published to Shopify`,
        html: ctx.layout(
          `Product published`,
          `<p style="color:#cbd5e1;">Product <strong>${title}</strong> was successfully published to Shopify.</p>`,
          { url: `${ctx.APP_BASE}/products`, label: 'View product' },
        ),
      };
    },

    'product.publish_failed': (p, ctx) => {
      const title = ctx.esc(p.title);
      const err = ctx.esc(p.error || 'Unknown');
      return {
        subject: `Product publish failed`,
        html: ctx.layout(
          `Publish failed`,
          `<p style="color:#fca5a5;">Product <strong>${title}</strong> failed to publish.<br>Error: ${err}</p>`,
          { url: `${ctx.APP_BASE}/products`, label: 'Retry' },
        ),
      };
    },

    'webhook.auto_disabled': (p, ctx) => {
      const reason = ctx.esc(p.reason || 'Too many consecutive failures');
      return {
        subject: `⚠ Webhook auto-disabled`,
        html: ctx.layout(
          `Webhook disabled`,
          `<p style="color:#fca5a5;">Your webhook URL has failed too many times and has been automatically disabled.<br>Reason: ${reason}</p><p style="color:#cbd5e1;">Please fix your endpoint and re-enable the webhook in settings.</p>`,
          { url: `${ctx.APP_BASE}/settings`, label: 'Open settings' },
        ),
      };
    },
  };
}
