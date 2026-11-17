import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiprocketService } from '../src/modules/commerce/infrastructure/ShiprocketService.js';

test('Shiprocket staging simulator returns normalized tracking without external requests', async (t) => {
  const names = ['NODE_ENV', 'DRHAIR_DEPLOYMENT_ENV', 'SHIPROCKET_STAGING_MODE'];
  const oldEnv = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  t.after(() => {
    for (const key of names) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
    globalThis.fetch = oldFetch;
  });

  process.env.NODE_ENV = 'production';
  process.env.DRHAIR_DEPLOYMENT_ENV = 'staging';
  process.env.SHIPROCKET_STAGING_MODE = 'mock';
  globalThis.fetch = async () => { throw new Error('Staging simulator must not call the network'); };

  const tracking = await new ShiprocketService().trackShipment({ awbCode: 'STG-TRANSIT-123456789' });

  assert.equal(tracking.awb_code, 'STG-TRANSIT-123456789');
  assert.equal(tracking.current_status, 'IN TRANSIT');
  assert.equal(tracking.courier, 'Staging Test Courier');
  assert.equal(tracking.origin, 'New Delhi');
  assert.equal(tracking.events[0].activity, 'Staging shipment update');
  assert.equal('consignee_name' in tracking, false);
});
