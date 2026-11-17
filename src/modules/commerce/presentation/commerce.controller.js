import { sendSuccess, sendCreated } from '../../../shared/utils/response.js';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../../shared/errors/index.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sendPushNotification } from '../../notifications/infrastructure/FirebaseAdminMessaging.js';

function manualTracking(fulfillment) {
  const trackUrl = String(fulfillment.tracking_url || '').trim();
  if (!trackUrl || !/^https:\/\//i.test(trackUrl)) return null;
  return {
    awb_code: String(fulfillment.tracking_number || ''),
    courier: String(fulfillment.courier || 'Courier'),
    current_status: String(fulfillment.status || 'Shipped').toUpperCase(),
    current_status_id: null,
    estimated_delivery: '',
    origin: '',
    destination: '',
    track_url: trackUrl,
    updated_at: String(fulfillment.shipped_at || ''),
    events: [],
    tracking_mode: 'external',
  };
}

function savedCarrierTracking(fulfillment, targetAwb = fulfillment.awb_code) {
  const events = (Array.isArray(fulfillment.shiprocket_events) ? fulfillment.shiprocket_events : [])
    .filter((event) => !event.awb_code || event.awb_code === targetAwb);
  if (!events.length) return null;
  const latest = events.at(-1);
  return {
    awb_code: String(fulfillment.awb_code || fulfillment.tracking_number || ''),
    courier: String(fulfillment.courier || 'Shiprocket courier'),
    current_status: String(latest.status || (targetAwb === fulfillment.shiprocket_return_awb ? fulfillment.shiprocket_return_status : fulfillment.shiprocket_status) || fulfillment.status),
    current_status_id: latest.status_code ?? null,
    estimated_delivery: String(fulfillment.shiprocket_eta || ''),
    origin: '',
    destination: fulfillment.shipping_address?.city || '',
    track_url: '',
    updated_at: String(latest.timestamp || ''),
    events: events.slice().reverse().map((event) => ({
      date: String(event.timestamp || ''),
      status: String(event.status || ''),
      activity: String(event.activity || event.status || ''),
      location: String(event.location || ''),
    })),
    tracking_mode: 'webhook',
    is_stale_provider_fallback: true,
  };
}

export class CommerceController {
  constructor({
    addressRepository,
    inventoryRepository,
    orderRepository,
    providerWebhookEventRepository,
    notificationRepository,
    deviceTokenRepository,
    couponRepository,
    checkoutUseCase,
    getShippingQuoteUseCase,
    verifyPaymentUseCase,
    cancelOrderUseCase,
    refundOrderUseCase,
    updateFulfillmentUseCase,
    createShiprocketShipmentUseCase,
    retryShiprocketPickupUseCase,
    createShiprocketReturnUseCase,
    appointmentController,
    shiprocketService,
    paymentGatewayService,
  }) {
    this.addressRepository = addressRepository;
    this.inventoryRepository = inventoryRepository;
    this.orderRepository = orderRepository;
    this.providerWebhookEventRepository = providerWebhookEventRepository;
    this.notificationRepository = notificationRepository;
    this.deviceTokenRepository = deviceTokenRepository;
    this.couponRepository = couponRepository;
    this.checkoutUseCase = checkoutUseCase;
    this.getShippingQuoteUseCase = getShippingQuoteUseCase;
    this.verifyPaymentUseCase = verifyPaymentUseCase;
    this.cancelOrderUseCase = cancelOrderUseCase;
    this.refundOrderUseCase = refundOrderUseCase;
    this.updateFulfillmentUseCase = updateFulfillmentUseCase;
    this.createShiprocketShipmentUseCase = createShiprocketShipmentUseCase;
    this.retryShiprocketPickupUseCase = retryShiprocketPickupUseCase;
    this.createShiprocketReturnUseCase = createShiprocketReturnUseCase;
    this.appointmentController = appointmentController;
    this.shiprocketService = shiprocketService;
    this.paymentGatewayService = paymentGatewayService;
  }

  async notifyPatient({ userId, title, body, entityId, type = 'order' }) {
    if (!this.notificationRepository || !userId) return;
    try {
      const notification = await this.notificationRepository.create({
        userId: Number(userId),
        title,
        body,
        type,
        destination: { type: 'screen', screen: type === 'appointment' ? 'clinic_appointment' : 'orders', entityId },
        data: { entity_id: entityId, destination_type: 'screen', screen: type === 'appointment' ? 'clinic_appointment' : 'orders' },
      });
      const tokens = await this.deviceTokenRepository?.listByUserId(userId) || [];
      await Promise.all(tokens.map(({ token }) => sendPushNotification({
        token,
        title,
        body,
        data: {
          notification_id: notification.id,
          destination_type: 'screen',
          screen: type === 'appointment' ? 'clinic_appointment' : 'orders',
          entity_id: entityId,
        },
      }).catch(() => {})));
    } catch {
      // Provider event settlement must not fail because notification delivery is unavailable.
    }
  }

  // --- PATIENT ADDRESSES ---
  async listAddresses(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const items = await this.addressRepository.listByUserId(userId);
      return sendSuccess(res, items.map((a) => a.toJSON()), 'Delivery addresses retrieved');
    } catch (err) {
      next(err);
    }
  }

  async createAddress(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const created = await this.addressRepository.create(userId, req.body);
      return sendCreated(res, created.toJSON(), 'Delivery address saved');
    } catch (err) {
      next(err);
    }
  }

  async updateAddress(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const { addressId } = req.params;
      const updated = await this.addressRepository.update(userId, addressId, req.body);
      return sendSuccess(res, updated.toJSON(), 'Delivery address updated');
    } catch (err) {
      next(err);
    }
  }

  async deleteAddress(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const { addressId } = req.params;
      await this.addressRepository.delete(userId, addressId);
      return sendSuccess(res, { deleted: true }, 'Delivery address deleted');
    } catch (err) {
      next(err);
    }
  }

  async setDefaultAddress(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const { addressId } = req.params;
      const updated = await this.addressRepository.setDefault(userId, addressId);
      return sendSuccess(res, updated.toJSON(), 'Default address updated');
    } catch (err) {
      next(err);
    }
  }

  // --- CHECKOUT & PAYMENTS ---
  async getShippingQuote(req, res, next) {
    try {
      const userId = req.user?.id;
      const body = req.body || {};
      if ((body.address_id || body.addressId) && !userId) throw new UnauthorizedError('Sign in to quote a saved delivery address.');
      const quote = await this.getShippingQuoteUseCase.execute({
        userId,
        addressId: body.address_id || body.addressId || null,
        deliveryPincode: body.delivery_pincode || body.deliveryPincode || null,
        items: body.items || [],
        paymentGateway: body.payment_gateway || body.paymentGateway || 'razorpay',
      });
      return sendSuccess(res, quote, 'Delivery quote retrieved from available Shiprocket couriers');
    } catch (err) {
      next(err);
    }
  }

  async handleCarrierWebhook(req, res, next) {
    try {
      const configuredSecret = String(process.env.SHIPROCKET_WEBHOOK_SECRET || '');
      const supplied = String(req.get('x-api-key') || '');
      const expectedBytes = Buffer.from(configuredSecret);
      const suppliedBytes = Buffer.from(supplied);
      if (!configuredSecret || expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
        return res.status(401).json({ success: false, message: 'Webhook authentication failed.' });
      }
      const body = req.body || {};
      const awb = String(body.awb || body.awb_code || body.awbCode || body.tracking_number || '').trim();
      if (!awb) throw new BadRequestError('Carrier update did not include an AWB.');
      const order = await this.orderRepository.findByAwb(awb);
      if (!order) return sendSuccess(res, { accepted: true, matched: false }, 'Carrier update accepted');
      const rawStatus = String(body.current_status || body.shipment_status || body.status || body.activity || '').trim();
      // Shiprocket's payload distinguishes the current scan from the overall
      // shipment status. Prefer the scan code for customer-facing state mapping.
      const statusCode = Number(body.current_status_id || body.shipment_status_id || body.status_code);
      const eventId = String(body.event_id || body.id || body.shipment_status_history_id || '').trim()
        || createHash('sha256').update(JSON.stringify(body)).digest('hex');
      const events = order.fulfillment.shiprocket_events || [];
      if (events.some((event) => event.event_id === eventId)) return sendSuccess(res, { accepted: true, duplicate: true }, 'Duplicate carrier update ignored');
      const event = {
        event_id: eventId,
        awb_code: awb,
        status: rawStatus,
        status_code: Number.isFinite(statusCode) ? statusCode : null,
        activity: String(body.activity || rawStatus),
        location: String(body.location || body.current_location || ''),
        timestamp: String(body.current_timestamp || body.status_date || body.updated_at || body.event_time || new Date().toISOString()),
      };
      const isReturnShipment = awb === order.fulfillment.shiprocket_return_awb;
      const mappedStatus = isReturnShipment || order.fulfillment.status === 'Return requested'
        ? order.fulfillment.status
        : statusCode === 7 || /delivered/i.test(rawStatus) ? 'Delivered'
        : [6, 17, 18, 19].includes(statusCode) || /shipped|transit|out for delivery|out for pickup/i.test(rawStatus) ? 'Shipped'
          : order.fulfillment.status;
      const updated = await this.orderRepository.update(order.order_id, {
        fulfillment: {
          ...(mappedStatus !== order.fulfillment.status ? { status: mappedStatus } : {}),
          ...(isReturnShipment ? { shiprocket_return_status: rawStatus || order.fulfillment.shiprocket_return_status } : {
            shiprocket_status: rawStatus || order.fulfillment.shiprocket_status,
            shiprocket_pickup_status: [13, 15, 19, 20].includes(statusCode) ? rawStatus : order.fulfillment.shiprocket_pickup_status,
            ...(mappedStatus === 'Delivered' ? { delivered_at: event.timestamp } : {}),
          }),
          shiprocket_events: [...events, event].slice(-100),
        },
      });
      if (!isReturnShipment && mappedStatus !== order.fulfillment.status) {
        updated.addTimelineEvent(`Carrier update: ${rawStatus || mappedStatus}`);
        await this.orderRepository.update(order.order_id, { timeline: updated.timeline });
        if (mappedStatus === 'Shipped' || mappedStatus === 'Delivered') {
          await this.notifyPatient({
            userId: order.user_id,
            title: mappedStatus === 'Delivered' ? 'Order delivered' : 'Order shipped',
            body: mappedStatus === 'Delivered'
              ? `Your order ${order.order_id} has been delivered.`
              : `Your order ${order.order_id} is with the courier. Tracking is available in the app.`,
            entityId: order.order_id,
          });
        }
      }
      return sendSuccess(res, { accepted: true, matched: true }, 'Carrier update saved');
    } catch (err) {
      next(err);
    }
  }

  async checkout(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const shippingQuoteId = req.body.shipping_quote_id || req.body.shippingQuoteId;
      if (!shippingQuoteId) throw new BadRequestError('Refresh the live delivery quote before placing this order.');

      const idempotencyKey =
        req.headers['idempotency-key'] ||
        req.headers['x-idempotency-key'] ||
        req.body?.idempotency_key ||
        req.body?.idempotencyKey ||
        null;

      const result = await this.checkoutUseCase.execute({
        userId,
        customer: req.body.customer || {
          name: req.user.name || '',
          email: req.user.email || '',
          phone: req.user.phone || '',
        },
        items: req.body.items || [],
        addressId: req.body.address_id || req.body.addressId || null,
        shippingAddress: req.body.shipping_address || req.body.shippingAddress || null,
        couponCode: req.body.coupon_code || req.body.couponCode || null,
        paymentGateway: req.body.payment_gateway || req.body.paymentGateway || 'cod',
        shippingQuoteId,
        idempotencyKey,
        actor: { id: userId, type: 'patient' },
      });

      if (!result.idempotentReplay && result.order?.payment?.gateway === 'cod') {
        await this.notifyPatient({
          userId,
          title: 'Order received',
          body: `Your order ${result.order.order_id} has been placed. We’ll update you as it moves through delivery.`,
          entityId: result.order.order_id,
        });
      }

      return sendCreated(res, {
        order: result.order.toJSON(),
        paymentIntent: result.paymentIntent,
        idempotentReplay: result.idempotentReplay,
      }, result.idempotentReplay ? 'Order replayed from idempotency key' : 'Order created successfully');
    } catch (err) {
      next(err);
    }
  }

  async verifyPayment(req, res, next) {
    try {
      const { order_id, orderId, payment_id, paymentId, payment_signature, signature } = req.body;
      const cleanOrderId = order_id || orderId;
      const cleanPaymentId = payment_id || paymentId;
      const cleanSignature = payment_signature || signature;

      if (!cleanOrderId || !cleanPaymentId) {
        throw new BadRequestError('Order ID and Payment ID are required');
      }

      const before = await this.orderRepository.findById(cleanOrderId);
      const updated = await this.verifyPaymentUseCase.execute({
        orderId: cleanOrderId,
        paymentId: cleanPaymentId,
        paymentSignature: cleanSignature,
        userId: req.user?.id,
        isWebhook: false,
        actor: req.user ? { id: req.user.id, type: req.user.role ? 'admin' : 'patient' } : null,
      });

      if (before?.payment?.payment_status !== 'Paid' && updated.payment?.payment_status === 'Paid') {
        await this.notifyPatient({
          userId: updated.user_id,
          title: 'Payment confirmed',
          body: `Payment for order ${updated.order_id} was received. We’ll notify you when it ships.`,
          entityId: updated.order_id,
        });
      }

      return sendSuccess(res, updated.toJSON(), 'Payment verified successfully');
    } catch (err) {
      next(err);
    }
  }

  async reconcilePatientPayment(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const order = await this.orderRepository.findById(req.params.orderId);
      if (!order) throw new NotFoundError('Order not found.');
      if (String(order.user_id) !== String(userId)) throw new ForbiddenError('You can only check payment status for your own orders.');
      if (order.payment.payment_status === 'Paid') {
        return sendSuccess(res, { order: order.toJSON(), paid: true, can_retry: false, attempts: [] }, 'Payment is confirmed');
      }
      if (order.payment.gateway !== 'razorpay' || !order.payment.payment_intent_id) {
        return sendSuccess(res, { order: order.toJSON(), paid: false, can_retry: false, attempts: [] }, 'This order has no pending Razorpay payment');
      }
      const attempts = await this.paymentGatewayService.getOrderPayments(order.payment.payment_intent_id);
      const settleable = attempts.find((attempt) => ['captured', 'authorized'].includes(String(attempt.status)));
      if (settleable?.id) {
        const settled = await this.verifyPaymentUseCase.execute({
          orderId: order.order_id,
          paymentId: settleable.id,
          isWebhook: true,
          actor: { id: 'patient-payment-recovery', type: 'system' },
        });
        const paid = settled.payment.payment_status === 'Paid' && !['Cancelled', 'Refunded'].includes(settled.fulfillment.status);
        return sendSuccess(res, {
          order: settled.toJSON(),
          paid,
          can_retry: false,
          resolved: !paid && ['Cancelled', 'Refunded'].includes(settled.fulfillment.status),
          attempts: attempts.map(({ id, status }) => ({ id, status })),
        }, paid ? 'Payment is confirmed' : 'Payment state is being reconciled');
      }
      const canRetry = !['Cancelled', 'Refunded'].includes(order.fulfillment.status) &&
        (attempts.length === 0 || attempts.every((attempt) => ['failed', 'refunded'].includes(String(attempt.status))));
      return sendSuccess(res, {
        order: order.toJSON(),
        paid: false,
        can_retry: canRetry,
        resolved: ['Cancelled', 'Refunded'].includes(order.fulfillment.status),
        attempts: attempts.map(({ id, status }) => ({ id, status })),
      }, canRetry ? 'No successful payment attempt was found' : 'A payment attempt is still being processed');
    } catch (error) { next(error); }
  }

  async handlePaymentWebhook(req, res, next) {
    try {
      const signature = req.headers['x-razorpay-signature'];
      const payload = req.body;

      const isValid = this.paymentGatewayService.verifyWebhookSignature({
        rawBody: req.rawBody,
        signature,
      });

      if (!isValid) {
        throw new BadRequestError('Invalid webhook signature');
      }

      if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') {
        throw new BadRequestError('Invalid Razorpay webhook payload');
      }
      const event = payload.event;
      const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(payload));
      const eventId = String(req.headers?.['x-razorpay-event-id'] || '').trim()
        || createHash('sha256').update(rawBody).digest('hex');
      let claimed = false;
      if (this.providerWebhookEventRepository) {
        const claim = await this.providerWebhookEventRepository.claim({
          provider: 'razorpay',
          eventId,
          eventType: event,
          payloadHash: createHash('sha256').update(rawBody).digest('hex'),
        });
        if (!claim.claimed) {
          return sendSuccess(res, { received: true, duplicate: true }, 'Duplicate webhook event ignored');
        }
        claimed = true;
      }

      try {
        if (event === 'payment.captured' || event === 'order.paid') {
          const paymentEntity = payload.payload?.payment?.entity || {};
          const orderId = paymentEntity.notes?.app_order_id || paymentEntity.notes?.order_id;
          const paymentId = paymentEntity.id;

          if (orderId) {
            if (String(orderId).startsWith('APT-')) {
              if (!this.appointmentController?.recoverCapturedPaymentFromWebhook) {
                throw new BadRequestError('Appointment payment recovery is not configured.');
              }
              await this.appointmentController.recoverCapturedPaymentFromWebhook(paymentEntity);
            } else {
              const before = await this.orderRepository?.findById?.(orderId);
              await this.verifyPaymentUseCase.execute({
                orderId,
                paymentId,
                isWebhook: true,
                actor: { id: 'webhook', type: 'system' },
              });
              const settled = await this.orderRepository?.findById?.(orderId);
              if (before?.payment?.payment_status !== 'Paid' && settled?.payment?.payment_status === 'Paid') {
                await this.notifyPatient({
                  userId: settled.user_id,
                  title: 'Payment confirmed',
                  body: `Payment for order ${settled.order_id} was received. We’ll notify you when it ships.`,
                  entityId: settled.order_id,
                });
              }
            }
          }
        }
        if (event === 'payment.failed') {
          const paymentEntity = payload.payload?.payment?.entity || {};
          const orderId = String(paymentEntity.notes?.app_order_id || paymentEntity.notes?.order_id || '').trim();
          const order = orderId && !orderId.startsWith('APT-') ? await this.orderRepository.findById(orderId) : null;
          if (order && (!paymentEntity.order_id || order.payment.payment_intent_id === paymentEntity.order_id)) {
            await this.orderRepository.appendPaymentAttempt?.(order.order_id, {
              payment_id: paymentEntity.id,
              status: 'failed',
              amount: Number(paymentEntity.amount) / 100,
              currency: paymentEntity.currency || 'INR',
              method: paymentEntity.method,
              failure_code: paymentEntity.error_code || paymentEntity.error_reason || 'payment_attempt_failed',
              attempted_at: paymentEntity.created_at ? new Date(Number(paymentEntity.created_at) * 1000).toISOString() : new Date().toISOString(),
            });
            const updated = await this.orderRepository.update(order.order_id, {
              payment: {
                gateway_status: 'failed_attempt',
                last_failed_at: paymentEntity.created_at ? new Date(Number(paymentEntity.created_at) * 1000).toISOString() : new Date().toISOString(),
                last_failure_code: String(paymentEntity.error_code || paymentEntity.error_reason || 'payment_attempt_failed').slice(0, 80),
              },
            });
            updated.addTimelineEvent('Razorpay payment attempt failed; order remains available for payment retry');
            await this.orderRepository.update(order.order_id, { timeline: updated.timeline });
            await this.notifyPatient({
              userId: order.user_id,
              title: 'Payment not completed',
              body: `Payment for order ${order.order_id} did not go through. You can retry it from your orders.`,
              entityId: order.order_id,
            });
          }
        }
        if (['refund.created', 'refund.processed', 'refund.failed'].includes(event)) {
          const refund = payload.payload?.refund?.entity || {};
          const order = await this.orderRepository.findByPaymentTransactionId(refund.payment_id);
          if (!order) {
            if (!this.appointmentController?.recoverRefundEventFromWebhook) {
              throw new NotFoundError('Razorpay refund does not match a stored order or appointment payment.');
            }
            await this.appointmentController.recoverRefundEventFromWebhook(refund, event);
          } else {
          const refundId = String(refund.id || '').trim();
          const amount = Number(refund.amount) / 100;
          const currency = String(refund.currency || 'INR').toUpperCase();
          if (!refundId || !Number.isFinite(amount) || amount <= 0 || currency !== 'INR') throw new BadRequestError('Razorpay refund event is missing a valid INR refund reference or amount.');
          const history = [...(order.payment.refunds || [])];
          if (history.length === 0 && order.payment.refund_id && Number(order.payment.refund_amount) > 0) {
            history.push({ id: order.payment.refund_id, amount: Number(order.payment.refund_amount), status: order.payment.refund_status || 'processed' });
          }
          const existingIndex = history.findIndex((item) => String(item.id) === refundId);
          const existing = existingIndex >= 0 ? history[existingIndex] : null;
          const incomingStatus = event === 'refund.created' ? 'pending' : event === 'refund.processed' ? 'processed' : 'failed';
          const status = existing?.status === 'processed' ? 'processed' : incomingStatus;
          const refundRecord = { id: refundId, amount, currency, status, updated_at: new Date().toISOString() };
          if (existingIndex >= 0) history[existingIndex] = { ...existing, ...refundRecord };
          else history.push(refundRecord);
          const refundedTotal = history.filter((item) => item.status === 'processed').reduce((sum, item) => sum + Number(item.amount || 0), 0);
          const pendingTotal = history.filter((item) => item.status === 'pending').reduce((sum, item) => sum + Number(item.amount || 0), 0);
          if (refundedTotal + pendingTotal > Number(order.pricing.total) + 0.01) {
            throw new BadRequestError('Razorpay refund events exceed the recorded order total.');
          }
          const fullRefund = refundedTotal >= Number(order.pricing.total);
          const paymentStatus = fullRefund ? 'Refunded' : refundedTotal > 0 ? 'Partially refunded' : order.payment.payment_status;
          const refundStatus = pendingTotal > 0 ? 'pending' : refundedTotal > 0 ? 'processed' : 'failed';
          const updated = await this.orderRepository.update(order.order_id, {
            payment: {
              refunds: history,
              refund_id: refundId,
              refund_amount: refundedTotal,
              refund_pending_amount: pendingTotal,
              refund_status: refundStatus,
              payment_status: paymentStatus,
              ...(status === 'processed' ? { refunded_at: new Date().toISOString() } : {}),
            },
            ...(fullRefund ? { fulfillment: { status: 'Refunded' } } : {}),
          });
          if (existing?.status !== status) {
            updated.addTimelineEvent(`Razorpay refund ${status}: ₹${amount} (${refundId})`);
            await this.orderRepository.update(order.order_id, { timeline: updated.timeline });
            if (status === 'processed' || status === 'failed') {
              await this.notifyPatient({
                userId: order.user_id,
                title: status === 'processed' ? 'Refund processed' : 'Refund needs attention',
                body: status === 'processed'
                  ? `A refund of ₹${amount} for order ${order.order_id} has been processed by the payment provider.`
                  : `The payment provider could not complete the refund for order ${order.order_id}. Please contact support.`,
                entityId: order.order_id,
              });
            }
          }
          }
        }
        if (claimed) await this.providerWebhookEventRepository.markProcessed({ provider: 'razorpay', eventId });
      } catch (error) {
        if (claimed) {
          await this.providerWebhookEventRepository.markFailed({
            provider: 'razorpay',
            eventId,
            errorCode: error?.code || error?.name || 'processing_failed',
          }).catch(() => {});
        }
        throw error;
      }
      return sendSuccess(res, { received: true }, 'Webhook processed');
    } catch (err) {
      next(err);
    }
  }

  async reconcilePendingCheckouts(req, res, next) {
    try {
      const configuredSecret = String(process.env.CRON_SECRET || '');
      const authorization = String(req.get?.('authorization') || req.headers?.authorization || '');
      const suppliedSecret = authorization.replace(/^Bearer\s+/i, '').trim();
      const expected = Buffer.from(configuredSecret);
      const supplied = Buffer.from(suppliedSecret);
      if (!configuredSecret) return res.status(503).json({ success: false, message: 'Checkout reconciliation is not enabled.' });
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        return res.status(401).json({ success: false, message: 'Job authentication failed.' });
      }

      const summary = await this._reconcilePendingCheckouts();
      return sendSuccess(res, { ...summary, pending_limit: 50 }, 'Pending Razorpay checkouts reconciled');
    } catch (err) {
      next(err);
    }
  }

  async reconcilePendingCheckoutsScheduled() {
    return this._reconcilePendingCheckouts();
  }

  async _reconcilePendingCheckouts() {

      const rawTtl = Number(process.env.PENDING_CHECKOUT_EXPIRY_MINUTES);
      const ttlMinutes = Number.isFinite(rawTtl) ? Math.min(240, Math.max(15, Math.floor(rawTtl))) : 45;
      const olderThan = new Date(Date.now() - ttlMinutes * 60 * 1000);
      const candidates = await this.orderRepository.listForCheckoutReconciliation({ olderThan, limit: 50 });
      const summary = { checked: 0, settled: 0, cancelled: 0, inventory_released: 0, deferred: 0, errors: 0 };

      for (const order of candidates) {
        summary.checked += 1;
        try {
          if (order.fulfillment.status === 'Cancelled' && order.fulfillment.inventory_release_status === 'pending') {
            await this.inventoryRepository.releaseStock(order.items, order.order_id);
            await this.orderRepository.markInventoryReleaseComplete(order.order_id);
            summary.inventory_released += 1;
            continue;
          }
          if (!order.payment.payment_intent_id || !this.paymentGatewayService) {
            summary.deferred += 1;
            continue;
          }

          const [providerOrder, attempts] = await Promise.all([
            this.paymentGatewayService.getPaymentOrder(order.payment.payment_intent_id),
            this.paymentGatewayService.getOrderPayments(order.payment.payment_intent_id),
          ]);
          const captured = attempts.find((attempt) => attempt.status === 'captured');
          if (captured?.id) {
            const settled = await this.verifyPaymentUseCase.execute({
              orderId: order.order_id,
              paymentId: captured.id,
              isWebhook: true,
              actor: { id: 'checkout-reconciliation', type: 'system' },
            });
            if (settled.payment.payment_status === 'Paid') summary.settled += 1;
            else summary.deferred += 1;
            continue;
          }

          const allAttemptsFailed = attempts.length > 0 && attempts.every((attempt) => ['failed', 'refunded'].includes(String(attempt.status)));
          const noAttemptYet = attempts.length === 0 && providerOrder.status === 'created';
          if (!allAttemptsFailed && !noAttemptYet) {
            summary.deferred += 1;
            continue;
          }

          const expired = await this.orderRepository.expirePendingRazorpayOrder(order.order_id, order.payment.payment_intent_id, olderThan);
          if (!expired) {
            summary.deferred += 1;
            continue;
          }
          await this.inventoryRepository.releaseStock(expired.items, expired.order_id);
          await this.orderRepository.markInventoryReleaseComplete(expired.order_id);
          summary.cancelled += 1;
          summary.inventory_released += 1;
          await this.notifyPatient({
            userId: expired.user_id,
            title: 'Checkout expired',
            body: `Payment for order ${expired.order_id} was not completed. Reserved stock has been released; you can place the order again.`,
            entityId: expired.order_id,
          });
        } catch (error) {
          summary.errors += 1;
          this.logger?.warn?.(`Checkout reconciliation deferred for an order (${error?.code || error?.name || 'provider_error'}).`);
        }
      }
      return { ...summary, pending_limit: 50, expiry_minutes: ttlMinutes };
  }

  // --- PATIENT ORDERS ---
  async listPatientOrders(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 20;
      const status = req.query.status ? String(req.query.status).trim() : null;

      const result = await this.orderRepository.listByUserId(userId, { page, limit, status });
      return sendSuccess(res, {
        items: result.items.map((o) => o.toJSON()),
        total: result.total,
        page: result.page,
        limit: result.limit,
        has_more: result.has_more,
      }, 'Patient orders retrieved');
    } catch (err) {
      next(err);
    }
  }

  async getPatientOrder(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const { orderId } = req.params;

      const order = await this.orderRepository.findById(orderId);
      if (!order || String(order.user_id) !== String(userId).trim()) {
        throw new NotFoundError('Order not found');
      }
      return sendSuccess(res, order.toJSON(), 'Order details retrieved');
    } catch (err) {
      next(err);
    }
  }

  async trackPatientOrder(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');

      const order = await this.orderRepository.findById(req.params.orderId);
      if (!order || String(order.user_id) !== String(userId).trim()) {
        throw new NotFoundError('Order not found');
      }

      const fulfillment = order.fulfillment || {};
      const returnAwb = fulfillment.shiprocket_return_awb;
      if (!fulfillment.shiprocket_shipment_id && !fulfillment.awb_code && !returnAwb) {
        const externalTracking = manualTracking(fulfillment);
        if (externalTracking) return sendSuccess(res, externalTracking, 'External courier tracking link retrieved');
        throw new BadRequestError('Live tracking will appear after a Shiprocket AWB is assigned.');
      }

      let tracking;
      try {
        tracking = await this.shiprocketService.trackShipment({
          awbCode: returnAwb || fulfillment.awb_code || fulfillment.tracking_number,
          shipmentId: fulfillment.shiprocket_shipment_id,
        });
      } catch (error) {
        tracking = savedCarrierTracking(fulfillment, returnAwb || fulfillment.awb_code);
        if (!tracking) throw error;
      }
      return sendSuccess(res, tracking, 'Shipment tracking retrieved');
    } catch (err) {
      next(err);
    }
  }

  async cancelPatientOrder(req, res, next) {
    try {
      const userId = req.user?.id;
      if (!userId) throw new UnauthorizedError('Authentication required');
      const { orderId } = req.params;
      const reason = req.body?.reason || 'Customer requested cancellation';

      const cancelled = await this.cancelOrderUseCase.execute({
        orderId,
        userId,
        reason,
        actor: { id: userId, type: 'patient' },
      });

      await this.notifyPatient({
        userId: cancelled.user_id,
        title: 'Order cancelled',
        body: `Your order ${cancelled.order_id} has been cancelled. If a payment refund is due, its status will appear here.`,
        entityId: cancelled.order_id,
      });

      return sendSuccess(res, cancelled.toJSON(), 'Order cancelled and stock released');
    } catch (err) {
      next(err);
    }
  }

  // --- ADMIN ORDERS ---
  async listAdminOrders(req, res, next) {
    try {
      const { status, payment_status, paymentStatus, search, from_date, to_date, fromDate, toDate, page, limit } = req.query;

      const result = await this.orderRepository.listAdmin({
        status,
        paymentStatus: payment_status || paymentStatus,
        search,
        fromDate: from_date || fromDate,
        toDate: to_date || toDate,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 50,
      });

      return sendSuccess(res, {
        items: result.items.map((o) => o.toJSON()),
        total: result.total,
        page: result.page,
        limit: result.limit,
        has_more: result.has_more,
      }, 'Admin orders retrieved');
    } catch (err) {
      next(err);
    }
  }

  async getSalesReport(req, res, next) {
    try {
      const period = String(req.query.period || 'month').trim().toLowerCase();
      if (!['week', 'month', 'year'].includes(period)) {
        throw new BadRequestError('period must be one of: week, month, year.');
      }
      const report = await this.orderRepository.getSalesReport(period);
      return sendSuccess(res, report, 'Commerce sales report retrieved');
    } catch (err) {
      next(err);
    }
  }

  async getAdminOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const order = await this.orderRepository.findById(orderId);
      if (!order) throw new NotFoundError('Order not found');
      return sendSuccess(res, order.toJSON(), 'Order details retrieved');
    } catch (err) {
      next(err);
    }
  }

  async trackAdminOrder(req, res, next) {
    try {
      const order = await this.orderRepository.findById(req.params.orderId);
      if (!order) throw new NotFoundError('Order not found');

      const fulfillment = order.fulfillment || {};
      const returnAwb = fulfillment.shiprocket_return_awb;
      if (!fulfillment.shiprocket_shipment_id && !fulfillment.awb_code && !returnAwb) {
        const externalTracking = manualTracking(fulfillment);
        if (externalTracking) return sendSuccess(res, externalTracking, 'External courier tracking link retrieved');
        throw new BadRequestError('Live tracking will appear after a Shiprocket AWB is assigned.');
      }

      let tracking;
      try {
        tracking = await this.shiprocketService.trackShipment({
          awbCode: returnAwb || fulfillment.awb_code || fulfillment.tracking_number,
          shipmentId: fulfillment.shiprocket_shipment_id,
        });
      } catch (error) {
        tracking = savedCarrierTracking(fulfillment, returnAwb || fulfillment.awb_code);
        if (!tracking) throw error;
      }
      return sendSuccess(res, tracking, 'Shipment tracking retrieved');
    } catch (err) {
      next(err);
    }
  }

  async updateFulfillment(req, res, next) {
    try {
      const { orderId } = req.params;
      const { status, courier, tracking_number, trackingNumber, tracking_url, trackingUrl, return_reason, returnReason } = req.body;

      const previousOrder = await this.orderRepository?.findById(orderId);

      const updated = await this.updateFulfillmentUseCase.execute({
        orderId,
        status,
        courier,
        trackingNumber: tracking_number || trackingNumber,
        trackingUrl: tracking_url || trackingUrl,
        returnReason: return_reason || returnReason,
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });

      const statusChanged = !previousOrder || previousOrder.fulfillment.status !== status;
      if (statusChanged && status === 'Shipped') {
        await this.notifyPatient({
          userId: updated.user_id,
          title: 'Order shipped',
          body: `Your order ${updated.order_id} has shipped${updated.fulfillment.tracking_number ? ` (${updated.fulfillment.tracking_number})` : ''}. Open the app to track it.`,
          entityId: updated.order_id,
        });
      } else if (statusChanged && status === 'Delivered') {
        await this.notifyPatient({
          userId: updated.user_id,
          title: 'Order delivered',
          body: `Your order ${updated.order_id} has been marked as delivered.`,
          entityId: updated.order_id,
        });
      } else if (statusChanged && status === 'Needs attention') {
        await this.notifyPatient({
          userId: updated.user_id,
          title: 'Order update',
          body: `We need to review an issue with order ${updated.order_id}. Please open the app or contact support.`,
          entityId: updated.order_id,
        });
      }

      return sendSuccess(res, updated.toJSON(), 'Order fulfillment status updated');
    } catch (err) {
      next(err);
    }
  }

  async createShiprocketShipment(req, res, next) {
    try {
      const { orderId } = req.params;
      const updated = await this.createShiprocketShipmentUseCase.execute({
        orderId,
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });
      return sendSuccess(res, updated.toJSON(), 'Shiprocket shipment created and pickup requested');
    } catch (err) {
      next(err);
    }
  }

  async retryShiprocketPickup(req, res, next) {
    try {
      const updated = await this.retryShiprocketPickupUseCase.execute({
        orderId: req.params.orderId,
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });
      return sendSuccess(res, updated.toJSON(), 'Shiprocket pickup retry requested');
    } catch (err) { next(err); }
  }

  async createShiprocketReturn(req, res, next) {
    try {
      const updated = await this.createShiprocketReturnUseCase.execute({
        orderId: req.params.orderId,
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });
      return sendSuccess(res, updated.toJSON(), 'Shiprocket reverse pickup created');
    } catch (err) { next(err); }
  }

  async cancelAdminOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const { reason } = req.body;

      const cancelled = await this.cancelOrderUseCase.execute({
        orderId,
        reason: reason || 'Cancelled by admin',
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });

      await this.notifyPatient({
        userId: cancelled.user_id,
        title: 'Order cancelled',
        body: `Your order ${cancelled.order_id} has been cancelled. If a payment refund is due, its status will appear here.`,
        entityId: cancelled.order_id,
      });

      return sendSuccess(res, cancelled.toJSON(), 'Order cancelled');
    } catch (err) {
      next(err);
    }
  }

  async refundAdminOrder(req, res, next) {
    try {
      const { orderId } = req.params;
      const { amount, reason, restock_inventory, restockInventory } = req.body;

      const refunded = await this.refundOrderUseCase.execute({
        orderId,
        amount: amount !== undefined ? amount : null,
        reason: reason || 'Customer refund',
        restockInventory: restock_inventory ?? restockInventory ?? false,
        actor: { id: req.admin?.id || 'admin', type: 'admin' },
      });

      const latestRefundAmount = refunded.payment.refunds?.at(-1)?.amount ?? amount ?? refunded.payment.refund_amount;
      await this.notifyPatient({
        userId: refunded.user_id,
        title: refunded.payment.refund_status === 'processed' ? 'Refund processed' : 'Refund requested',
        body: refunded.payment.refund_status === 'processed'
          ? `A refund of ₹${latestRefundAmount} for order ${refunded.order_id} has been processed.`
          : `A refund for order ${refunded.order_id} is pending with the payment provider.`,
        entityId: refunded.order_id,
      });

      return sendSuccess(res, refunded.toJSON(), 'Refund processed and recorded');
    } catch (err) {
      next(err);
    }
  }

  // --- ADMIN INVENTORY ---
  async restockProduct(req, res, next) {
    try {
      const { productId } = req.params;
      const { quantity, notes } = req.body;

      if (!quantity || quantity <= 0) {
        throw new BadRequestError('Valid restock quantity is required');
      }

      const newStock = await this.inventoryRepository.restock(
        productId,
        quantity,
        notes || 'Admin restock adjustment',
        req.admin?.id || 'admin',
      );

      return sendSuccess(res, { productId, newStock }, `Product restocked to ${newStock} units`);
    } catch (err) {
      next(err);
    }
  }

  async getProductLedger(req, res, next) {
    try {
      const { productId } = req.params;
      const page = parseInt(req.query.page, 10) || 1;
      const limit = parseInt(req.query.limit, 10) || 50;

      const ledger = await this.inventoryRepository.listLedger({ productId, page, limit });
      return sendSuccess(res, ledger, 'Inventory movement ledger retrieved');
    } catch (err) {
      next(err);
    }
  }

  // --- COUPONS ---
  async listCoupons(req, res, next) {
    try {
      const { status, page, limit } = req.query;
      const result = await this.couponRepository.list({ status, page, limit });
      return sendSuccess(res, result, 'Coupons retrieved');
    } catch (err) {
      next(err);
    }
  }

  async createCoupon(req, res, next) {
    try {
      const coupon = await this.couponRepository.create(req.body);
      return sendCreated(res, coupon, `Coupon ${coupon.code} created`);
    } catch (err) {
      next(err);
    }
  }

  async updateCoupon(req, res, next) {
    try {
      const { id } = req.params;
      const coupon = await this.couponRepository.update(id, req.body);
      return sendSuccess(res, coupon, `Coupon ${coupon.code} updated`);
    } catch (err) {
      next(err);
    }
  }

  async deleteCoupon(req, res, next) {
    try {
      const { id } = req.params;
      await this.couponRepository.delete(id);
      return sendSuccess(res, { id }, 'Coupon deleted successfully');
    } catch (err) {
      next(err);
    }
  }
}
