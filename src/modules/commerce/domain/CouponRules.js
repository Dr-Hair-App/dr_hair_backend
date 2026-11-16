import { BadRequestError } from '../../../shared/errors/index.js';

const clinicDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

export function calculateCouponDiscount(coupon, { subtotal, items = [], hasPriorOrders = false }) {
  if (!coupon) throw new BadRequestError('Invalid or expired coupon code.');
  if (coupon.status !== 'Active') throw new BadRequestError('This coupon is currently inactive or expired.');

  const expiresOn = String(coupon.expires_on || coupon.expiresOn || '').trim();
  if (expiresOn && expiresOn < clinicDate()) throw new BadRequestError('This coupon has expired.');

  const uses = Number(coupon.uses) || 0;
  const maxUses = Number(coupon.max_uses ?? coupon.maxUses);
  if (Number.isFinite(maxUses) && maxUses >= 0 && uses >= maxUses) {
    throw new BadRequestError('This coupon has reached its usage limit.');
  }

  const minimumOrder = Number(coupon.minimum_order ?? coupon.minimumOrder) || 0;
  if (subtotal < minimumOrder) throw new BadRequestError(`Add items worth ₹${minimumOrder} to use this coupon.`);

  const appliesTo = String(coupon.applies_to ?? coupon.appliesTo ?? 'All products').trim();
  if (/^first order$/i.test(appliesTo) && hasPriorOrders) {
    throw new BadRequestError('This coupon is available on your first order only.');
  }
  if (appliesTo && !/^all products$/i.test(appliesTo) && !/^first order$/i.test(appliesTo)) {
    const eligible = items.some((item) =>
      String(item.title || item.name || '').trim().toLowerCase() === appliesTo.toLowerCase() ||
      String(item.product_id || item.productId || '').trim().toLowerCase() === appliesTo.toLowerCase());
    if (!eligible) throw new BadRequestError(`This coupon applies to ${appliesTo} only.`);
  }

  const discountType = coupon.discount_type || coupon.discountType || 'percent';
  const discountValue = Number(coupon.discount_value ?? coupon.discountValue);
  if (!Number.isFinite(discountValue) || discountValue <= 0) throw new BadRequestError('This coupon has invalid discount settings.');
  const rawDiscount = discountType === 'percent'
    ? Math.round(subtotal * (discountValue / 100))
    : discountType === 'fixed'
      ? discountValue
      : NaN;
  if (!Number.isFinite(rawDiscount)) throw new BadRequestError('This coupon has invalid discount settings.');
  return Math.min(subtotal, Math.max(0, rawDiscount));
}
