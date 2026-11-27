import { RateLimitCounterModel } from '../database/models.js';

const MAX_BLOCKED_CACHE_SIZE = 1000;

/** Persistent express-rate-limit store shared by all production instances with in-memory fallback. */
export class D1RateLimitStore {
  constructor(namespace) {
    this.namespace = namespace;
    this.windowMs = 15 * 60 * 1000;
    this.limit = null;
    this.localKeys = false;
    this.fallback = new Map();
    this.blockedCache = new Map();
  }

  init(options) {
    this.windowMs = options.windowMs;
    const configuredLimit = options?.limit ?? options?.max;
    this.limit = typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : null;
  }

  key(key) {
    return `${this.namespace}:${String(key || 'unknown')}`;
  }

  _getBlockedEntry(storageKey, nowMs = Date.now()) {
    const entry = this.blockedCache.get(storageKey);
    if (!entry) return null;
    if (entry.resetTime.getTime() <= nowMs) {
      this.blockedCache.delete(storageKey);
      return null;
    }
    return entry;
  }

  _cacheIfBlocked(storageKey, result) {
    if (this.limit === null || !result || result.totalHits <= this.limit) return result;
    const nowMs = Date.now();
    if (!(result.resetTime instanceof Date) || result.resetTime.getTime() <= nowMs) return result;
    if (this.blockedCache.size >= MAX_BLOCKED_CACHE_SIZE) {
      for (const [k, v] of this.blockedCache) {
        if (v.resetTime.getTime() <= nowMs) this.blockedCache.delete(k);
      }
      if (this.blockedCache.size >= MAX_BLOCKED_CACHE_SIZE) {
        const oldestKey = this.blockedCache.keys().next().value;
        if (oldestKey !== undefined) this.blockedCache.delete(oldestKey);
      }
    }
    this.blockedCache.set(storageKey, { totalHits: result.totalHits, resetTime: result.resetTime });
    return result;
  }

  _fallbackIncrement(storageKey) {
    const now = Date.now();
    let entry = this.fallback.get(storageKey);
    const entryResetMs = entry?.resetTime instanceof Date ? entry.resetTime.getTime() : new Date(entry?.resetTime).getTime();
    if (!entry || Number.isNaN(entryResetMs) || entryResetMs <= now) {
      entry = { totalHits: 1, resetTime: new Date(now + this.windowMs) };
    } else {
      entry.totalHits += 1;
    }
    this.fallback.set(storageKey, entry);
    return { totalHits: entry.totalHits, resetTime: entry.resetTime };
  }

  async get(key) {
    const storageKey = this.key(key);
    const blocked = this._getBlockedEntry(storageKey);
    if (blocked) return { totalHits: blocked.totalHits, resetTime: blocked.resetTime };
    try {
      const item = await RateLimitCounterModel.findOne({ key: storageKey, resetTime: { $gt: new Date() } }).lean();
      return item ? this._cacheIfBlocked(storageKey, { totalHits: item.totalHits, resetTime: new Date(item.resetTime) }) : undefined;
    } catch {
      return this.fallback.get(storageKey);
    }
  }

  async increment(key) {
    const storageKey = this.key(key);
    const blocked = this._getBlockedEntry(storageKey);
    if (blocked) {
      blocked.totalHits += 1;
      return { totalHits: blocked.totalHits, resetTime: blocked.resetTime };
    }
    try {
      const now = new Date();
      const active = await RateLimitCounterModel.findOneAndUpdate(
        { key: storageKey, resetTime: { $gt: now } },
        { $inc: { totalHits: 1 } },
        { new: true },
      ).lean();
      if (active) return this._cacheIfBlocked(storageKey, { totalHits: active.totalHits, resetTime: new Date(active.resetTime) });

      const resetTime = new Date(now.getTime() + this.windowMs);
      const expired = await RateLimitCounterModel.findOneAndUpdate(
        { key: storageKey, resetTime: { $lte: now } },
        { $set: { totalHits: 1, resetTime } },
        { new: true },
      ).lean();
      if (expired) return this._cacheIfBlocked(storageKey, { totalHits: expired.totalHits, resetTime: new Date(expired.resetTime) });

      try {
        const created = await RateLimitCounterModel.create({ key: storageKey, totalHits: 1, resetTime });
        return this._cacheIfBlocked(storageKey, { totalHits: created.totalHits, resetTime: new Date(created.resetTime) });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const raced = await RateLimitCounterModel.findOneAndUpdate(
          { key: storageKey, resetTime: { $gt: new Date() } },
          { $inc: { totalHits: 1 } },
          { new: true },
        ).lean();
        if (raced) return this._cacheIfBlocked(storageKey, { totalHits: raced.totalHits, resetTime: new Date(raced.resetTime) });
        throw error;
      }
    } catch {
      return this._fallbackIncrement(storageKey);
    }
  }

  async decrement(key) {
    const storageKey = this.key(key);
    this.blockedCache.delete(storageKey);
    try {
      await RateLimitCounterModel.updateOne(
        { key: storageKey, totalHits: { $gt: 0 } },
        { $inc: { totalHits: -1 } },
      );
    } catch {
      const entry = this.fallback.get(storageKey);
      if (entry && entry.totalHits > 0) entry.totalHits -= 1;
    }
  }

  async resetKey(key) {
    const storageKey = this.key(key);
    this.blockedCache.delete(storageKey);
    this.fallback.delete(storageKey);
    try {
      await RateLimitCounterModel.deleteOne({ key: storageKey });
    } catch {
      // Fallback already cleared above.
    }
  }

  async resetAll() {
    this.blockedCache.clear();
    this.fallback.clear();
    try {
      await RateLimitCounterModel.deleteMany({ key: new RegExp(`^${this.namespace}:`) });
    } catch {
      // Fallback already cleared above.
    }
  }
}
