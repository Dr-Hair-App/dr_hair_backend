import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/shared/validators/validate.middleware.js';
import {
  phoneSchema,
  sendLoginOtpSchema,
  verifyLoginOtpSchema,
  loginWithPasswordSchema,
  registerUserSchema,
} from '../src/shared/validators/auth.validator.js';
import {
  pincodeSchema,
  shippingQuoteSchema,
  checkoutSchema,
  applyCouponSchema,
} from '../src/shared/validators/commerce.validator.js';
import { createReviewSchema } from '../src/shared/validators/review.validator.js';
import { bookAppointmentSchema } from '../src/shared/validators/appointment.validator.js';

describe('Zod Validation Middleware & Domain Schemas', () => {
  describe('validate() Middleware', () => {
    it('should call next() and sanitize req.body when payload matches schema', async () => {
      const middleware = validate({ body: sendLoginOtpSchema });
      const req = { body: { mobile: ' 9876543210 ' } };
      let statusCalled = false;
      let jsonCalled = false;
      const res = {
        status() { statusCalled = true; return this; },
        json() { jsonCalled = true; return this; },
      };
      let nextCalled = false;

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(statusCalled, false);
      assert.equal(jsonCalled, false);
      assert.equal(req.body.mobile, '9876543210');
    });

    it('should respond with 400 and VALIDATION_ERROR on schema mismatch', async () => {
      const middleware = validate({ body: sendLoginOtpSchema });
      const req = { body: {} }; // Missing all login identifiers
      let responseStatus = null;
      let responseBody = null;
      const res = {
        status(code) { responseStatus = code; return this; },
        json(data) { responseBody = data; return this; },
      };
      let nextCalled = false;

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(responseStatus, 400);
      assert.equal(responseBody.status, 'error');
      assert.equal(responseBody.error.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(responseBody.error.details));
      assert.ok(responseBody.error.details.length > 0);
    });
  });

  describe('Auth Validators', () => {
    it('phoneSchema should validate and normalize Indian mobile numbers', () => {
      assert.equal(phoneSchema.parse('9876543210'), '9876543210');
      assert.equal(phoneSchema.parse('+919876543210'), '9876543210');
      assert.equal(phoneSchema.parse('91 9876543210'), '9876543210');
      assert.throws(() => phoneSchema.parse('1234567890')); // Does not start with 6-9
      assert.throws(() => phoneSchema.parse('98765')); // Too short
    });

    it('sendLoginOtpSchema should accept phone, mobile, login, or email', () => {
      assert.ok(sendLoginOtpSchema.parse({ phone: '9876543210' }));
      assert.ok(sendLoginOtpSchema.parse({ mobile: '9876543210' }));
      assert.ok(sendLoginOtpSchema.parse({ login: 'patient_01' }));
      assert.ok(sendLoginOtpSchema.parse({ email: 'test@drhairindia.com' }));
      assert.throws(() => sendLoginOtpSchema.parse({ email: 'invalid-email' }));
      assert.throws(() => sendLoginOtpSchema.parse({}));
    });

    it('verifyLoginOtpSchema should enforce 4 to 6 digit OTP', () => {
      assert.ok(verifyLoginOtpSchema.parse({ phone: '9876543210', otp: '1234' }));
      assert.ok(verifyLoginOtpSchema.parse({ mobile: '9876543210', otp: '123456' }));
      assert.throws(() => verifyLoginOtpSchema.parse({ phone: '9876543210', otp: '12' })); // Too short
      assert.throws(() => verifyLoginOtpSchema.parse({ phone: '9876543210', otp: '1234567' })); // Too long
      assert.throws(() => verifyLoginOtpSchema.parse({ otp: '1234' })); // Missing login identifier
    });

    it('loginWithPasswordSchema should require minimum 6 character password', () => {
      assert.ok(loginWithPasswordSchema.parse({ email: 'dr.hair@admin', password: 'secretPassword123' }));
      assert.throws(() => loginWithPasswordSchema.parse({ email: 'dr.hair@admin', password: '123' }));
    });

    it('registerUserSchema should validate gender and age boundaries', () => {
      assert.ok(registerUserSchema.parse({ phone: '9876543210', name: 'Rohan Sharma', gender: 'male', age: 28 }));
      assert.throws(() => registerUserSchema.parse({ phone: '9876543210', gender: 'unknown' }));
      assert.throws(() => registerUserSchema.parse({ phone: '9876543210', age: 150 }));
    });
  });

  describe('Commerce Validators', () => {
    it('pincodeSchema should validate 6-digit Indian postal codes', () => {
      assert.equal(pincodeSchema.parse('110001'), '110001');
      assert.throws(() => pincodeSchema.parse('011001')); // Starts with 0
      assert.throws(() => pincodeSchema.parse('11000')); // 5 digits
      assert.throws(() => pincodeSchema.parse('11000A')); // Non-digit
    });

    it('checkoutSchema should validate address_id and payment method', () => {
      assert.ok(checkoutSchema.parse({ address_id: 'addr_123', payment_method: 'razorpay' }));
      assert.ok(checkoutSchema.parse({ address_id: 'addr_123', payment_method: 'cod' }));
      assert.throws(() => checkoutSchema.parse({ address_id: 'addr_123', payment_method: 'crypto' }));
      assert.throws(() => checkoutSchema.parse({ payment_method: 'razorpay' }));
    });

    it('applyCouponSchema should require coupon code', () => {
      assert.ok(applyCouponSchema.parse({ code: 'FIRST50' }));
      assert.throws(() => applyCouponSchema.parse({ code: '   ' }));
    });
  });

  describe('Review & Appointment Validators', () => {
    it('createReviewSchema should validate ratings 1 through 5 and reviewer name', () => {
      assert.ok(createReviewSchema.parse({ name: 'Amit Verma', rating: 5, message: 'Excellent treatment results' }));
      assert.ok(createReviewSchema.parse({ name: 'Amit Verma', rating: 1 }));
      assert.throws(() => createReviewSchema.parse({ name: 'Amit Verma', rating: 0 }));
      assert.throws(() => createReviewSchema.parse({ name: 'Amit Verma', rating: 6 }));
      assert.throws(() => createReviewSchema.parse({ rating: 4 })); // Missing name
    });

    it('bookAppointmentSchema should require date in YYYY-MM-DD and time slot', () => {
      assert.ok(bookAppointmentSchema.parse({ slot_date: '2026-12-01', slot_time: '11:00 AM' }));
      assert.throws(() => bookAppointmentSchema.parse({ slot_date: '01-12-2026', slot_time: '11:00 AM' }));
      assert.throws(() => bookAppointmentSchema.parse({ slot_date: '2026-12-01', slot_time: '' }));
    });
  });
});
