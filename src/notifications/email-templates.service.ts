import { Injectable } from '@nestjs/common';
import { NotificationType } from './notifications.types';

interface RenderedEmail {
  subject: string;
  html: string;
}

type Locale = 'en' | 'vi';

/**
 * Renders email templates inline (no React Email build step needed).
 *
 * Each template is a function that takes payload and returns subject + HTML.
 * Two locales: en and vi. Falls back to 'en' if 'vi' missing.
 *
 * Templates use the same dark Stelo branding via inline styles
 * (most email clients strip <style> tags).
 */
@Injectable()
export class EmailTemplatesService {
  private readonly EXPLORER_BASE = 'https://stellar.expert/explorer/testnet';
  private readonly APP_BASE = 'https://stelo.life';

  async render(
    type: NotificationType,
    locale: Locale,
    payload: Record<string, unknown>,
  ): Promise<RenderedEmail> {
    const template = this.templates[type];
    if (!template) {
      throw new Error(`No email template for type: ${type}`);
    }
    return template(locale, payload, this);
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

  /** Template registry. Each entry handles both en and vi locales. */
  private templates: Record<
    string,
    (locale: Locale, p: Record<string, unknown>, ctx: EmailTemplatesService) => RenderedEmail
  > = {
    'order.created': (locale, p, ctx) => {
      const orderNumber = p.shopifyOrderNumber || p.orderId;
      const total = ctx.fmt(p.totalUsdc);
      return locale === 'vi'
        ? {
            subject: `Đơn hàng mới #${orderNumber}`,
            html: ctx.layout(
              `Đơn hàng mới #${orderNumber}`,
              `<p style="color:#cbd5e1;font-size:14px;line-height:1.6;">Bạn vừa nhận đơn hàng mới từ ${p.customerName || 'khách hàng'}. Tổng giá trị: <strong style="color:#22d3ee;">${total} USDC</strong>.</p>`,
              { url: `${ctx.APP_BASE}/orders/${p.orderId}`, label: 'Xem đơn hàng' },
            ),
          }
        : {
            subject: `New order #${orderNumber}`,
            html: ctx.layout(
              `New order #${orderNumber}`,
              `<p style="color:#cbd5e1;font-size:14px;line-height:1.6;">You received a new order from ${p.customerName || 'a customer'}. Total: <strong style="color:#22d3ee;">${total} USDC</strong>.</p>`,
              { url: `${ctx.APP_BASE}/orders/${p.orderId}`, label: 'View order' },
            ),
          };
    },

    'order.cancelled': (locale, p, ctx) => {
      const orderNumber = p.shopifyOrderNumber || p.orderId;
      return locale === 'vi'
        ? {
            subject: `Đơn hàng #${orderNumber} đã hủy`,
            html: ctx.layout(`Đơn hàng đã hủy`, `<p style="color:#cbd5e1;">Đơn hàng #${orderNumber} đã được hủy.</p>`, {
              url: `${ctx.APP_BASE}/orders/${p.orderId}`,
              label: 'Xem chi tiết',
            }),
          }
        : {
            subject: `Order #${orderNumber} cancelled`,
            html: ctx.layout(`Order cancelled`, `<p style="color:#cbd5e1;">Order #${orderNumber} has been cancelled.</p>`, {
              url: `${ctx.APP_BASE}/orders/${p.orderId}`,
              label: 'View details',
            }),
          };
    },

    'order.refunded': (locale, p, ctx) => {
      const orderNumber = p.shopifyOrderNumber || p.orderId;
      return locale === 'vi'
        ? {
            subject: `Đơn #${orderNumber} đã hoàn tiền`,
            html: ctx.layout(`Đơn hàng đã hoàn tiền`, `<p style="color:#cbd5e1;">Đơn #${orderNumber} đã hoàn tiền ${ctx.fmt(p.amountUsdc)} USDC.</p>`),
          }
        : {
            subject: `Order #${orderNumber} refunded`,
            html: ctx.layout(`Order refunded`, `<p style="color:#cbd5e1;">Order #${orderNumber} refunded ${ctx.fmt(p.amountUsdc)} USDC.</p>`),
          };
    },

    'escrow.locking': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Đang khóa escrow ${ctx.fmt(p.amountUsdc)} USDC`,
            html: ctx.layout(`Khóa escrow đang xử lý`, `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC đang được khóa cho đơn hàng.</p>`),
          }
        : {
            subject: `Locking ${ctx.fmt(p.amountUsdc)} USDC in escrow`,
            html: ctx.layout(`Escrow locking in progress`, `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC is being locked for the order.</p>`),
          };
    },

    'escrow.locked': (locale, p, ctx) => {
      const txLink = p.txHash ? `${ctx.EXPLORER_BASE}/tx/${p.txHash}` : null;
      return locale === 'vi'
        ? {
            subject: `Escrow đã khóa ${ctx.fmt(p.amountUsdc)} USDC`,
            html: ctx.layout(
              `Escrow đã khóa thành công`,
              `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC đã được khóa an toàn trên Stellar blockchain.</p>${txLink ? `<p style="margin-top:12px;"><a href="${txLink}" style="color:#22d3ee;font-size:12px;">Xem giao dịch trên Stellar Explorer →</a></p>` : ''}`,
            ),
          }
        : {
            subject: `Escrow locked: ${ctx.fmt(p.amountUsdc)} USDC`,
            html: ctx.layout(
              `Escrow locked successfully`,
              `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC has been securely locked on the Stellar blockchain.</p>${txLink ? `<p style="margin-top:12px;"><a href="${txLink}" style="color:#22d3ee;font-size:12px;">View transaction on Stellar Explorer →</a></p>` : ''}`,
            ),
          };
    },

    'escrow.released': (locale, p, ctx) => {
      const txLink = p.txHash ? `${ctx.EXPLORER_BASE}/tx/${p.txHash}` : null;
      return locale === 'vi'
        ? {
            subject: `Thanh toán đã giải ngân ${ctx.fmt(p.providerAmount)} USDC`,
            html: ctx.layout(
              `Thanh toán đã giải ngân`,
              `<p style="color:#cbd5e1;">${ctx.fmt(p.providerAmount)} USDC đã được chuyển cho nhà cung cấp.</p>${txLink ? `<p><a href="${txLink}" style="color:#22d3ee;font-size:12px;">Xem trên Stellar Explorer →</a></p>` : ''}`,
            ),
          }
        : {
            subject: `Payment released: ${ctx.fmt(p.providerAmount)} USDC`,
            html: ctx.layout(
              `Payment released`,
              `<p style="color:#cbd5e1;">${ctx.fmt(p.providerAmount)} USDC has been sent to the provider.</p>${txLink ? `<p><a href="${txLink}" style="color:#22d3ee;font-size:12px;">View on Stellar Explorer →</a></p>` : ''}`,
            ),
          };
    },

    'escrow.refunded': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Hoàn tiền escrow ${ctx.fmt(p.amountUsdc)} USDC`,
            html: ctx.layout(`Escrow đã hoàn tiền`, `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC đã được hoàn về ví của bạn.</p>`),
          }
        : {
            subject: `Escrow refunded: ${ctx.fmt(p.amountUsdc)} USDC`,
            html: ctx.layout(`Escrow refunded`, `<p style="color:#cbd5e1;">${ctx.fmt(p.amountUsdc)} USDC has been returned to your wallet.</p>`),
          };
    },

