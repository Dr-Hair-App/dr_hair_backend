import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiprocketService } from '../src/modules/commerce/infrastructure/ShiprocketService.js';

const ENV_NAMES = [
  'NODE_ENV', 'DRHAIR_DEPLOYMENT_ENV', 'SHIPROCKET_API_ENV', 'SHIPROCKET_STAGING_MODE',
  'SHIPROCKET_API_EMAIL', 'SHIPROCKET_API_PASSWORD', 'SHIPROCKET_STAGING_PICKUP_NAME', 'SHIPROCKET_STAGING_PICKUP_PIN',
];

function isolateEnvironment(t, values) {
  const before = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, values);
}

test('staging uses an explicit Shiprocket simulator and never credentials for the live API', async (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'staging',
    SHIPROCKET_STAGING_MODE: 'mock',
    SHIPROCKET_API_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
    SHIPROCKET_STAGING_PICKUP_NAME: 'Dr Hair Staging',
    SHIPROCKET_STAGING_PICKUP_PIN: '110001',
  });

  const service = new ShiprocketService();
  const configuration = service.getConfiguration();
  assert.equal(configuration.environment, 'mock');
  assert.equal(configuration.apiBase, 'mock://shiprocket');
  assert.equal(configuration.email, 'staging-mock');
  assert.equal(configuration.password, 'staging-mock');
  assert.equal(configuration.pickupLocation, 'Dr Hair Staging');
  assert.equal(await service.getPickupPostcode(), '110001');
  const quotes = await service.getCourierQuotes({
    deliveryPincode: '400001', paymentMethod: 'prepaid', weight: 0.5,
    length: 10, breadth: 10, height: 10, declaredValue: 1000,
  });
  assert.equal(quotes[0].courier, 'Staging Test Courier');
  assert.equal(quotes[0].rate, 79);
});

test('staging simulator exercises forward shipment, pickup, cancellation, and returns without network access', async (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'staging',
    SHIPROCKET_STAGING_MODE: 'mock',
    SHIPROCKET_API_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
    SHIPROCKET_STAGING_PICKUP_NAME: 'Dr Hair Staging',
    SHIPROCKET_STAGING_PICKUP_PIN: '110001',
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('The staging simulator must never call the live network'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const service = new ShiprocketService();
  const order = {
    order_id: 'ORDER-STAGE-001',
    created_at: new Date().toISOString(),
    customer: { name: 'Staging Patient', phone: '9876543210', email: 'staging@example.invalid' },
    shipping_address: { name: 'Staging Patient', phone: '9876543210', house_number: '10', street: 'Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' },
    items: [{ product_id: 'stage-product', title: 'Test Product', quantity: 1, price: 1000 }],
    payment: { gateway: 'razorpay' },
    pricing: { subtotal: 1000, total: 1000, discount: 0 },
    fulfillment: { shiprocket_package: { weight_kg: 0.5, length_cm: 10, breadth_cm: 10, height_cm: 10 } },
  };

  service.validateOrder(order);
  const shipment = await service.createForwardShipment(order);
  assert.match(shipment.shipmentId, /^\d+$/);
  assert.ok(shipment.awbCode.startsWith('STG'));

  const pickup = await service.requestPickup({ shipmentId: shipment.shipmentId });
  assert.match(pickup.status, /SCHEDULED/i);
  assert.ok(pickup.manifestUrl.includes('staging.invalid'));

  const cancelled = await service.cancelShipment({ awbCode: shipment.awbCode });
  assert.equal(cancelled.awbCode, shipment.awbCode);
  assert.equal(cancelled.response.status, 'CANCELLED');

  const returned = await service.createReturnShipment(order);
  assert.match(returned.shipmentId, /^\d+$/);
  assert.ok(returned.awbCode.startsWith('STG'));
});

test('staging disables Shiprocket when the explicit simulator flag is absent', (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'staging',
    SHIPROCKET_API_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
  });

  const configuration = new ShiprocketService().getConfiguration();
  assert.equal(configuration.environment, 'disabled');
  assert.equal(configuration.apiBase, '');
  assert.equal(configuration.configured, false);
});

test('production honors explicit Shiprocket live configuration', (t) => {
  isolateEnvironment(t, {
    NODE_ENV: 'production',
    DRHAIR_DEPLOYMENT_ENV: 'production',
    SHIPROCKET_API_ENV: 'production',
    SHIPROCKET_API_EMAIL: 'live@example.invalid',
    SHIPROCKET_API_PASSWORD: 'live-password',
  });

  const configuration = new ShiprocketService().getConfiguration();
  assert.equal(configuration.environment, 'production');
  assert.equal(configuration.apiBase, 'https://apiv2.shiprocket.in/v1/external');
  assert.equal(configuration.email, 'live@example.invalid');
  assert.equal(configuration.password, 'live-password');
});
