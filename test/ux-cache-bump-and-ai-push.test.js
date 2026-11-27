import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpCatalogCacheVersion, CATALOG_CACHE_VERSION_KEY } from '../src/shared/cache/catalog-cache-version.js';
import { ProcessQueuedAiAssessmentUseCase } from '../src/modules/hair_test/application/ProcessQueuedAiAssessmentUseCase.js';

test('bumpCatalogCacheVersion writes a fresh version string to KV without throwing when KV is missing', async () => {
  assert.equal(await bumpCatalogCacheVersion(null), null);

  const written = new Map();
  const mockKv = {
    async put(key, value) {
      written.set(key, value);
    },
  };

  const version = await bumpCatalogCacheVersion(mockKv);
  assert.ok(typeof version === 'string' && version.length > 0);
  assert.equal(written.get(CATALOG_CACHE_VERSION_KEY), version);
});

test('ProcessQueuedAiAssessmentUseCase sends inbox + FCM push when AI assessment completes', async () => {
  const createdNotifications = [];
  const pushed = [];

  const useCase = new ProcessQueuedAiAssessmentUseCase({
    hairTestRepository: {
      async claimNextAiAssessment() {
        return { reference_no: 'HT-TEST-77', userId: 42 };
      },
      async saveAiAssessment(referenceNo, assessment) {
        return { reference_no: referenceNo, userId: 42, ai_assessment: assessment };
      },
      async markAiAssessmentFailed() {
        throw new Error('should not fail');
      },
    },
    geminiAiService: {
      async generateHairTestAssessment() {
        return { ai_status: 'available', scalp_health_score: 78 };
      },
    },
    notificationRepository: {
      async create(payload) {
        createdNotifications.push(payload);
        return payload;
      },
    },
    deviceTokenRepository: {
      async listByUserId(userId) {
        assert.equal(userId, 42);
        return [
          { token: 'fcm-token-active', active: true },
          { token: 'fcm-token-inactive', active: false },
        ];
      },
    },
    sendPushNotification: async (payload) => {
      pushed.push(payload);
      return { messageId: 'msg-1' };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const processed = await useCase.processOne({ referenceNo: 'HT-TEST-77' });
  assert.equal(processed, true);
  assert.equal(createdNotifications.length, 1);
  assert.equal(createdNotifications[0].userId, 42);
  assert.equal(createdNotifications[0].data.reference_no, 'HT-TEST-77');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].token, 'fcm-token-active');
});
