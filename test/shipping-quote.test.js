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
