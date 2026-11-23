import crypto from 'crypto';
import { BadGatewayError, BadRequestError, ServiceUnavailableError } from '../../../shared/errors/index.js';

const CASHFREE_SANDBOX_URL = 'https://sandbox.cashfree.com/pg';
const CASHFREE_API_VERSION = '2026-01-01';

export class CashfreePaymentGatewayService {
  constructor({
    appId,
    secretKey,
    environment = 'TEST',
    webhookUrl = process.env.CASHFREE_WEBHOOK_URL || '',
    apiVersion = CASHFREE_API_VERSION,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.appId = appId || process.env.CASHFREE_App_ID || process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || '';
    this.secretKey = secretKey || process.env.CASHFREE_KEY_SECRET || process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_CLIENT_SECRET || '';
    // This migration is intentionally restricted to Cashfree sandbox. A
    // production gateway cannot be selected by an environment typo.
    this.environment = 'TEST';
    this.webhookUrl = webhookUrl;
    this.apiVersion = apiVersion;
    // Cloudflare's global fetch must retain globalThis as its receiver. Storing
    // it on this service and calling this.fetch(...) otherwise throws
    // "Illegal invocation" in Workers (Node's fetch does not expose this bug).
    this.fetch = typeof fetchImpl === 'function' ? fetchImpl.bind(globalThis) : fetchImpl;
    this.provider = 'cashfree';
  }

  get effectiveAppId() {
    return this.appId || process.env.CASHFREE_App_ID || process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || '';
  }

  get effectiveSecretKey() {
    return this.secretKey || process.env.CASHFREE_KEY_SECRET || process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_CLIENT_SECRET || '';
  }

  getBaseUrl() {
    return CASHFREE_SANDBOX_URL;
  }

  assertConfigured() {
    if (!this.effectiveAppId || !this.effectiveSecretKey) {
      throw new ServiceUnavailableError(
        'Cashfree payments are not configured. Add CASHFREE_App_ID and CASHFREE_KEY_SECRET to the backend environment.',
        null,
        'CASHFREE_NOT_CONFIGURED',
      );
    }
  }

  async createPaymentIntent({ orderId, amount, currency = 'INR', customer = {}, metadata = {} }) {
    if (!orderId || amount <= 0) {
      throw new BadRequestError('Invalid order ID or payable amount for payment intent');
    }

    this.assertConfigured();

    const customerPhone = String(customer.phone || '9999999999').replace(/\D/g, '').slice(-10) || '9999999999';
    const customerId = String(customer.id || metadata?.patient_id || `cust_${orderId}`).slice(0, 50);

    const payload = {
      order_id: String(orderId).slice(0, 45),
      order_amount: Number(amount),
      order_currency: currency,
      customer_details: {
        customer_id: customerId,
        customer_phone: customerPhone.length === 10 ? customerPhone : '9999999999',
        customer_name: String(customer.name || 'Patient').slice(0, 100),
        customer_email: String(customer.email || 'care@drhairindia.com').slice(0, 100),
      },
      order_meta: {
        return_url: metadata?.return_url || `https://drhairindia.com/payment/callback?order_id=${encodeURIComponent(orderId)}`,
        // Cashfree only sends payment lifecycle webhooks when a notify URL is
        // present on the order or the dashboard has an endpoint configured.
        // Keep the URL deployment-specific so sandbox events never default to
        // a production data store.
        notify_url: metadata?.notify_url || this.webhookUrl || undefined,
      },
      order_note: String(metadata?.reason || `Order ${orderId}`).slice(0, 200),
      order_tags: {
        source: 'app',
        ...Object.fromEntries(
          Object.entries(metadata || {})
            .filter(([k, v]) => /^[a-zA-Z0-9_]{1,30}$/.test(k) && v != null)
          .slice(0, 9)
            .map(([k, v]) => [k, String(v).slice(0, 100)]),
        ),
      },
    };
    const digest = crypto.createHash('sha256').update(String(orderId)).digest('hex');
    const cashfreeIdempotencyKey = [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `4${digest.slice(13, 16)}`,
      `a${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join('-');

    let response;
    try {
      response = await this.fetch(`${this.getBaseUrl()}/orders`, {
        method: 'POST',
        headers: {
          'x-client-id': this.effectiveAppId,
          'x-client-secret': this.effectiveSecretKey,
          'x-api-version': this.apiVersion,
          'x-idempotency-key': cashfreeIdempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      // Keep provider diagnostics useful in Worker logs without exposing request
      // headers, payload, or Cashfree credentials.
      console.error('[Cashfree] order request failed', {
        name: error?.name || 'Error',
        message: String(error?.message || '').slice(0, 200),
      });
      throw new BadGatewayError('Could not reach Cashfree to create a payment session.');
    }

    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.payment_session_id) {
      throw new BadGatewayError(
        result?.message || 'Cashfree could not create the payment session. Check API credentials.',
      );
    }

    return {
      intentId: result.order_id || String(orderId),
      orderId: result.order_id || String(orderId),
      cf_order_id: result.cf_order_id || null,
      payment_session_id: result.payment_session_id,
      amount: Math.round(Number(result.order_amount || amount) * 100),
      amountFormatted: Number(result.order_amount || amount),
      currency: result.order_currency || currency,
      status: result.order_status || 'ACTIVE',
      gateway: 'cashfree',
      environment: this.environment,
      customer: {
        name: customer.name || '',
        email: customer.email || '',
        phone: customerPhone,
      },
    };
  }

  verifyPaymentSignature({ orderId, paymentId, signature }) {
    const secret = this.effectiveSecretKey;
    if (!secret || !orderId || !signature) {
      return false;
    }
    const dataToSign = paymentId ? `${orderId}|${paymentId}` : String(orderId);
    const expected = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'));
    } catch {
      return signature === expected;
    }
  }

  verifyWebhookSignature({ rawBody, timestamp, signature }) {
    const secret = this.effectiveSecretKey;
    if (!secret || !signature) return false;
    const bodyStr = Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : typeof rawBody === 'string'
        ? rawBody
        : JSON.stringify(rawBody || {});

    // Cashfree computes a Base64 HMAC-SHA256 of (timestamp + raw request body).
    const data = timestamp ? `${timestamp}${bodyStr}` : bodyStr;
    const expectedBase64 = crypto
      .createHmac('sha256', secret)
      .update(data)
      .digest('base64');
    const cleanSig = String(signature).trim();
    try {
      const sigBuf = Buffer.from(cleanSig, 'utf8');
      const b64Buf = Buffer.from(expectedBase64, 'utf8');
      if (sigBuf.length === b64Buf.length && crypto.timingSafeEqual(sigBuf, b64Buf)) return true;
    } catch {}

    return false;
  }

  async getPaymentOrder(orderId) {
    this.assertConfigured();
    if (!orderId) throw new BadRequestError('A Cashfree order ID is required.');
    return this.request(`/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
  }

  async getOrderPayments(orderId) {
    this.assertConfigured();
    if (!orderId) throw new BadRequestError('A Cashfree order ID is required.');
    const payments = await this.request(`/orders/${encodeURIComponent(orderId)}/payments`, { method: 'GET' });
    return Array.isArray(payments) ? payments : [];
  }

  async verifyCapturedPayment({ orderId, paymentId, expectedOrderId, expectedAmount, currency = 'INR' }) {
    this.assertConfigured();
    const targetOrderId = orderId || expectedOrderId;
    if (!targetOrderId) throw new BadRequestError('Order ID is required to verify Cashfree payment.');

    const order = await this.getPaymentOrder(targetOrderId);
    if (order.order_id !== targetOrderId && order.order_id !== expectedOrderId) {
      throw new BadRequestError('Cashfree payment does not belong to this order.');
    }

    if (Number(order.order_amount) !== Number(expectedAmount)) {
      throw new BadRequestError('Cashfree payment amount does not match this order.');
    }

    if (order.order_currency && order.order_currency !== currency) {
      throw new BadRequestError('Cashfree payment currency does not match this order.');
    }

    const orderStatus = String(order.order_status || '').toUpperCase();
    const payments = await this.getOrderPayments(targetOrderId);
    const successfulPayment = payments.find((payment) =>
      String(payment.payment_status).toUpperCase() === 'SUCCESS' &&
      (!paymentId || String(paymentId) === String(targetOrderId) ||
        String(payment.cf_payment_id || payment.payment_id) === String(paymentId)));
    if (orderStatus !== 'PAID' || !successfulPayment) {
      throw new BadRequestError(`Cashfree payment is not paid (current status: ${orderStatus || 'PENDING'}).`);
    }
    if (Number(successfulPayment.payment_amount) !== Number(expectedAmount) ||
        (successfulPayment.payment_currency && successfulPayment.payment_currency !== currency)) {
      throw new BadRequestError('Cashfree payment amount or currency does not match this order.');
    }
    return {
      ...order,
      order_status: 'PAID',
      payment: successfulPayment,
      transaction_id: successfulPayment.cf_payment_id || successfulPayment.payment_id,
    };
  }

  async refundCapturedPayment({ orderId, paymentId, amount, reason = 'Customer refund', refundId = null }) {
    this.assertConfigured();
    if (!orderId && !paymentId) throw new BadRequestError('orderId is required for Cashfree refund.');
    const targetOrderId = orderId || paymentId;
    const refId = refundId || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const body = {
      refund_amount: Number(amount),
      refund_id: refId,
      refund_note: String(reason).slice(0, 150),
      refund_speed: 'STANDARD',
    };

    const refund = await this.request(`/orders/${encodeURIComponent(targetOrderId)}/refunds`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      id: refund.cf_refund_id || refund.refund_id || refId,
      refund_id: refund.refund_id || refId,
      status: ({
        SUCCESS: 'processed',
        PROCESSED: 'processed',
        PENDING: 'pending',
        FAILED: 'failed',
      })[String(refund.refund_status || '').toUpperCase()] || 'pending',
      amount: refund.refund_amount || amount,
      currency: refund.refund_currency || 'INR',
    };
  }

  async processRefund({ orderId, transactionId, amount, reason = 'Customer refund', receipt }) {
    return this.refundCapturedPayment({
      orderId: orderId || transactionId,
      paymentId: transactionId,
      amount,
      reason,
      refundId: receipt,
    });
  }

  async request(path, options) {
    let response;
    try {
      response = await this.fetch(`${this.getBaseUrl()}${path}`, {
        ...options,
        headers: {
          'x-client-id': this.effectiveAppId,
          'x-client-secret': this.effectiveSecretKey,
          'x-api-version': this.apiVersion,
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new BadGatewayError('Cashfree did not respond. Check provider connectivity before retrying.');
    }

    const result = await response.json().catch(() => null);
    if (!response.ok || !result) {
      throw new BadGatewayError(
        result?.message || `Cashfree request failed with status ${response.status}.`,
      );
    }
    return result;
  }
}
