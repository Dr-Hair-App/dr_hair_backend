import { FeatureFlagModel } from '../../../shared/database/models.js';
import { isDatabaseConnected } from '../../../shared/database/database.js';
import { store } from '../../../shared/database/store.js';

const EVALUATE_CACHE_TTL_MS = 30_000;
const EVALUATE_CACHE_MAX_ENTRIES = 500;
const evaluateCache = new Map();

const invalidateEvaluateCache = (key) => {
  const prefix = `${String(key || '').trim()}:`;
  for (const cacheKey of evaluateCache.keys()) {
    if (cacheKey.startsWith(prefix)) {
      evaluateCache.delete(cacheKey);
    }
  }
};

export class FeatureFlagRepository {
  async list({ platform, enabled } = {}) {
    if (isDatabaseConnected()) {
      const query = {};
      if (typeof enabled === 'boolean') query.enabled = enabled;
      if (platform && platform !== 'all') {
        if (platform === 'admin') query.platform = 'admin';
        else query.$or = [{ platform }, { platform: 'all' }];
      }
      return FeatureFlagModel.find(query).sort({ group: 1, key: 1 }).lean();
    }

    store.featureFlags = store.featureFlags || [];
    let items = [...store.featureFlags];
    if (typeof enabled === 'boolean') {
      items = items.filter((f) => f.enabled === enabled);
    }
    if (platform && platform !== 'all') {
      items = items.filter((f) => platform === 'admin' ? f.platform === 'admin' : f.platform === platform || f.platform === 'all');
    }
    items.sort((a, b) => a.group.localeCompare(b.group) || a.key.localeCompare(b.key));
    return items;
  }

  async findByKey(key) {
    if (!key) return null;
    const cleanKey = String(key).trim();
    if (isDatabaseConnected()) {
      return FeatureFlagModel.findOne({ key: cleanKey }).lean();
    }
    store.featureFlags = store.featureFlags || [];
    return store.featureFlags.find((f) => f.key === cleanKey) || null;
  }

  async setFlag(key, updates = {}) {
    const cleanKey = String(key).trim();
    invalidateEvaluateCache(cleanKey);
    const now = new Date();

    if (isDatabaseConnected()) {
      return FeatureFlagModel.findOneAndUpdate(
        { key: cleanKey },
        {
          $set: {
            ...updates,
            updated_at: now,
          },
          $setOnInsert: {
            created_at: now,
            title: updates.title || cleanKey,
            group: updates.group || 'General',
          },
        },
        { new: true, upsert: true },
      ).lean();
    }

    store.featureFlags = store.featureFlags || [];
    const index = store.featureFlags.findIndex((f) => f.key === cleanKey);
    if (index >= 0) {
      const existing = store.featureFlags[index];
      const updated = {
        ...existing,
        ...updates,
        updated_at: now.toISOString(),
      };
      store.featureFlags[index] = updated;
      return updated;
    }

    const created = {
      key: cleanKey,
      title: updates.title || cleanKey,
      description: updates.description || '',
      group: updates.group || 'General',
      enabled: typeof updates.enabled === 'boolean' ? updates.enabled : true,
      platform: updates.platform || 'all',
      rolloutPercentage: Number(updates.rolloutPercentage) || 100,
      effectiveDate: updates.effectiveDate ? new Date(updates.effectiveDate).toISOString() : null,
      metadata: updates.metadata || {},
      updatedBy: String(updates.updatedBy || 'Super Admin'),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    store.featureFlags.push(created);
    return created;
  }

  async getFlag(key) {
    return this.findByKey(key);
  }

  async evaluate(key, { platform = 'all' } = {}) {
    const cleanKey = String(key || '').trim();
    const cacheKey = `${cleanKey}:${platform}`;
    const now = Date.now();
    const cached = evaluateCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { ...cached.value };
    }

    const flag = await this.findByKey(key);
    let result;
    let ttlMs = EVALUATE_CACHE_TTL_MS;

    if (!flag) {
      result = { key, enabled: false, reason: 'NOT_FOUND' };
    } else if (!flag.enabled) {
      result = { key, enabled: false, reason: 'DISABLED' };
    } else if (flag.platform !== 'all' && platform !== 'all' && flag.platform !== platform) {
      result = { key, enabled: false, reason: 'PLATFORM_MISMATCH' };
    } else if (flag.effectiveDate && new Date(flag.effectiveDate).getTime() > now) {
      result = { key, enabled: false, reason: 'EFFECTIVE_DATE_FUTURE' };
      ttlMs = Math.min(EVALUATE_CACHE_TTL_MS, Math.max(1, new Date(flag.effectiveDate).getTime() - now));
    } else {
      result = { key, enabled: true, rolloutPercentage: flag.rolloutPercentage };
    }

    if (evaluateCache.size >= EVALUATE_CACHE_MAX_ENTRIES) {
      for (const [entryKey, entry] of evaluateCache) {
        if (entry.expiresAt <= now) evaluateCache.delete(entryKey);
        if (evaluateCache.size < EVALUATE_CACHE_MAX_ENTRIES) break;
      }
      if (evaluateCache.size >= EVALUATE_CACHE_MAX_ENTRIES) {
        evaluateCache.delete(evaluateCache.keys().next().value);
      }
    }
    evaluateCache.set(cacheKey, { value: result, expiresAt: now + ttlMs });
    return { ...result };
  }
}

