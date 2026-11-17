import { z } from 'zod';

export const pincodeSchema = z
  .string({ required_error: 'Pincode is required' })
  .trim()
  .regex(/^[1-9][0-9]{5}$/, 'Valid 6-digit Indian pincode is required');

export const shippingQuoteSchema = z.object({
  pincode: pincodeSchema.optional(),
  address_id: z.string().trim().optional(),
  items: z.array(
    z.object({
      product_id: z.string().trim().min(1, 'Product ID is required'),
      quantity: z.number().int().min(1, 'Quantity must be at least 1'),
    })
  ).optional(),
});

export const checkoutSchema = z.object({
  address_id: z.string({ required_error: 'Delivery address ID is required' }).trim().min(1),
  payment_method: z.enum(['razorpay', 'cod'], {
    errorMap: () => ({ message: 'Payment method must be razorpay or cod' }),
  }),
  coupon_code: z.string().trim().optional(),
});

export const applyCouponSchema = z.object({
  code: z.string({ required_error: 'Coupon code is required' }).trim().min(1),
});
