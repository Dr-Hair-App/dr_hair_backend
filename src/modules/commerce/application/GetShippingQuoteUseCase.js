import { createHash } from 'node:crypto';
import { BadRequestError, NotFoundError } from '../../../shared/errors/index.js';

export class GetShippingQuoteUseCase {
  constructor({ productRepository, addressRepository, shiprocketService }) {
    this.productRepository = productRepository;
    this.addressRepository = addressRepository;
    this.shiprocketService = shiprocketService;
  }

  async execute({ userId, addressId, deliveryPincode, items = [], paymentGateway = 'razorpay' }) {
    if (!['cod', 'razorpay'].includes(paymentGateway)) {
      throw new BadRequestError('Select a supported checkout payment method before checking delivery.');
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      throw new BadRequestError('Add between 1 and 50 cart items to check delivery.');
    }

    let address = null;
    if (addressId) {
      if (!userId) throw new BadRequestError('Sign in to quote a saved delivery address.');
      address = await this.addressRepository.getById(String(userId), addressId);
      if (!address) throw new NotFoundError('Delivery address not found.');
    }
    const destination = String(deliveryPincode || address?.pincode || address?.pinCode || '').trim();
    if (!/^\d{6}$/.test(destination)) throw new BadRequestError('Enter or select a valid 6-digit delivery PIN code.');

    let declaredValue = 0;
    let weight = 0;
    let length = 0;
    let breadth = 0;
    let height = 0;
    const packageLines = [];
    for (const requestItem of items) {
      const productId = String(requestItem.product_id || requestItem.productId || '').trim();
      const quantity = Number(requestItem.quantity);
      if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
        throw new BadRequestError('Each delivery quote item needs a product and quantity from 1 to 100.');
      }
      const product = await this.productRepository.getById(productId);
      if (!product || String(product.status || 'active').toLowerCase() !== 'active') {
        throw new NotFoundError(`Product is unavailable: ${productId}`);
      }
      const plans = product.supply_plans || product.supplyPlans || [];
      const selectedPlanId = String(requestItem.plan_id || requestItem.planId || requestItem.plan || '').trim();
      const plan = selectedPlanId
        ? plans.find((entry) => String(entry.id || '') === selectedPlanId || String(entry.title || '') === selectedPlanId)
        : plans[0];
      if (selectedPlanId && !plan) throw new BadRequestError(`The selected supply plan is unavailable for ${product.name}.`);
      const profile = plan?.shipping_profile || plan?.shippingProfile || product.shipping_profile || product.shippingProfile;
      const profileValues = {
        weight: Number(profile?.weight_kg ?? profile?.weightKg),
        length: Number(profile?.length_cm ?? profile?.lengthCm),
        breadth: Number(profile?.breadth_cm ?? profile?.breadthCm),
        height: Number(profile?.height_cm ?? profile?.heightCm),
      };
      if (Object.values(profileValues).some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new BadRequestError(`Shipping parcel details are missing for ${product.name}${plan?.title ? ` (${plan.title})` : ''}. Ask the store team to update its package profile.`);
      }
      const unitPrice = Number(plan?.price ?? product.price);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw new BadRequestError(`Price is not configured for ${product.name}.`);
      declaredValue += unitPrice * quantity;
      weight += profileValues.weight * quantity;
      length = Math.max(length, profileValues.length);
      breadth = Math.max(breadth, profileValues.breadth);
      height += profileValues.height * quantity;
      packageLines.push({ sku: String(plan?.sku || product.sku || productId), quantity, plan: String(plan?.title || '') });
    }

    // A single stacked parcel is conservative for mixed products: retain the
    // largest base dimensions and stack the packed heights and weights.
    const parcel = {
      weight_kg: Math.round(weight * 1000) / 1000,
      length_cm: Math.ceil(length),
      breadth_cm: Math.ceil(breadth),
      height_cm: Math.ceil(height),
      lines: packageLines,
    };
    if ([parcel.weight_kg, parcel.length_cm, parcel.breadth_cm, parcel.height_cm].some((value) => value > 500)) {
      throw new BadRequestError('Combined parcel exceeds the supported 500-unit shipping package limit.');
    }

    const couriers = await this.shiprocketService.getCourierQuotes({
      deliveryPincode: destination,
      paymentMethod: paymentGateway,
      weight: parcel.weight_kg,
      length: parcel.length_cm,
      breadth: parcel.breadth_cm,
      height: parcel.height_cm,
      declaredValue,
    });
    if (!couriers.length) {
      throw new BadRequestError('Shiprocket has no available courier for this delivery PIN and package.', null, 'DELIVERY_UNAVAILABLE');
    }
    const eligibleCouriers = paymentGateway === 'cod'
      ? couriers.filter((courier) => courier.cod_available)
      : couriers;
    if (!eligibleCouriers.length) {
      throw new BadRequestError('Cash on Delivery is not available for this PIN code and package.', null, 'COD_UNAVAILABLE');
    }
    const selected = eligibleCouriers[0];
    const canonical = JSON.stringify({ destination, paymentGateway, declaredValue, parcel, courier: selected });
    const quoteId = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
    return {
      quote_id: quoteId,
      destination_pincode: destination,
      courier: selected.courier,
      courier_id: selected.courier_id,
      shipping_fee: Math.round(selected.rate * 100) / 100,
      estimated_delivery: selected.etd,
      chargeable_weight_kg: selected.charge_weight,
      cod_available: eligibleCouriers.some((courier) => courier.cod_available),
      package: parcel,
      quote_expires_in_seconds: 300,
      alternatives: eligibleCouriers.slice(1, 4),
    };
  }
}