    'escrow.lock_failed': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `⚠ Khóa escrow thất bại`,
            html: ctx.layout(
              `Khóa escrow thất bại`,
              `<p style="color:#fca5a5;">Việc khóa escrow đã thất bại sau ${p.attempts || 'nhiều'} lần thử. Đơn hàng cần được xử lý thủ công.</p>`,
              { url: `${ctx.APP_BASE}/orders`, label: 'Xem đơn hàng' },
            ),
          }
        : {
            subject: `⚠ Escrow lock failed`,
            html: ctx.layout(
              `Escrow lock failed`,
              `<p style="color:#fca5a5;">Locking escrow failed after ${p.attempts || 'multiple'} attempts. The order needs manual processing.</p>`,
              { url: `${ctx.APP_BASE}/orders`, label: 'View orders' },
            ),
          };
    },

    'escrow.expired': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Escrow hết hạn — đã hoàn tiền`,
            html: ctx.layout(`Escrow hết hạn`, `<p style="color:#cbd5e1;">Escrow ${ctx.fmt(p.amountUsdc)} USDC đã hết hạn và được hoàn tiền tự động.</p>`),
          }
        : {
            subject: `Escrow expired — auto-refunded`,
            html: ctx.layout(`Escrow expired`, `<p style="color:#cbd5e1;">An escrow of ${ctx.fmt(p.amountUsdc)} USDC expired and was auto-refunded.</p>`),
          };
    },

    'provider_order.shipped': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Đơn hàng đã ship ${p.trackingNumber ? '— ' + p.trackingNumber : ''}`,
            html: ctx.layout(
              `Đơn hàng đã ship`,
              `<p style="color:#cbd5e1;">Nhà cung cấp đã ship đơn hàng.${p.trackingNumber ? `<br>Mã tracking: <strong>${p.trackingNumber}</strong>` : ''}</p>`,
              p.trackingUrl ? { url: String(p.trackingUrl), label: 'Theo dõi đơn hàng' } : undefined,
            ),
          }
        : {
            subject: `Order shipped${p.trackingNumber ? ` — ${p.trackingNumber}` : ''}`,
            html: ctx.layout(
              `Order shipped`,
              `<p style="color:#cbd5e1;">The provider has shipped your order.${p.trackingNumber ? `<br>Tracking: <strong>${p.trackingNumber}</strong>` : ''}</p>`,
              p.trackingUrl ? { url: String(p.trackingUrl), label: 'Track shipment' } : undefined,
            ),
          };
    },

    'provider_order.delivered': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Đơn hàng đã giao thành công`,
            html: ctx.layout(`Đã giao hàng`, `<p style="color:#cbd5e1;">Đơn hàng đã được giao thành công cho khách hàng.</p>`),
          }
        : {
            subject: `Order delivered`,
            html: ctx.layout(`Delivered`, `<p style="color:#cbd5e1;">The order has been delivered to the customer.</p>`),
          };
    },

    'dispute.opened': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `⚠ Tranh chấp mới được mở`,
            html: ctx.layout(
              `Tranh chấp đã được mở`,
              `<p style="color:#fca5a5;">${p.raisedBy === 'merchant' ? 'Merchant' : 'Provider'} đã mở tranh chấp về escrow này.<br>Lý do: ${p.reason || 'Không nêu'}</p>`,
              { url: `${ctx.APP_BASE}/escrow`, label: 'Xem tranh chấp' },
            ),
          }
        : {
            subject: `⚠ New dispute opened`,
            html: ctx.layout(
              `Dispute opened`,
              `<p style="color:#fca5a5;">A ${p.raisedBy} has opened a dispute on this escrow.<br>Reason: ${p.reason || 'Not specified'}</p>`,
              { url: `${ctx.APP_BASE}/escrow`, label: 'View dispute' },
            ),
          };
    },

    'dispute.resolved': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Tranh chấp đã được giải quyết`,
            html: ctx.layout(`Tranh chấp đã giải quyết`, `<p style="color:#cbd5e1;">Tranh chấp đã được giải quyết với tỷ lệ ${p.providerPercent || 0}% cho provider.</p>`),
          }
        : {
            subject: `Dispute resolved`,
            html: ctx.layout(`Dispute resolved`, `<p style="color:#cbd5e1;">The dispute has been resolved with ${p.providerPercent || 0}% to the provider.</p>`),
          };
    },

    'product.published': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Sản phẩm "${p.title}" đã đăng lên Shopify`,
            html: ctx.layout(`Sản phẩm đã đăng`, `<p style="color:#cbd5e1;">Sản phẩm <strong>${p.title}</strong> đã được đăng thành công lên Shopify.</p>`, {
              url: `${ctx.APP_BASE}/products`,
              label: 'Xem sản phẩm',
            }),
          }
        : {
            subject: `Product "${p.title}" published to Shopify`,
            html: ctx.layout(`Product published`, `<p style="color:#cbd5e1;">Product <strong>${p.title}</strong> was successfully published to Shopify.</p>`, {
              url: `${ctx.APP_BASE}/products`,
              label: 'View product',
            }),
          };
    },

    'product.publish_failed': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `Đăng sản phẩm thất bại`,
            html: ctx.layout(`Đăng sản phẩm thất bại`, `<p style="color:#fca5a5;">Sản phẩm <strong>${p.title}</strong> không đăng được.<br>Lỗi: ${p.error || 'Không rõ'}</p>`, {
              url: `${ctx.APP_BASE}/products`,
              label: 'Thử lại',
            }),
          }
        : {
            subject: `Product publish failed`,
            html: ctx.layout(`Publish failed`, `<p style="color:#fca5a5;">Product <strong>${p.title}</strong> failed to publish.<br>Error: ${p.error || 'Unknown'}</p>`, {
              url: `${ctx.APP_BASE}/products`,
              label: 'Retry',
            }),
          };
    },

    'webhook.auto_disabled': (locale, p, ctx) => {
      return locale === 'vi'
        ? {
            subject: `⚠ Webhook đã bị vô hiệu hóa tự động`,
            html: ctx.layout(
              `Webhook bị vô hiệu hóa`,
              `<p style="color:#fca5a5;">Webhook URL của bạn đã thất bại quá nhiều lần và đã bị vô hiệu hóa tự động.<br>Lý do: ${p.reason || 'Quá nhiều thất bại liên tiếp'}</p><p style="color:#cbd5e1;">Vui lòng sửa endpoint và bật lại webhook trong settings.</p>`,
              { url: `${ctx.APP_BASE}/settings`, label: 'Mở settings' },
            ),
          }
        : {
            subject: `⚠ Webhook auto-disabled`,
            html: ctx.layout(
              `Webhook disabled`,
              `<p style="color:#fca5a5;">Your webhook URL has failed too many times and has been automatically disabled.<br>Reason: ${p.reason || 'Too many consecutive failures'}</p><p style="color:#cbd5e1;">Please fix your endpoint and re-enable the webhook in settings.</p>`,
              { url: `${ctx.APP_BASE}/settings`, label: 'Open settings' },
            ),
          };
    },
  };
}
