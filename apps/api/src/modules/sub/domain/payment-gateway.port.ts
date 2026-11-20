import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CurrencyCode } from '@nexstock/contracts';
import { AppError } from '../../shared/index.js';

export type OnlineGatewayProviderCode = 'PAYHERE_LK' | 'STRIPE' | 'PADDLE';

export interface GatewayCheckoutSessionResult {
  readonly configured: boolean;
  readonly providerCode: OnlineGatewayProviderCode;
  readonly sessionReference: string;
  readonly checkoutUrl: string | null;
  readonly mode: 'LIVE_REDIRECT' | 'GATEWAY_CONFIGURATION_REQUIRED';
  readonly message: string;
}

export interface OnlinePaymentGatewayPort {
  readonly providerCode: OnlineGatewayProviderCode;
  createCheckoutSession(params: {
    readonly tenantId: string;
    readonly submissionId: string;
    readonly invoiceNumber: string;
    readonly amount: string;
    readonly currencyCode: CurrencyCode;
    readonly returnUrl?: string | undefined;
    readonly cancelUrl?: string | undefined;
  }): GatewayCheckoutSessionResult;

  verifyWebhookSignature(params: {
    readonly rawPayload: string;
    readonly signatureHeader: string | undefined;
  }): boolean;
}

function getProviderSecret(providerCode: OnlineGatewayProviderCode): string | null {
  if (providerCode === 'PAYHERE_LK') {
    return process.env.NEXSTOCK_PAYHERE_MERCHANT_SECRET?.trim() || null;
  }
  if (providerCode === 'STRIPE') {
    return process.env.NEXSTOCK_STRIPE_WEBHOOK_SECRET?.trim() || null;
  }
  return process.env.NEXSTOCK_PADDLE_WEBHOOK_SECRET?.trim() || null;
}

/**
 * Provider-neutral Online Payment Gateway Adapter (Phase 10.4).
 * Never fabricates live credentials or marks payments paid on redirect alone.
 */
export class ConfigurableOnlineGatewayAdapter implements OnlinePaymentGatewayPort {
  constructor(readonly providerCode: OnlineGatewayProviderCode) {}

  createCheckoutSession(params: {
    readonly tenantId: string;
    readonly submissionId: string;
    readonly invoiceNumber: string;
    readonly amount: string;
    readonly currencyCode: CurrencyCode;
    readonly returnUrl?: string | undefined;
    readonly cancelUrl?: string | undefined;
  }): GatewayCheckoutSessionResult {
    const secret = getProviderSecret(this.providerCode);
    if (!secret) {
      return {
        configured: false,
        providerCode: this.providerCode,
        sessionReference: `GW-INIT-${params.submissionId.slice(0, 8).toUpperCase()}`,
        checkoutUrl: null,
        mode: 'GATEWAY_CONFIGURATION_REQUIRED',
        message: `Online gateway "${this.providerCode}" credentials are not configured in environment variables yet. Use Manual Bank Transfer or configure provider credentials before enabling live checkout.`,
      };
    }

    const baseCheckoutUrl =
      this.providerCode === 'PAYHERE_LK'
        ? process.env.NEXSTOCK_PAYHERE_CHECKOUT_URL || 'https://sandbox.payhere.lk/pay/checkout'
        : this.providerCode === 'STRIPE'
          ? 'https://checkout.stripe.com/pay'
          : 'https://checkout.paddle.com/checkout';

    return {
      configured: true,
      providerCode: this.providerCode,
      sessionReference: `${this.providerCode}-${params.submissionId}`,
      checkoutUrl: `${baseCheckoutUrl}?order_id=${encodeURIComponent(params.submissionId)}&invoice=${encodeURIComponent(params.invoiceNumber)}`,
      mode: 'LIVE_REDIRECT',
      message: 'Gateway session initiated; activation awaits verified provider webhook.',
    };
  }

  verifyWebhookSignature(params: {
    readonly rawPayload: string;
    readonly signatureHeader: string | undefined;
  }): boolean {
    const secret =
      getProviderSecret(this.providerCode) ??
      process.env.NEXSTOCK_SUBSCRIPTION_WEBHOOK_SECRET?.trim() ??
      null;

    if (!secret) {
      throw new AppError({
        statusCode: 503,
        errorCode: 'ERR_FORBIDDEN',
        title: 'Online Gateway Webhook Secret Not Configured',
        detail: `Webhook verification secret for provider "${this.providerCode}" is not configured.`,
      });
    }

    const provided = (params.signatureHeader ?? '').trim().replace(/^sha256=/i, '');
    if (!provided) return false;

    const expectedHex = createHmac('sha256', secret)
      .update(params.rawPayload, 'utf-8')
      .digest('hex');

    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return timingSafeEqual(a, b);
  }
}

export function getOnlineGatewayAdapter(
  providerCode: OnlineGatewayProviderCode,
): OnlinePaymentGatewayPort {
  return new ConfigurableOnlineGatewayAdapter(providerCode);
}
