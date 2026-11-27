import { getWorkerBindings } from '../database/runtime.js';

export const CATALOG_CACHE_VERSION_KEY = 'catalog_cache_version';

/**
 * Bumps the public catalog/content edge cache version in Cloudflare KV so
 * subsequent public GETs bypass stale Worker Cache API entries immediately.
 */
export async function bumpCatalogCacheVersion(kv = getWorkerBindings()?.PUBLIC_CONFIG_KV) {
  if (!kv || typeof kv.put !== 'function') return null;
  const nextVersion = String(Date.now());
  try {
    await kv.put(CATALOG_CACHE_VERSION_KEY, nextVersion);
    return nextVersion;
  } catch {
    return null;
  }
}
