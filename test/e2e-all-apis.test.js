process.env.NODE_ENV = 'test';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { config } from '../src/config/env.js';

describe('Comprehensive End-to-End API Audit & Dynamic Contract Verification', () => {
  let server;
  let baseUrl;
  let container;
  const sentOtps = new Map();
  let authToken = null;
  let adminToken = null;
  let testUserId = null;
  const testPhone = '9876543210';

  before(async () => {
    // Injected mock SMS service to capture dynamic OTPs safely
    const mockSmsService = {
      async sendOtp(destination, code) {
        sentOtps.set(destination, code);
        return true;
      },
    };

    const instance = createApp({ smsService: mockSmsService });
    container = instance.container;
    server = http.createServer(instance.app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  describe('1. Health & Root Endpoints', () => {
    it('GET / returns 200 operational and dynamic endpoint catalog', async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.name, 'Dr. Hair Backend API');
      assert.equal(json.version, '1.0.0');
      assert.equal(json.status, 'operational');
      assert.ok(json.endpoints);
      assert.ok(Array.isArray(json.endpoints.auth));
      assert.ok(Array.isArray(json.endpoints.users));
    });

    it('GET /health returns 200 with dynamic uptime, memory, and database status', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'ok');
      assert.ok(typeof json.uptime === 'number');
      assert.ok(json.memory && typeof json.memory.rss_bytes === 'number');
      assert.ok(json.timestamp);
    });
  });

  describe('2. Authentication Flow (OTP, Token, Session & Logout)', () => {
    it('POST /auth/send_login_otp delivers dynamic OTP challenge', async () => {
      const res = await fetch(`${baseUrl}/auth/send_login_otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.message);
      assert.ok(sentOtps.has(testPhone));
    });

    it('POST /auth/verify_login_otp rejects invalid OTP code', async () => {
      const res = await fetch(`${baseUrl}/auth/verify_login_otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone, otp: '000000' }),
      });
      assert.ok([400, 401].includes(res.status));
      const json = await res.json();
      assert.equal(json.status, 'error');
    });

    it('POST /auth/verify_login_otp verifies dynamic OTP and returns JWT token', async () => {
      // Re-send fresh OTP to ensure fresh attempts
      await fetch(`${baseUrl}/auth/send_login_otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone }),
      });
      const capturedOtp = sentOtps.get(testPhone);
      assert.ok(capturedOtp, 'Captured OTP must be available');

      const res = await fetch(`${baseUrl}/auth/verify_login_otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone, otp: capturedOtp }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      authToken = json.token || json.data?.token;
      assert.ok(authToken, 'JWT token must be present');
      assert.ok(json.data, 'User profile data must be present');
      assert.equal(json.data.phone, testPhone);
      testUserId = json.data.id;
    });

    it('GET /auth/session rejects unauthenticated requests with 401', async () => {
      const res = await fetch(`${baseUrl}/auth/session`);
      assert.equal(res.status, 401);
      const json = await res.json();
      assert.equal(json.status, 'error');
    });

    it('GET /auth/session returns dynamic session with Bearer token', async () => {
      const res = await fetch(`${baseUrl}/auth/session`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.id, testUserId);
      assert.ok(json.data.login);
      assert.ok(json.data.is_authenticated);
    });

    it('GET /auth/me returns patient profile', async () => {
      const res = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.user.phone, testPhone);
    });
  });

  describe('3. Users & Profile APIs', () => {
    it('POST /Admin/checkUser returns user status', async () => {
      const res = await fetch(`${baseUrl}/Admin/checkUser`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ mobile: testPhone }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data);
    });

    it('POST /Admin/get_profile returns authenticated profile', async () => {
      const res = await fetch(`${baseUrl}/Admin/get_profile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data);
      assert.equal(json.data.phone, testPhone);
    });

    it('POST /Admin/updateProfile updates profile dynamically', async () => {
      const updatedName = 'Dynamic Patient Verified';
      const res = await fetch(`${baseUrl}/Admin/updateProfile`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ name: updatedName, gender: 'male', age: 31 }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.name, updatedName);
    });
  });

  describe('4. Categories & Catalog APIs', () => {
    it('GET /api/v1/categories returns dynamic categories', async () => {
      const res = await fetch(`${baseUrl}/api/v1/categories`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data);
    });

    it('GET /api/v1/categories/products returns product categories array', async () => {
      const res = await fetch(`${baseUrl}/api/v1/categories/products`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data));
    });

    it('GET /api/v1/categories/videos returns video categories array', async () => {
      const res = await fetch(`${baseUrl}/api/v1/categories/videos`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data));
    });

    it('GET /services returns clean service catalog for mobile home', async () => {
      const res = await fetch(`${baseUrl}/services`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(Array.isArray(json));
      if (json.length > 0) {
        assert.ok(typeof json[0].id === 'string');
        assert.ok(typeof json[0].title === 'string');
      }
    });
  });

  describe('5. Products & Cart APIs', () => {
    let firstProductId = null;

    it('GET /api/v1/products returns product list', async () => {
      const res = await fetch(`${baseUrl}/api/v1/products`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      const products = Array.isArray(json.data) ? json.data : (json.data?.items || []);
      assert.ok(Array.isArray(products));
      if (products.length > 0) {
        firstProductId = products[0].id;
      }
    });

    it('GET /api/v1/cart returns active user cart', async () => {
      const res = await fetch(`${baseUrl}/api/v1/cart`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('POST /api/v1/cart/items adds item dynamically to cart', async () => {
      if (!firstProductId) return;
      const res = await fetch(`${baseUrl}/api/v1/cart/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          productId: firstProductId,
          quantity: 2,
        }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data.items.length >= 1);
    });

    it('DELETE /api/v1/cart clears cart items dynamically', async () => {
      const res = await fetch(`${baseUrl}/api/v1/cart`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.items.length, 0);
    });
  });

  describe('6. Reviews APIs', () => {
    it('GET /Review/review_get returns review list', async () => {
      const res = await fetch(`${baseUrl}/Review/review_get`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data));
    });

    it('POST /Review/create validates and creates a new review', async () => {
      const res = await fetch(`${baseUrl}/Review/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Pooja Sharma',
          rating: 5,
          message: 'Excellent hair care guidance and visible results within 2 months!',
          category: 'Hair Fall',
        }),
      });
      assert.equal(res.status, 201);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.rating, 5);
      assert.equal(json.data.name, 'Pooja Sharma');
    });
  });

  describe('7. Appointments & Public Clinic Endpoints', () => {
    it('GET /api/v1/appointments/closed-dates returns clinic closed dates', async () => {
      const res = await fetch(`${baseUrl}/api/v1/appointments/closed-dates`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('GET /api/v1/appointments/availability returns slot availability', async () => {
      const res = await fetch(`${baseUrl}/api/v1/appointments/availability?from=2026-12-01&to=2026-12-07`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.booked_slots));
    });
  });

  describe('8. Videos, Content & Policies APIs', () => {
    it('GET /api/v1/videos returns video catalog', async () => {
      const res = await fetch(`${baseUrl}/api/v1/videos`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('GET /api/v1/content returns published content banners and items', async () => {
      const res = await fetch(`${baseUrl}/api/v1/content`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data);
    });

    it('GET /api/v1/content/policies returns legal policies summary', async () => {
      const res = await fetch(`${baseUrl}/api/v1/content/policies`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
      assert.ok(json.data.items.length >= 3);
    });

    it('GET /api/v1/content/policies/privacy-policy returns detailed policy document', async () => {
      const res = await fetch(`${baseUrl}/api/v1/content/policies/privacy-policy`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(json.data.title);
      assert.ok(Array.isArray(json.data.sections));
    });
  });

  describe('9. App Config & Dynamic Version Policy', () => {
    it('GET /api/v1/app/config returns dynamic version check, flags, and appointment billing', async () => {
      const res = await fetch(`${baseUrl}/api/v1/app/config?platform=android&version=1.0.0&build=12`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.equal(json.data.platform, 'android');
      assert.ok(json.data.versionCheck);
      assert.ok(json.data.features);
      assert.ok(json.data.appointment_billing);
      assert.equal(typeof json.data.appointment_billing.payment_required, 'boolean');
      assert.ok(json.data.appointment_billing.consultation_fee === null || typeof json.data.appointment_billing.consultation_fee === 'number');
      assert.match(res.headers.get('vary') || '', /X-App-Build/);
    });

    it('enforces the configured minimum build for the exact client build', async () => {
      await container.repositories.appReleasePolicyRepository.setPolicy('android', {
        minVersion: '1.0.0', minBuild: '13', latestVersion: '1.1.0', latestBuild: '15',
        enabled: true, forceUpdate: false, maintenanceMode: false,
        downloadUrl: 'https://play.google.com/store/apps/details?id=com.drhair',
      });
      const response = await fetch(`${baseUrl}/api/v1/app/config?platform=android&version=1.0.0&build=12`);
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.data.versionCheck.updateRequired, true);
      assert.equal(payload.data.versionCheck.minBuild, '13');
    });
  });

  describe('10. Admin Authentication & Management APIs', () => {
    it('POST /api/v1/admin-auth/login authenticates dynamic admin account', async () => {
      const adminEmail = 'audit.admin@drhairindia.com';
      const adminPass = 'AdminSecurePassword@123';

      const created = await container.useCases.createAdminAccountUseCase.execute({
        name: 'Test Administrator',
        email: adminEmail,
        role: 'super_admin',
        roleTemplate: 'super-admin',
        password: adminPass,
      });
      assert.ok(created.account);

      const res = await fetch(`${baseUrl}/api/v1/admin-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: adminEmail,
          password: adminPass,
        }),
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      adminToken = json.data?.token || json.token;
      assert.ok(adminToken, 'Admin JWT token must be returned');
    });

    it('GET /api/v1/admin/users retrieves users list for admin', async () => {
      const res = await fetch(`${baseUrl}/api/v1/admin/users`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('GET /api/v1/admin/products retrieves products for admin', async () => {
      const res = await fetch(`${baseUrl}/api/v1/admin/products`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('GET /api/v1/admin/orders retrieves orders list for admin', async () => {
      const res = await fetch(`${baseUrl}/api/v1/admin/orders`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });

    it('GET /api/v1/admin/coupons retrieves coupons list for admin', async () => {
      const res = await fetch(`${baseUrl}/api/v1/admin/coupons`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.ok(Array.isArray(json.data.items));
    });
  });

  describe('11. Logout & Invalidation', () => {
    it('POST /auth/logout revokes session and invalidates access', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'success');
      assert.match(json.message, /signed out|logged out/i);

      // Verify that subsequent session check fails
      const checkRes = await fetch(`${baseUrl}/auth/session`, {
        headers: { Authorization: `Bearer ${authToken}` },
      });
      assert.equal(checkRes.status, 401);
    });
  });
});
