import { Router } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { authenticateToken } from '../../../shared/middlewares/auth.middleware.js';
import { requirePermission } from '../../../shared/middlewares/admin.middleware.js';
import { createRateLimitStore } from '../../../shared/middlewares/rate-limit-store.js';
import { sendError } from '../../../shared/utils/response.js';

function optionalAuthentication(req, res, next) {
  if (!req.headers.authorization) return next();
  return authenticateToken(req, res, next);
}

export function createCommerceRouter({ commerceController }) {
  const router = Router();
  const shippingQuoteLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    keyGenerator: (req) => req.user?.id
      ? `patient:${req.user.id}`
      : `guest:${ipKeyGenerator(req.ip || 'unknown')}`,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: createRateLimitStore('shiprocket-shipping-quote'),
    passOnStoreError: true,
    handler: (_req, res) => sendError(res, { message: 'Please wait before checking delivery again.', statusCode: 429 }),
  });

  // Checkout (Patient authenticated)
  router.post('/checkout', authenticateToken, (req, res, next) => commerceController.checkout(req, res, next));
  router.post('/shipping/quote', optionalAuthentication, shippingQuoteLimiter, (req, res, next) => commerceController.getShippingQuote(req, res, next));

  // Payment Verification (Authenticated or token-bearing)
  router.post('/verify-payment', authenticateToken, (req, res, next) => commerceController.verifyPayment(req, res, next));

  // Public Gateway Webhook (HMAC signature verified inside controller)
  router.post('/webhook/payment', (req, res, next) => commerceController.handlePaymentWebhook(req, res, next));
  // The Cloudflare scheduled Worker invokes maintenance from the configured cron trigger.
  router.post('/internal/reconcile-pending-checkouts', (req, res, next) => commerceController.reconcilePendingCheckouts(req, res, next));
  // Shiprocket delivery event URL intentionally uses a neutral path.
  router.post('/webhooks/carrier-updates', (req, res, next) => commerceController.handleCarrierWebhook(req, res, next));

  // Public/Patient Coupon list
  router.get('/coupons', (req, res, next) => commerceController.listCoupons(req, res, next));

  return router;
}

export function createPatientAddressRouter({ commerceController }) {
  const router = Router();
  router.use(authenticateToken);

  router.get('/', (req, res, next) => commerceController.listAddresses(req, res, next));
  router.post('/', (req, res, next) => commerceController.createAddress(req, res, next));
  router.put('/:addressId', (req, res, next) => commerceController.updateAddress(req, res, next));
  router.delete('/:addressId', (req, res, next) => commerceController.deleteAddress(req, res, next));
  router.post('/:addressId/default', (req, res, next) => commerceController.setDefaultAddress(req, res, next));

  return router;
}

export function createPatientOrderRouter({ commerceController }) {
  const router = Router();
  router.use(authenticateToken);

  router.get('/', (req, res, next) => commerceController.listPatientOrders(req, res, next));
  router.get('/:orderId', (req, res, next) => commerceController.getPatientOrder(req, res, next));
  router.post('/:orderId/reconcile-payment', (req, res, next) => commerceController.reconcilePatientPayment(req, res, next));
  router.get('/:orderId/tracking', (req, res, next) => commerceController.trackPatientOrder(req, res, next));
  router.post('/:orderId/cancel', (req, res, next) => commerceController.cancelPatientOrder(req, res, next));

  return router;
}

export function createAdminOrderRouter({ commerceController }) {
  const router = Router();
  router.use(authenticateToken);
  router.use(requirePermission('orders.manage'));

  router.get('/', (req, res, next) => commerceController.listAdminOrders(req, res, next));
  router.get('/:orderId', (req, res, next) => commerceController.getAdminOrder(req, res, next));
  router.get('/:orderId/tracking', (req, res, next) => commerceController.trackAdminOrder(req, res, next));
  router.patch('/:orderId/fulfillment', (req, res, next) => commerceController.updateFulfillment(req, res, next));
  router.post('/:orderId/shiprocket', (req, res, next) => commerceController.createShiprocketShipment(req, res, next));
  router.post('/:orderId/shiprocket/pickup/retry', (req, res, next) => commerceController.retryShiprocketPickup(req, res, next));
  router.post('/:orderId/shiprocket/return', (req, res, next) => commerceController.createShiprocketReturn(req, res, next));
  router.post('/:orderId/cancel', (req, res, next) => commerceController.cancelAdminOrder(req, res, next));
  router.post('/:orderId/refund', (req, res, next) => commerceController.refundAdminOrder(req, res, next));

  return router;
}

export function createAdminCouponRouter({ commerceController }) {
  const router = Router();
  router.use(authenticateToken);
  router.use(requirePermission('commerce.manage'));

  router.get('/', (req, res, next) => commerceController.listCoupons(req, res, next));
  router.post('/', (req, res, next) => commerceController.createCoupon(req, res, next));
  router.patch('/:id', (req, res, next) => commerceController.updateCoupon(req, res, next));
  router.delete('/:id', (req, res, next) => commerceController.deleteCoupon(req, res, next));

  return router;
}
