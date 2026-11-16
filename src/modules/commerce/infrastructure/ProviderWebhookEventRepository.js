import { isDatabaseConnected } from '../../../shared/database/database.js';
import { ProviderWebhookEventModel } from '../../../shared/database/models.js';
import { store } from '../../../shared/database/store.js';
import { ConflictError } from '../../../shared/errors/index.js';

const staleClaimMs = 5 * 60 * 1000;

export class ProviderWebhookEventRepository {
  async claim({ provider = 'razorpay', eventId, eventType, payloadHash }) {
    const key = String(eventId || '').trim();
    if (!key) throw new Error('A provider webhook event ID is required.');
    if (key.length > 200) throw new Error('Provider webhook event ID is invalid.');
    const now = new Date();

    if (isDatabaseConnected()) {
      try {
        await ProviderWebhookEventModel.create({
          provider, event_id: key, event_type: eventType, payload_hash: payloadHash,
          status: 'processing', created_at: now, updated_at: now,
        });
        return { claimed: true, duplicate: false };
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }

      const existing = await ProviderWebhookEventModel.findOne({ provider, event_id: key }).lean();
      if (!existing) throw new Error('Webhook event claim could not be read after a duplicate key response.');
      if (existing.payload_hash !== payloadHash) throw new ConflictError('Provider reused an event ID with a different payload.');
      if (existing.status === 'processed') return { claimed: false, duplicate: true };
      const staleBefore = new Date(now.getTime() - staleClaimMs);
      if (existing.status === 'processing' && new Date(existing.updated_at).getTime() > staleBefore.getTime()) {
        return { claimed: false, duplicate: true };
      }
      const reclaimed = await ProviderWebhookEventModel.findOneAndUpdate(
        {
          provider,
          event_id: key,
          $or: [{ status: 'failed' }, { status: 'processing', updated_at: { $lte: staleBefore } }],
        },
        { $set: { status: 'processing', event_type: eventType, payload_hash: payloadHash, last_error_code: '', updated_at: now } },
        { new: true },
      ).lean();
      return reclaimed ? { claimed: true, duplicate: false } : { claimed: false, duplicate: true };
    }

    if (!Array.isArray(store.providerWebhookEvents)) store.providerWebhookEvents = [];
    const existing = store.providerWebhookEvents.find((item) => item.provider === provider && item.event_id === key);
    if (!existing) {
      store.providerWebhookEvents.push({ provider, event_id: key, event_type: eventType, payload_hash: payloadHash, status: 'processing', created_at: now, updated_at: now, last_error_code: '' });
      return { claimed: true, duplicate: false };
    }
    if (existing.payload_hash !== payloadHash) throw new ConflictError('Provider reused an event ID with a different payload.');
    if (existing.status === 'processed') return { claimed: false, duplicate: true };
    if (existing.status === 'processing' && now.getTime() - new Date(existing.updated_at).getTime() < staleClaimMs) {
      return { claimed: false, duplicate: true };
    }
    Object.assign(existing, { status: 'processing', event_type: eventType, payload_hash: payloadHash, updated_at: now, last_error_code: '' });
    return { claimed: true, duplicate: false };
  }

  async markProcessed({ provider = 'razorpay', eventId }) {
    const filter = { provider, event_id: String(eventId) };
    if (isDatabaseConnected()) {
      await ProviderWebhookEventModel.updateOne(filter, { $set: { status: 'processed', updated_at: new Date() } });
      return;
    }
    const event = (store.providerWebhookEvents || []).find((item) => item.provider === provider && item.event_id === String(eventId));
    if (event) Object.assign(event, { status: 'processed', updated_at: new Date() });
  }

  async markFailed({ provider = 'razorpay', eventId, errorCode = 'processing_failed' }) {
    const filter = { provider, event_id: String(eventId) };
    if (isDatabaseConnected()) {
      await ProviderWebhookEventModel.updateOne(filter, { $set: { status: 'failed', last_error_code: String(errorCode).slice(0, 80), updated_at: new Date() } });
      return;
    }
    const event = (store.providerWebhookEvents || []).find((item) => item.provider === provider && item.event_id === String(eventId));
    if (event) Object.assign(event, { status: 'failed', last_error_code: String(errorCode).slice(0, 80), updated_at: new Date() });
  }
}
