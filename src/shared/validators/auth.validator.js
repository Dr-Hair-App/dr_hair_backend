import { z } from 'zod';

const indianPhoneRegex = /^(?:\+91|91)?[6-9]\d{9}$/;

export const phoneSchema = z
  .string({ required_error: 'Phone number is required' })
  .trim()
  .refine((val) => indianPhoneRegex.test(val.replace(/\s+/g, '')), {
    message: 'Valid 10-digit Indian phone number is required (starts with 6-9)',
  })
  .transform((val) => val.replace(/\s+/g, '').replace(/^(?:\+91|91)/, ''));

export const sendLoginOtpSchema = z
  .object({
    login: z.string().trim().optional(),
    mobile: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().email('Invalid email address').optional(),
  })
  .refine((data) => Boolean(data.login || data.mobile || data.phone || data.email), {
    message: 'Mobile number, phone, email, or login identifier is required',
    path: ['login'],
  });

export const verifyLoginOtpSchema = z
  .object({
    login: z.string().trim().optional(),
    mobile: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    email: z.string().trim().optional(),
    otp: z
      .string({ required_error: 'OTP is required' })
      .trim()
      .min(4, 'OTP must be at least 4 digits')
      .max(6, 'OTP cannot exceed 6 digits'),
    fcm_token: z.string().trim().optional(),
    fcmToken: z.string().trim().optional(),
  })
  .refine((data) => Boolean(data.login || data.mobile || data.phone || data.email), {
    message: 'Mobile number, phone, email, or login identifier is required',
    path: ['login'],
  });

export const loginWithPasswordSchema = z
  .object({
    phone: z.string().trim().optional(),
    email: z.string().trim().optional(),
    login: z.string().trim().optional(),
    password: z
      .string({ required_error: 'Password is required' })
      .min(6, 'Password must be at least 6 characters long'),
  })
  .refine((data) => Boolean(data.phone || data.email || data.login), {
    message: 'Either phone, email, or login identifier must be provided',
    path: ['login'],
  });

export const registerUserSchema = z.object({
  phone: phoneSchema,
  name: z.string().trim().min(2, 'Name must be at least 2 characters long').optional(),
  email: z.string().trim().email('Invalid email address').optional(),
  gender: z.enum(['male', 'female', 'other'], {
    errorMap: () => ({ message: 'Gender must be male, female, or other' }),
  }).optional(),
  age: z.coerce.number().int().min(1).max(120).optional(),
});
