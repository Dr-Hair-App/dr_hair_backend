import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { TokenService } from '../src/shared/utils/token.service.js';

describe('Admin API Permissions & Response Shape Verification', () => {
  const { app, container } = createApp();

  const superAdminToken = TokenService.generateToken({
    id: 1,
    login: 'super@drhair.in',
    role: 'super_admin',
    roleTemplate: 'super-admin',
    permissions: [],
  });

  const operationsAdminToken = TokenService.generateToken({
    id: 2,
    login: 'ops@drhair.in',
    role: 'admin',
    roleTemplate: 'operations-admin',
    permissions: ['products.manage', 'orders.manage', 'promotions.manage', 'bookings.manage'],
  });

  const contentAdminToken = TokenService.generateToken({
    id: 3,
    login: 'content@drhair.in',
    role: 'admin',
    roleTemplate: 'content-admin',
    permissions: ['content.edit', 'media.upload', 'notifications.manage'],
  });

  it('allows operations admin with promotions.manage to access /api/v1/admin/coupons', async () => {
    await container.repositories.adminAccountRepository.create({
      name: 'Operations Admin',
      email: 'ops@drhair.in',
      passwordHash: 'hash',
      role: 'admin',
      roleTemplate: 'operations-admin',
      permissions: ['promotions.manage'],
      active: true,
    });

    const res = await app.handle({
      method: 'GET',
      url: '/api/v1/admin/coupons',
      headers: {
        authorization: `Bearer ${operationsAdminToken}`,
        accept: 'application/json',
      },
    }, {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      status(c) { this.statusCode = c; return this; },
      json(payload) {
        this.payload = payload;
        return this;
      },
      end() { return this; },
    });
  });

  it('coupons list includes both items and coupons array alias for admin panel', async () => {
    let capturedBody;
    const mockRes = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { capturedBody = body; return this; },
      end() {},
    };

    const req = {
      method: 'GET',
      url: '/api/v1/admin/coupons',
      headers: {
        authorization: `Bearer ${operationsAdminToken}`,
      },
      query: {},
    };

    await container.controllers.commerceController.listCoupons(req, mockRes, (err) => {
      if (err) throw err;
    });

    assert.equal(mockRes.statusCode, 200);
    assert.ok(capturedBody);
    assert.equal(capturedBody.status, 'success');
    assert.ok(Array.isArray(capturedBody.data.items));
    assert.ok(Array.isArray(capturedBody.data.coupons));
    assert.equal(capturedBody.data.items, capturedBody.data.coupons);
  });

  it('allows content admin with notifications.manage to access notification history', async () => {
    let capturedBody;
    const mockRes = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { capturedBody = body; return this; },
      end() {},
    };

    const req = {
      method: 'GET',
      url: '/api/v1/admin/notifications/history',
      headers: {
        authorization: `Bearer ${contentAdminToken}`,
      },
      query: {},
      user: {
        id: 3,
        role: 'admin',
        permissions: ['notifications.manage'],
      },
    };

    await container.controllers.notificationController.listCampaigns(req, mockRes, (err) => {
      if (err) throw err;
    });

    assert.equal(mockRes.statusCode, 200);
  });

  it('hair test status update and retrieval supports both reference_no and numeric id', async () => {
    const hairTestRepo = container.repositories.hairTestRepository;
    const testRecord = await hairTestRepo.create({
      userId: 88,
      hair_loss_stage: 'Stage 2',
      main_concern: 'Receding hairline',
    });

    assert.ok(testRecord.reference_no);
    assert.ok(testRecord.id);

    // Find by reference_no
    const byRef = await hairTestRepo.findByReferenceNo(testRecord.reference_no);
    assert.ok(byRef);
    assert.equal(byRef.id, testRecord.id);

    // Find by numeric id string
    const byId = await hairTestRepo.findByReferenceNo(String(testRecord.id));
    assert.ok(byId);
    assert.equal(byId.reference_no, testRecord.reference_no);

    // Edge case: blank or empty identifier returns null and does not false-match id 0
    assert.equal(await hairTestRepo.findByReferenceNo(''), null);
    assert.equal(await hairTestRepo.findByReferenceNo('   '), null);
    assert.equal(await hairTestRepo.findByReferenceNo(null), null);
    assert.equal(await hairTestRepo.findByReferenceNo(undefined), null);

    // Update status by numeric id string
    const updated = await hairTestRepo.updateStatus(String(testRecord.id), 'submitted', {
      changed_by: 'doctor@drhair.in',
      note: 'Verified from panel',
    });
    assert.ok(updated);
    assert.equal(updated.status, 'submitted');
  });
});
