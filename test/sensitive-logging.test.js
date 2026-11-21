import test from 'node:test';
import assert from 'node:assert/strict';
import { PatientArchiveService } from '../src/modules/admin/application/PatientArchiveService.js';
import { setStorageBindings, clearStorageBindings } from '../src/shared/storage/runtime.js';
import { SmsService } from '../src/modules/auth/infrastructure/SmsService.js';
import { GeminiAiService } from '../src/modules/ai/infrastructure/GeminiAiService.js';
import { CampaignSchedulerService } from '../src/modules/notifications/application/CampaignSchedulerService.js';
import { cleanupUploadedProductFiles } from '../src/modules/products/application/product-media-input.js';
import { DeleteProductUseCase } from '../src/modules/products/application/DeleteProductUseCase.js';
import { UpdateProductUseCase } from '../src/modules/products/application/UpdateProductUseCase.js';

test('archive purge logs neither clinical report identifiers nor storage errors', async () => {
  const secret = 'clinical-report-secret-9231';
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    const fakeBucket = { put: async () => {}, head: async () => ({}), delete: async () => {} };
    setStorageBindings({ USER_MEDIA_BUCKET: fakeBucket, ADMIN_MEDIA_BUCKET: fakeBucket });
    const service = new PatientArchiveService({
      clinicalReportRepository: {
        listExpiredArchives: async () => [{ id: secret, userId: secret, public_id: `private/${secret}` }],
        purgeArchived: async () => { throw new Error(`database rejected ${secret}`); },
      },
    });
    await service.purgeExpiredReports();
  } finally {
    clearStorageBindings();
    console.warn = originalWarn;
  }
  assert.match(lines.join('\n'), /Archived clinical report purge failed/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(secret));
});

test('SMS provider success and failure details never log or return OTP/session secrets', async () => {
  const secret = 'session-otp-secret-482910';
  const logs = [];
  const logger = {
    info: (...parts) => logs.push(parts.join(' ')),
    warn: (...parts) => logs.push(parts.join(' ')),
    error: (...parts) => logs.push(parts.join(' ')),
  };
  const service = new SmsService({
    twoFactorConfig: { apiKey: 'test-key' },
    logger,
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ Status: 'Success', Details: secret }) });
    await service.sendOtp('9876543210', '482910');
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ Status: 'Error', Details: secret }) });
    await assert.rejects(
      () => service.sendOtp('9876543210', '482910'),
      (error) => error.message === 'SMS delivery failed. Please try again.',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
});

test('Gemini invalid response logs omit raw patient-shaped model output', async () => {
  const secret = 'patient-clinical-summary-secret';
  const logs = [];
  const service = new GeminiAiService({
    apiKey: 'test-key',
    fetchFn: async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: `invalid response ${secret}` }] } }] }),
    }),
    logger: {
      info: (...parts) => logs.push(parts.join(' ')),
      warn: (...parts) => logs.push(parts.join(' ')),
      error: (...parts) => logs.push(parts.join(' ')),
    },
  });
  const result = await service.generateHairTestAssessment({});
  assert.equal(result.ai_status, 'unavailable');
  assert.match(logs.join('\n'), /invalid structured assessment/);
  assert.doesNotMatch(logs.join('\n'), new RegExp(secret));
});

test('campaign scheduler logs error class without campaign or provider error content', async () => {
  const secret = 'campaign-body-and-token-secret';
  const lines = [];
  const originalError = console.error;
  console.error = (...parts) => lines.push(parts.join(' '));
  try {
    const service = new CampaignSchedulerService({
      campaignRepository: { listDueScheduled: async () => { throw new Error(secret); } },
      deviceTokenRepository: {},
      notificationRepository: {},
    });
    await service.processDueCampaigns();
  } finally {
    console.error = originalError;
  }
  assert.doesNotMatch(lines.join('\n'), new RegExp(secret));
  assert.match(lines.join('\n'), /Processing due campaigns failed \(Error\)/);
});

test('product media cleanup warnings omit storage keys and provider error details', async () => {
  const secret = 'catalog-object-key-secret-2234';
  const lines = [];
  const originalWarn = console.warn;
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    await cleanupUploadedProductFiles(
      [{ key: `drhair/images/admin/product/${secret}.webp` }],
      { deleteImage: async () => { throw new Error(`storage request ${secret}`); } },
    );

    const existing = {
      id: 'product-1', name: 'Product', category: 'Care', price: 10,
      images: [`drhair/images/admin/product/${secret}.webp`], media: [],
      supply_plans: [{
        id: 'plan-1', title: 'Single Pack', price: 10, mrp: 10,
        shipping_profile: { weight_kg: 0.1, length_cm: 10, breadth_cm: 10, height_cm: 10 },
      }],
    };
    const references = { isReferenced: async () => false };
    await new DeleteProductUseCase({
      productRepository: { findById: async () => existing, delete: async () => true },
      imageStorage: { deleteImage: async () => { throw new Error(`storage request ${secret}`); } },
      mediaReferenceRepository: references,
    }).execute({ id: existing.id });

    await new UpdateProductUseCase({
      productRepository: {
        findById: async () => existing,
        update: async (_id, updated) => ({ ...updated, images: [], media: [] }),
      },
      imageStorage: { deleteImage: async () => { throw new Error(`storage request ${secret}`); } },
      mediaReferenceRepository: references,
    }).execute({ id: existing.id, media: [] }, { replaceMedia: true });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal((lines.join('\n').match(/\[media-cleanup\]/g) || []).length, 2);
  assert.match(lines.join('\n'), /\[product-media-cleanup\]/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(secret));
  assert.doesNotMatch(lines.join('\n'), /storage request/);
});
