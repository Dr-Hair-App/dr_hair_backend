import { BadRequestError, ForbiddenError, NotFoundError } from '../../../shared/errors/index.js';
import { createHash } from 'node:crypto';

export class VerifyPaymentUseCase {
  constructor({ orderRepository, paymentGatewayService, auditEventRepository }) {
    this.orderRepository = orderRepository;
    this.paymentGatewayService = paymentGatewayService;
    this.auditEventRepository = auditEventRepository;
  }

  async execute({ orderId, paymentId, paymentSignature, userId = null, isWebhook = false, actor = null }) {
    const cleanOrderId = String(orderId).trim();
    const order = await this.orderRepository.findById(cleanOrderId);
    if (!order) {
      throw new NotFoundError(`Order not found: ${cleanOrderId}`);
    }
    if (userId && String(order.user_id) !== String(userId).trim()) {
      throw new ForbiddenError('You can only verify payments for your own orders');
    }

    if (order.payment.payment_status === 'Paid') {
      return order; // Already verified idempotent
    }

    if (order.payment.gateway !== 'cashfree' || !order.payment.payment_intent_id) {
      throw new BadRequestError('This order does not have an online payment to verify');
    }

    if (!isWebhook && this.paymentGatewayService.provider !== 'cashfree') {
      const isValid = this.paymentGatewayService.verifyPaymentSignature({
        orderId: order.payment.payment_intent_id,
        paymentId,
        signature: paymentSignature,
      });

      if (!isValid) {
        throw new BadRequestError('Invalid payment verification signature from gateway');
      }
    }

    const verified = await this.paymentGatewayService.verifyCapturedPayment({
      orderId: order.payment.payment_intent_id,
      paymentId,
      expectedOrderId: order.payment.payment_intent_id,
      expectedAmount: order.pricing.total,
    });
    paymentId = verified.transaction_id || verified.payment?.cf_payment_id || paymentId || order.payment.payment_intent_id;

    const updated = await this.orderRepository.markPaymentCaptured({
      orderId: cleanOrderId,
      paymentIntentId: order.payment.payment_intent_id,
      paymentId,
      paymentSignature,
    });
    if (!updated) {
      const latest = await this.orderRepository.findById(cleanOrderId);
      if (latest?.payment.payment_status === 'Paid' && latest.payment.transaction_id === paymentId) return latest;
      if (latest?.fulfillment.status === 'Cancelled' || latest?.fulfillment.status === 'Refunded') {
        return this.refundPaymentForCancelledOrder(latest, paymentId);
      }
      throw new BadRequestError('The order changed while confirming payment. Refresh the order before retrying.');
    }

    await this.orderRepository.appendPaymentAttempt?.(cleanOrderId, {
      payment_id: paymentId,
      status: 'captured',
      amount: order.pricing.total,
      currency: 'INR',
      attempted_at: new Date().toISOString(),
    });

    if (this.auditEventRepository) {
      await this.auditEventRepository.record({
        actor: actor || { id: order.user_id, type: 'patient' },
        action: 'commerce.payment.verified',
        target: { id: cleanOrderId, type: 'order' },
        metadata: {
          transactionId: paymentId,
          amount: order.pricing.total,
          isWebhook,
        },
      });
    }

    return updated;
  }

  async refundPaymentForCancelledOrder(order, paymentId) {
    const total = Number(order.pricing.total);
    const refundHistory = [...(order.payment.refunds || [])];
    if (order.payment.refund_status === 'processed' && Number(order.payment.refund_amount) >= total) return order;
    if (order.payment.refund_status === 'pending' && Number(order.payment.refund_pending_amount) >= total) return order;

    const receipt = `drh_late_${createHash('sha256').update(`${order.order_id}:${paymentId}`).digest('hex').slice(0, 28)}`;
    const refund = await this.paymentGatewayService.refundCapturedPayment({
      paymentId,
      amount: total,
      reason: `Late capture after cancellation for ${order.order_id}`,
      receipt,
    });
    if (refund.status === 'failed') throw new BadRequestError('Payment was captured after order cancellation and the automatic refund failed. Contact support with the payment reference.');
    const refundRecord = {
      id: refund.id,
      amount: total,
      currency: 'INR',
      status: refund.status,
      updated_at: new Date().toISOString(),
    };
    const existingIndex = refundHistory.findIndex((entry) => String(entry.id) === String(refund.id));
    if (existingIndex >= 0) refundHistory[existingIndex] = { ...refundHistory[existingIndex], ...refundRecord };
    else refundHistory.push(refundRecord);
    const processed = refund.status === 'processed';
    const updated = await this.orderRepository.update(order.order_id, {
      payment: {
        payment_status: processed ? 'Refunded' : 'Paid',
        gateway_status: 'captured',
        transaction_id: paymentId,
        refund_id: refund.id,
        refund_status: refund.status,
        refund_amount: processed ? Math.min(total, Number(order.payment.refund_amount) + total) : Number(order.payment.refund_amount) || 0,
        refund_pending_amount: processed ? 0 : total,
        ...(processed ? { refunded_at: new Date().toISOString() } : {}),
        refunds: refundHistory,
      },
    });
    updated.addTimelineEvent(`Late Cashfree capture refunded after order cancellation (${refund.id})`);
    await this.orderRepository.update(order.order_id, { timeline: updated.timeline });
    return updated;
  }
}
