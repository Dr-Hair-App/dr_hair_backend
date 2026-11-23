import test from 'node:test';
import assert from 'node:assert/strict';
import { GetShippingQuoteUseCase } from '../src/modules/commerce/application/GetShippingQuoteUseCase.js';

function makeUseCase({ rates = [], planProfile = { weight_kg: 0.3, length_cm: 10, breadth_cm: 8, height_cm: 4 } } = {}) {
  let call;
  const useCase = new GetShippingQuoteUseCase({
    productRepository: { async getById() { return {
      id: 'serum-1', name: 'Serum', status: 'active', price: 999,
      supply_plans: [{ id: 'one-month', title: '1 Month', price: 999, shipping_profile: planProfile }],
    }; } },
    addressRepository: { async getById() { return null; } },
    shiprocketService: { async getCourierQuotes(args) { call = args; return rates; } },
  });
  return { useCase, getCall: () => call };
}

test('shipping quote uses selected plan parcel and cheapest available courier', async () => {
  const { useCase, getCall } = makeUseCase({ rates: [
    { courier_id: '1', courier: 'Value Courier', rate: 42, etd: '5 days', cod_available: true },
    { courier_id: '2', courier: 'Fast Courier', rate: 90, etd: '3 days', cod_available: true },
  ] });
  const quote = await useCase.execute({
    userId: 'patient-1', deliveryPincode: '302001', paymentGateway: 'cod',
    items: [{ productId: 'serum-1', plan: '1 Month', quantity: 2 }],
  });
  assert.equal(quote.shipping_fee, 42);
  assert.equal(quote.courier_id, '1');
  assert.equal(quote.package.weight_kg, 0.6);
  assert.equal(quote.package.height_cm, 8);
  assert.equal(getCall().paymentMethod, 'cod');
  assert.equal(quote.alternatives.length, 1);
});

test('shipping quote sorts provider rates and excludes malformed courier entries', async () => {
  const { useCase } = makeUseCase({ rates: [
    { courier_id: 'fast', courier: 'Fast Courier', rate: 90, rating: 4.8, cod_available: true },
    { courier_id: '', courier: 'Broken Entry', rate: 1, cod_available: true },
    { courier_id: 'value', courier: 'Value Courier', rate: '42', rating: 4.2, cod_available: true },
  ] });

  const quote = await useCase.execute({
    deliveryPincode: '302001', paymentGateway: 'cod',
    items: [{ productId: 'serum-1', plan: '1 Month', quantity: 1 }],
  });
  assert.equal(quote.courier_id, 'value');
  assert.equal(quote.shipping_fee, 42);
  assert.deepEqual(quote.alternatives.map(({ courier_id }) => courier_id), ['fast']);
});

test('shipping quote rejects non-object cart rows with a validation error', async () => {
  const { useCase } = makeUseCase();
  await assert.rejects(
    useCase.execute({ deliveryPincode: '302001', items: [null] }),
    (error) => error.statusCode === 400 && /each delivery quote item/i.test(error.message),
  );
});

test('shipping quote returns a stable upstream error for a malformed courier response', async () => {
  const { useCase } = makeUseCase();
  useCase.shiprocketService.getCourierQuotes = async () => ({ courier: 'not-an-array' });
  await assert.rejects(
    useCase.execute({ deliveryPincode: '302001', items: [{ productId: 'serum-1', quantity: 1 }] }),
    (error) => error.statusCode === 502 && error.code === 'SHIPROCKET_INVALID_QUOTE_RESPONSE',
  );
});

test('shipping quote rejects unconfigured product parcel data before calling carrier', async () => {
  const { useCase, getCall } = makeUseCase({ planProfile: { weight_kg: 0, length_cm: 10, breadth_cm: 8, height_cm: 4 } });
  await assert.rejects(
    useCase.execute({ userId: 'patient-1', deliveryPincode: '302001', items: [{ productId: 'serum-1', plan: '1 Month', quantity: 1 }] }),
    /parcel details are missing/i,
  );
  assert.equal(getCall(), undefined);
});

test('COD quote rejects courier options without COD support', async () => {
  const { useCase } = makeUseCase({ rates: [
    { courier_id: '1', courier: 'Prepaid only', rate: 42, etd: '5 days', cod_available: false },
  ] });
  await assert.rejects(
    useCase.execute({ userId: 'patient-1', deliveryPincode: '302001', paymentGateway: 'cod', items: [{ productId: 'serum-1', plan: '1 Month', quantity: 1 }] }),
    /Cash on Delivery is not available/i,
  );
});

test('missing Shiprocket configuration is returned as a stable service-unavailable error', async () => {
  const { useCase } = makeUseCase();
  useCase.shiprocketService.getCourierQuotes = async () => {
    const error = new Error('Shiprocket setup is incomplete.');
    error.code = 'SHIPROCKET_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  };

  await assert.rejects(
    useCase.execute({
      userId: 'patient-1', deliveryPincode: '302001',
      items: [{ productId: 'serum-1', plan: '1 Month', quantity: 1 }],
    }),
    (error) => {
      assert.equal(error.code, 'SHIPROCKET_NOT_CONFIGURED');
      assert.equal(error.statusCode, 503);
      assert.match(error.message, /temporarily unavailable/i);
      return true;
    },
  );
});
