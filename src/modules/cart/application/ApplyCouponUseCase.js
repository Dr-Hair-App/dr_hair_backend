import { BadRequestError } from '../../../shared/errors/index.js';
import { calculateCouponDiscount } from '../../commerce/domain/CouponRules.js';

export class ApplyCouponUseCase {
  constructor({ cartRepository, couponRepository }) {
    this.cartRepository = cartRepository;
    this.couponRepository = couponRepository;
  }

  async execute({ userId, code }) {
    if (!code) {
      throw new BadRequestError('Coupon code is required.');
    }

    const cleanCode = String(code).trim().toUpperCase();
    const cart = await this.cartRepository.getCart(userId);

    if (this.couponRepository) {
      const dynamicCoupon = await this.couponRepository.findByCode(cleanCode);
      const discount = calculateCouponDiscount(dynamicCoupon, {
        subtotal: cart.subtotal,
        items: cart.items,
      });
      cart.coupon_code = dynamicCoupon.code;
      cart.discount = discount;
      cart.updated_at = new Date().toISOString();
      await this.cartRepository.saveCart(cart);
      return cart.toJSON();
    }

    throw new BadRequestError('Coupon service is not configured.');
  }

  async remove({ userId }) {
    const cart = await this.cartRepository.getCart(userId);
    cart.removeCoupon();
    await this.cartRepository.saveCart(cart);
    return cart.toJSON();
  }
}
