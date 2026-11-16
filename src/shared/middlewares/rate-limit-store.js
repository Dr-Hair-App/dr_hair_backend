import { isDatabaseConnected } from '../database/database.js';
import { D1RateLimitStore } from './d1-rate-limit-store.js';

export const createRateLimitStore = (namespace) => {
  try {
    return isDatabaseConnected() ? new D1RateLimitStore(namespace) : undefined;
  } catch {
    return undefined;
  }
};
