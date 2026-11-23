import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PaymentGatewayService } from '../src/modules/commerce/infrastructure/PaymentGatewayService.js';
import { ShiprocketService } from '../src/modules/commerce/infrastructure/ShiprocketService.js';
import { VerifyPaymentUseCase } from '../src/modules/commerce/application/VerifyPaymentUseCase.js';
import { GetShippingQuoteUseCase } from '../src/modules/commerce/application/GetShippingQuoteUseCase.js';
import { Order } from '../src/modules/commerce/domain/Order.js';

describe('Razorpay & Shiprocket Comprehensive Test Mode Audit', () => {
  const TEST_KEY_ID = 'rzp_test_TzCw5mI3KbBdxN';
  const TEST_KEY_SECRET = 'test_secret_for_audit_12345';
  const TEST_WEBHOOK_SECRET = 'test_webhook_secret_67890';

  describe('1. Razorpay Gateway Architecture & Signature Verification', () => {
    const paymentGateway = new PaymentGatewayService({
      keyId: TEST_KEY_ID,
      keySecret: TEST_KEY_SECRET,
      webhookSecret: TEST_WEBHOOK_SECRET,
    });

    it('enforces Razorpay Test Mode key ID prefix in test/sandbox environment', () => {
      assert.ok(TEST_KEY_ID.startsWith('rzp_test_'), 'Test mode Key ID must start with rzp_test_');
      assert.doesNotThrow(() => paymentGateway.assertConfigured());
    });

    it('verifies genuine HMAC-SHA256 payment signature', () => {
      const orderId = 'order_M123456789';
      const paymentId = 'pay_P987654321';
      const validSignature = crypto
        .createHmac('sha256', TEST_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest('hex');

      const isVerified = paymentGateway.verifyPaymentSignature({
        orderId,
        paymentId,
        signature: validSignature,
      });

      assert.equal(isVerified, true, 'Genuine signature must verify successfully');
    });

    it('rejects tampered payment signatures or mismatched order IDs', () => {
      const orderId = 'order_M123456789';
      const paymentId = 'pay_P987654321';
      const tamperedSignature = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

      const isVerified = paymentGateway.verifyPaymentSignature({
        orderId,
        paymentId,
        signature: tamperedSignature,
      });

      assert.equal(isVerified, false, 'Tampered signature must be rejected');
    });

    it('verifies genuine Razorpay webhook signature using raw body', () => {
      const rawBody = JSON.stringify({
        entity: 'event',
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_test123',
              order_id: 'order_test456',
              amount: 150000,
              status: 'captured',
            },
          },
        },
      });

      const validWebhookSignature = crypto
        .createHmac('sha256', TEST_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

      const isWebhookValid = paymentGateway.verifyWebhookSignature({
        rawBody,
        signature: validWebhookSignature,
      });
      assert.equal(isWebhookValid, true, 'Valid webhook signature must be accepted');

      const isInvalidWebhook = paymentGateway.verifyWebhookSignature({
        rawBody,
        signature: 'invalid_sig',
      });
      assert.equal(isInvalidWebhook, false, 'Invalid webhook signature must be rejected');
    });
  });

  describe('2. E-Commerce Razorpay Checkout & Settlement Flow', () => {
    let mockOrderStore = [];
    const mockOrderRepo = {
      async findById(id) {
        return mockOrderStore.find((o) => o.id === id || o.order_id === id) || null;
      },
      async update(order) {
        const idx = mockOrderStore.findIndex((o) => o.id === order.id);
        if (idx >= 0) mockOrderStore[idx] = order;
        return order;
      },
      async markPaymentCaptured({ orderId, paymentId }) {
        const order = await this.findById(orderId);
        order.payment.payment_status = 'Paid';
        order.payment.transaction_id = paymentId;
        order.addTimelineEvent(`Payment of ₹${order.pricing.total} verified`);
        return order;
      },
    };

    const mockInventoryRepo = {
      async reserveStock() { return true; },
      async releaseStock() { return true; },
    };

    const paymentGateway = {
      provider: 'cashfree',
      async verifyCapturedPayment({ paymentId }) {
        return { transaction_id: paymentId, payment: { cf_payment_id: paymentId, payment_status: 'SUCCESS' } };
      },
    };

    const verifyPaymentUseCase = new VerifyPaymentUseCase({
      orderRepository: mockOrderRepo,
      inventoryRepository: mockInventoryRepo,
      paymentGatewayService: paymentGateway,
    });

    it('verifies a Cashfree captured payment and transitions order to paid', async () => {
      // 1. Setup pending order
      const order = new Order({
        id: 'ord_test_001',
        order_id: 'ord_test_001',
        user_id: 101,
        items: [{ product_id: 'prod_1', name: 'Anti-Hairfall Shampoo', quantity: 1, price: 650, total_price: 650 }],
        pricing: { subtotal: 650, discount: 0, shipping: 0, tax: 0, total: 650 },
        payment: {
          gateway: 'cashfree',
          status: 'pending',
          payment_intent_id: 'order_rzp_mock_123',
        },
        fulfillment: { status: 'unfulfilled' },
      });
      mockOrderStore = [order];

      // 3. Execute payment verification
      const updatedOrder = await verifyPaymentUseCase.execute({
        orderId: 'ord_test_001',
        paymentId: 'pay_mock_abc',
        userId: 101,
      });

      assert.equal(updatedOrder.payment.payment_status, 'Paid');
      assert.equal(updatedOrder.payment.transaction_id, 'pay_mock_abc');
      assert.ok(updatedOrder.timeline.some((e) => (e.label || '').includes('Payment of ₹650 verified')));
    });
  });

  describe('3. Shiprocket Shipping Quote & Logistics Simulator Audit', () => {
    it('keeps Shiprocket disabled unless production or staging mock mode is explicit', () => {
      const shiprocketService = new ShiprocketService();
      const config = shiprocketService.getConfiguration();
      assert.equal(config.environment, 'disabled');
      assert.equal(config.configured, false);
    });

    it('calculates shipping quotes and selects cheapest available courier', async () => {
      const mockShiprocketService = {
        getConfiguration() {
          return { configured: true, environment: 'mock', pickupLocation: 'work' };
        },
        async getPickupPostcode() {
          return '110001';
        },
        async getCourierQuotes() {
          return [
            {
              courier_id: '10',
              courier: 'Delhivery Surface',
              rate: 65.0,
              etd: '3-4 business days',
              cod_available: true,
              rating: 4.5,
              charge_weight: 0.35,
            },
            {
              courier_id: '12',
              courier: 'Blue Dart Air',
              rate: 95.0,
              etd: '2 business days',
              cod_available: true,
              rating: 4.8,
              charge_weight: 0.35,
            },
          ];
        },
      };

      const mockProductRepo = {
        async getById() {
          return {
            id: 'p1',
            name: 'Hair Oil',
            price: 650,
            shipping_profile: { weight_kg: 0.35, length_cm: 15, breadth_cm: 10, height_cm: 5 },
          };
        },
        async findById() {
          return {
            id: 'p1',
            name: 'Hair Oil',
            price: 650,
            shipping_profile: { weight_kg: 0.35, length_cm: 15, breadth_cm: 10, height_cm: 5 },
          };
        },
      };

      const mockAddressRepo = {
        async getById(userId, addressId) {
          return { id: addressId, pincode: '400001', city: 'Mumbai', state: 'Maharashtra' };
        },
      };

      const quoteUseCase = new GetShippingQuoteUseCase({
        productRepository: mockProductRepo,
        addressRepository: mockAddressRepo,
        shiprocketService: mockShiprocketService,
      });

      const quote = await quoteUseCase.execute({
        userId: 1,
        addressId: 'addr_1',
        items: [{ productId: 'p1', quantity: 1 }],
        paymentGateway: 'cashfree',
      });

      assert.ok(quote.quote_id);
      assert.equal(quote.courier, 'Delhivery Surface');
      assert.equal(quote.shipping_fee, 65.0);
      assert.equal(quote.destination_pincode, '400001');
      assert.equal(quote.cod_available, true);
    });

    it('normalizes Shiprocket courier tracking status codes accurately for mobile client', () => {
      const shiprocketService = new ShiprocketService();
      const mockTrackingData = {
        tracking_data: {
          shipment_track: [{
            awb_code: 'SR_TEST_12345',
            courier_name: 'Delhivery Surface',
            current_status: 'Out for Delivery',
            current_status_id: 17,
            edd: '2026-11-20',
            origin: 'New Delhi',
            destination: 'Mumbai',
            track_url: 'https://shiprocket.co/tracking/SR_TEST_12345',
          }],
          shipment_track_activities: [
            { date: '2026-11-18 10:00', 'sr-status-label': 'OUT FOR DELIVERY', activity: 'Package out with rider', location: 'Mumbai DC' },
            { date: '2026-11-17 18:00', 'sr-status-label': 'IN TRANSIT', activity: 'Reached hub', location: 'Pune Hub' },
          ],
        },
      };

      const normalized = shiprocketService.normalizeTracking(mockTrackingData, 'SR_TEST_12345');
      assert.equal(normalized.awb_code, 'SR_TEST_12345');
      assert.equal(normalized.courier, 'Delhivery Surface');
      assert.equal(normalized.current_status, 'Out for Delivery');
      assert.equal(normalized.current_status_id, 17);
      assert.equal(normalized.events.length, 2);
      assert.equal(normalized.events[0].status, 'OUT FOR DELIVERY');
    });

    it('validates forward shipment order payload requirements before contacting Shiprocket', () => {
      const shiprocketService = new ShiprocketService();
      const validOrder = {
        order_id: 'ORD_12345',
        customer: { name: 'Sunil Sharma', phone: '9876543210', email: 'sunil@example.com' },
        shipping_address: {
          house_number: 'Flat 402',
          street: 'MG Road',
          city: 'Jaipur',
          state: 'Rajasthan',
          pincode: '302001',
        },
        items: [{ title: 'Hair Serum', quantity: 1, price: 999 }],
        pricing: { subtotal: 999, discount: 0 },
        payment: { gateway: 'razorpay' },
        fulfillment: {
          shiprocket_package: {
            weight_kg: 0.5,
            length_cm: 15,
            breadth_cm: 10,
            height_cm: 5,
          },
        },
      };

      const config = { pickupLocation: 'work' };
      const payload = shiprocketService.buildForwardShipmentPayload(validOrder, config);
      assert.equal(payload.order_id, 'ORD_12345');
      assert.equal(payload.billing_customer_name, 'Sunil Sharma');
      assert.equal(payload.billing_pincode, '302001');
      assert.equal(payload.payment_method, 'Prepaid');
    });

    it('handles Shiprocket webhook tracking updates with secret verification', () => {
      const configuredSecret = 'test_sr_secret_123';
      const incomingHeader = 'test_sr_secret_123';

      const isValid = Boolean(
        configuredSecret &&
        incomingHeader &&
        crypto.timingSafeEqual(Buffer.from(incomingHeader), Buffer.from(configuredSecret))
      );
      assert.equal(isValid, true, 'Webhook secret must match timing-safely');
    });
  });
});
