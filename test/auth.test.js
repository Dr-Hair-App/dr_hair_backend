import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createContainer } from '../src/container.js';
import { SmsService } from '../src/modules/auth/infrastructure/SmsService.js';

describe('Auth Module - Clean Architecture Tests', () => {
  // Use an injected mock SMS service so tests never contact Fast2SMS.
  const sentOtps = new Map();
  const mockSmsService = {
    async sendOtp(destination, code) {
      sentOtps.set(destination, code);
      return true;
    },
  };
  const container = createContainer({
    smsService: mockSmsService,
  });
  const { sendOtpUseCase, verifyOtpUseCase } = container.useCases;

  it('should send OTP for existing user', async () => {
    const result = await sendOtpUseCase.execute({ login: '9876543210' });
    assert.ok(result.message);
  });

  it('should send OTP for new user', async () => {
    const result = await sendOtpUseCase.execute({ login: '9998887776' });
    assert.ok(result.message);
  });

  it('should verify OTP successfully and issue JWT token', async () => {
    const verifyResult = await verifyOtpUseCase.execute({
      login: '9876543210',
      otp: sentOtps.get('9876543210'),
    });

    assert.equal(verifyResult.message, 'OTP verified successfully.');
    assert.ok(verifyResult.token);
    assert.equal(verifyResult.isRegistered, true);
    assert.equal(verifyResult.user.id, 12);
  });

  it('should fail verification on invalid OTP', async () => {
    // Override NODE_ENV to production temporarily to test failure on wrong OTP
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        async () => {
          await verifyOtpUseCase.execute({
            login: '9876543210',
            otp: '000000',
          });
        },
        { name: 'UnauthorizedError' }
      );
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('authController.verifyLoginOtp should return assessment status and next_step', async () => {
    const { authController } = container.controllers;
    const { sendOtpUseCase } = container.useCases;
    await sendOtpUseCase.execute({ login: '9876543210' });
    const req = { body: { login: '9876543210', otp: sentOtps.get('9876543210') } };
    let jsonResult = null;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        jsonResult = data;
        return this;
      },
    };

    await authController.verifyLoginOtp(req, res, (err) => {
      if (err) throw err;
    });

    assert.ok(jsonResult);
    assert.equal(jsonResult.status, 'success');
    assert.equal(typeof jsonResult.has_completed_assessment, 'boolean');
    assert.ok(['COMPLETE_PROFILE', 'ASSESSMENT', 'HOME'].includes(jsonResult.next_step));
  });

  it('authController.getSession should return full user state with next_step', async () => {
    const { authController } = container.controllers;
    const req = { user: { id: 12, login: '9876543210' } };
    let jsonResult = null;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(data) {
        jsonResult = data;
        return this;
      },
    };

    await authController.getSession(req, res, (err) => {
      if (err) throw err;
    });

    assert.ok(jsonResult);
    assert.equal(jsonResult.status, 'success');
    assert.ok(jsonResult.data);
    assert.equal(jsonResult.data.is_authenticated, true);
    assert.equal(jsonResult.data.is_registered, true);
    assert.equal(typeof jsonResult.data.has_completed_assessment, 'boolean');
    assert.ok(['COMPLETE_PROFILE', 'ASSESSMENT', 'HOME'].includes(jsonResult.data.next_step));
  });

  describe('2Factor.in Integration in SmsService', () => {
    it('fails closed when TWOFACTOR_API_KEY is not configured in any environment', async () => {
      const { SmsService } = await import('../src/modules/auth/infrastructure/SmsService.js');
      const service = new SmsService({ twoFactorConfig: { apiKey: '' } });
      await assert.rejects(
        () => service.sendOtp('9876543210', '123456'),
        { name: 'ServiceUnavailableError', statusCode: 503 },
      );
    });

    it('rejects email destinations because OTP is SMS-only', async () => {
      const { SmsService } = await import('../src/modules/auth/infrastructure/SmsService.js');
      const service = new SmsService({ twoFactorConfig: { apiKey: 'dummy_key' } });
      await assert.rejects(
        () => service.sendOtp('patient@example.com', '123456'),
        { name: 'ServiceUnavailableError', statusCode: 503 },
      );
    });

    it('dispatches to 2Factor.in API with +91 format and handles Success response', async () => {
      const { SmsService } = await import('../src/modules/auth/infrastructure/SmsService.js');
      const originalFetch = globalThis.fetch;
      let requestedUrl = null;

      globalThis.fetch = async (url) => {
        requestedUrl = url;
        return {
          ok: true,
          json: async () => ({
            Status: 'Success',
            Details: '2factor-session-uuid-1234',
          }),
        };
      };

      try {
        const service = new SmsService({
          twoFactorConfig: { apiKey: 'test_2factor_key' },
          provider: '2factor',
        });

        const result = await service.sendOtp('9876543210', '543210');
        assert.equal(result, true);
        assert.equal(requestedUrl, 'https://2factor.in/API/V1/test_2factor_key/SMS/%2B919876543210/543210');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('throws BadGatewayError when 2Factor.in returns Status: Error', async () => {
      const { SmsService } = await import('../src/modules/auth/infrastructure/SmsService.js');
      const originalFetch = globalThis.fetch;

      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          Status: 'Error',
          Details: 'Invalid Phone Number',
        }),
      });

      try {
        const service = new SmsService({
          twoFactorConfig: { apiKey: 'test_2factor_key' },
          provider: '2factor',
        });

        await assert.rejects(
          async () => {
            await service.sendOtp('9876543210', '123456');
          },
          {
            name: 'BadGatewayError',
            statusCode: 502,
          }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('removes fcm_token and revokes session on logout', async () => {
      const { AuthController } = await import('../src/modules/auth/presentation/auth.controller.js');
      const { DeviceTokenRepository } = await import('../src/modules/notifications/infrastructure/DeviceTokenRepository.js');
      const deviceTokenRepo = new DeviceTokenRepository();
      let revokedSession = null;
      const fakeSessionRepo = {
        revoke: async (id, reason) => { revokedSession = { id, reason }; },
      };

      await deviceTokenRepo.register({ userId: 123, token: 'fcm_sample_token_xyz', platform: 'android' });
      assert.equal((await deviceTokenRepo.listByUserId(123)).length, 1);

      const controller = new AuthController({
        sessionRepository: fakeSessionRepo,
        deviceTokenRepository: deviceTokenRepo,
      });

      const req = {
        user: { sessionId: 'ses_123', id: '123' },
        body: { session_id: 'ses_123', fcm_token: 'fcm_sample_token_xyz' },
      };
      let resStatus = null;
      let resData = null;
      const res = {
        status: (s) => { resStatus = s; return res; },
        json: (d) => { resData = d; return res; },
      };
      let nextError = null;
      await controller.logout(req, res, (err) => { nextError = err; });

      assert.equal(nextError, null);
      assert.equal(resStatus, 200);
      assert.equal(resData.data.signed_out, true);
      assert.equal(revokedSession.id, 'ses_123');
      assert.equal((await deviceTokenRepo.listByUserId(123)).length, 0);
    });
  });
});
