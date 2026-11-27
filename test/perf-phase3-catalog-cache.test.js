import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProductRepository } from '../src/modules/products/infrastructure/ProductRepository.js';
import { clearDatabaseBinding, setDatabaseBinding } from '../src/shared/database/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cloudflareIndexSource = fs.readFileSync(path.resolve(__dirname, '../cloudflare/index.ts'), 'utf8');
const migration0009Source = fs.readFileSync(
  path.resolve(__dirname, '../migrations/0009_product_read_indexes.sql'),
  'utf8',
);

const createCacheKeySource = cloudflareIndexSource
  .match(/export const createCacheKey = \([\s\S]*?\n\};/)[0]
  .replace('export ', '')
  .replace(': Request', '')
  .replace(': Request', '');

const getCatalogCacheVersionSource = cloudflareIndexSource
  .match(/export const getCatalogCacheVersion = async \([\s\S]*?\n\};/)[0]
  .replace('export ', '')
  .replace(': typeof env', '')
  .replace(': Promise<string | null>', '');

const createVersionedCacheKeySource = cloudflareIndexSource
  .match(/export const createVersionedCacheKey = \([\s\S]*?\n\};/)[0]
  .replace('export ', '')
  .replace(': Request', '')
  .replace('?: string | null', '')
  .replace(': Request', '');

const buildCacheHelpers = () => {
  const factory = new Function(
    'Request',
    'URL',
    'Headers',
    `
    const CATALOG_CACHE_VERSION_KEY = "catalog_cache_version";
    const CATALOG_CACHE_VERSION_TTL_MS = 10_000;
    let cachedCatalogVersion = null;
    let cachedCatalogVersionExpiresAt = 0;
    let inFlightCatalogVersionRead = null;
    ${createCacheKeySource}
    ${getCatalogCacheVersionSource}
    ${createVersionedCacheKeySource}
    return { createCacheKey, getCatalogCacheVersion, createVersionedCacheKey };
    `,
  );
  return factory(Request, URL, Headers);
};

test('0009_product_read_indexes.sql defines lowercase expression indexes for category, root_cause, and root_causes', () => {
  assert.match(migration0009Source, /idx_products_status_lower_category_created_at/);
  assert.match(migration0009Source, /idx_products_lower_category_created_at/);
  assert.match(migration0009Source, /idx_products_status_lower_root_cause_created_at/);
  assert.match(migration0009Source, /idx_products_lower_root_cause_created_at/);
  assert.match(migration0009Source, /idx_products_status_lower_root_causes_created_at/);
  assert.match(migration0009Source, /LOWER\(json_extract\(payload, '\$\.category'\)\)/);
  assert.match(migration0009Source, /LOWER\(json_extract\(payload, '\$\.root_cause'\)\)/);
  assert.match(migration0009Source, /LOWER\(json_extract\(payload, '\$\.root_causes'\)\)/);
});

test('ProductRepository.list uses lowercase index-friendly predicates for category and rootCause in D1', async () => {
  const statements = [];
  setDatabaseBinding({
    prepare(sql) {
      const statement = { sql, args: [] };
      statements.push(statement);
      return {
        bind(...args) {
          statement.args = args;
          return {
            all: async () => ({ results: [] }),
            first: async () => ({ total: 0 }),
          };
        },
      };
    },
  });

  try {
    await new ProductRepository().list({
      status: 'ACTIVE',
      category: ' Targeted Peptides ',
      rootCause: ' Stress ',
      page: 2,
      limit: 10,
    });

    assert.equal(statements.length, 2);
    const selectStmt = statements[0];
    assert.match(selectStmt.sql, /json_extract\(payload, '\$\.status'\) = \?/);
    assert.match(selectStmt.sql, /LOWER\(json_extract\(payload, '\$\.category'\)\) = \?/);
    assert.match(selectStmt.sql, /LOWER\(json_extract\(payload, '\$\.root_cause'\)\) = \?/);
    assert.match(selectStmt.sql, /json_each\(payload, '\$\.root_causes'\)/);
    assert.doesNotMatch(selectStmt.sql, /LIKE/);
    assert.ok(selectStmt.sql.includes("ORDER BY json_extract(payload, '$.created_at') DESC LIMIT ? OFFSET ?"));
    assert.deepEqual(selectStmt.args, ['active', 'targeted peptides', 'stress', 'stress', 'stress', 10, 10]);
  } finally {
    clearDatabaseBinding();
  }
});

test('KV-versioned edge cache key caches catalog_cache_version for 10s TTL and preserves createCacheKey compatibility', async () => {
  const { createCacheKey, getCatalogCacheVersion, createVersionedCacheKey } = buildCacheHelpers();

  let kvReads = 0;
  const mockEnv = {
    PUBLIC_CONFIG_KV: {
      async get(key) {
        kvReads += 1;
        assert.equal(key, 'catalog_cache_version');
        return 'v42';
      },
    },
  };

  // Concurrent reads within the same cold isolate deduplicate to 1 KV read
  const [v1, v2] = await Promise.all([
    getCatalogCacheVersion(mockEnv),
    getCatalogCacheVersion(mockEnv),
  ]);
  assert.equal(v1, 'v42');
  assert.equal(v2, 'v42');
  assert.equal(kvReads, 1);

  // Subsequent read within 10s TTL hits isolate-level in-memory cache
  const v3 = await getCatalogCacheVersion(mockEnv);
  assert.equal(v3, 'v42');
  assert.equal(kvReads, 1);

  const req = new Request('https://api.drhairindia.com/api/v1/products?category=serums', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      Cookie: 'session=xyz',
    },
  });

  const baseKey = createCacheKey(req);
  assert.equal(baseKey.url, 'https://api.drhairindia.com/api/v1/products?category=serums');
  assert.equal(baseKey.headers.get('authorization'), null);
  assert.equal(baseKey.headers.get('cookie'), null);

  const unversionedKey = createVersionedCacheKey(req, null);
  assert.equal(unversionedKey.url, baseKey.url);

  const versionedKey = createVersionedCacheKey(req, v3);
  assert.equal(versionedKey.url, 'https://api.drhairindia.com/api/v1/products?category=serums&_cv=v42');
  assert.equal(versionedKey.headers.get('authorization'), null);
  assert.equal(versionedKey.headers.get('cookie'), null);
  assert.equal(versionedKey.headers.get('accept'), 'application/json');
});
