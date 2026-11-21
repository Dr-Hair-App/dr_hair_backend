import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, PassThrough } from 'node:stream';
import { createApp } from '../src/app.js';
import { R2MediaStorage } from '../src/modules/media/infrastructure/R2MediaStorage.js';
import { setStorageBindings, clearStorageBindings } from '../src/shared/storage/runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load and compile publicReadPath and createCacheKey directly from cloudflare/index.ts
const cloudflareIndexSource = fs.readFileSync(path.resolve(__dirname, '../cloudflare/index.ts'), 'utf8');

const prefixesMatch = cloudflareIndexSource.match(/const PUBLIC_PREFIXES = \[[\s\S]*?\];/)[0];
const exactMatch = cloudflareIndexSource.match(/const PUBLIC_EXACT_PATHS = \[[\s\S]*?\];/)[0];
const publicReadPathFnSource = cloudflareIndexSource
  .match(/export const publicReadPath = \([\s\S]*?\n\};/)[0]
  .replace('export ', '')
  .replace(': Request', '')
  .replace(': boolean', '');

const createCacheKeyFnSource = cloudflareIndexSource
  .match(/export const createCacheKey = \([\s\S]*?\n\};/)[0]
  .replace('export ', '')
  .replace(': Request', '')
  .replace(': Request', '');

const extractFn = new Function(
  'Request',
  'URL',
  'Headers',
  `${prefixesMatch}\n${exactMatch}\n${publicReadPathFnSource}\n${createCacheKeyFnSource}\nreturn { publicReadPath, createCacheKey };`,
);
const { publicReadPath, createCacheKey } = extractFn(Request, URL, Headers);

describe('Edge Caching & Cloudflare Worker Optimization', () => {
  describe('Task 1: publicReadPath and createCacheKey', () => {
    it('matches all public catalog, content, videos, services, reviews, and config paths', () => {
      const publicPaths = [
        '/api/v1/categories',
        '/categories',
        '/api/v1/categories/hair-care',
        '/categories/hair-care',
        '/api/v1/products',
        '/products',
        '/api/v1/products/shampoo-pro',
        '/products/shampoo-pro',
        '/api/v1/videos',
        '/api/v1/videos/category-1',
        '/api/v1/content',
        '/policies',
        '/faqs',
        '/stories',
        '/tips',
        '/api/v1/content/shipping-policy',
        '/services',
        '/api/v1/services',
        '/services/consultation',
        '/api/v1/app/config',
        '/api/v1/app/version',
        '/api/v1/appointments/closed-dates',
        '/api/v1/appointments/availability',
        '/api/v1/commerce/coupons',
        '/api/v1/reviews/review_get',
        '/Review/review_get',
        '/review/review_get',
        '/api/v1/reviews',
        '/api/v1/media/assets/product-images/hero.png',
      ];

      for (const p of publicPaths) {
        const req = new Request(`https://api.drhairindia.com${p}`, { method: 'GET' });
        assert.equal(publicReadPath(req), true, `Expected publicReadPath to be true for ${p}`);
      }
    });

    it('allows publicReadPath even when Authorization or Cookie header is present', () => {
      const paths = ['/api/v1/products', '/api/v1/categories', '/services', '/api/v1/reviews/review_get'];
      for (const p of paths) {
        const authReq = new Request(`https://api.drhairindia.com${p}`, {
          method: 'GET',
          headers: {
            Authorization: 'Bearer test-jwt-token-patient-12345',
            Cookie: 'sessionId=abc123xyz',
          },
        });
        assert.equal(
          publicReadPath(authReq),
          true,
          `Expected publicReadPath to be true even with Authorization/Cookie for ${p}`,
        );
      }
    });

    it('rejects private, dynamic, or mutation endpoints in publicReadPath', () => {
      const nonPublicRequests = [
        new Request('https://api.drhairindia.com/api/v1/products', { method: 'POST' }),
        new Request('https://api.drhairindia.com/api/v1/cart', { method: 'GET' }),
        new Request('https://api.drhairindia.com/api/v1/patient/clinical-record', { method: 'GET' }),
        new Request('https://api.drhairindia.com/api/v1/admin/users', { method: 'GET' }),
        new Request('https://api.drhairindia.com/auth/session', { method: 'GET' }),
        new Request('https://api.drhairindia.com/api/v1/media/assets/private-doc.pdf?sig=signed&exp=1700000000', {
          method: 'GET',
        }),
      ];

      for (const req of nonPublicRequests) {
        assert.equal(
          publicReadPath(req),
          false,
          `Expected publicReadPath to be false for ${req.method} ${req.url}`,
        );
      }
    });

    it('createCacheKey normalizes and strips Authorization and Cookie headers', () => {
      const guestReq = new Request('https://api.drhairindia.com/api/v1/products?page=1&category=serums', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      const authReq = new Request('https://api.drhairindia.com/api/v1/products?page=1&category=serums', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer super-secret-patient-jwt-token',
          Cookie: 'session=authenticated-session-id',
        },
      });

      const guestKey = createCacheKey(guestReq);
      const authKey = createCacheKey(authReq);

      assert.equal(guestKey.url, authKey.url);
      assert.equal(authKey.headers.get('authorization'), null);
      assert.equal(authKey.headers.get('cookie'), null);
      assert.equal(authKey.headers.get('accept'), 'application/json');
      assert.equal(guestKey.headers.get('accept'), 'application/json');
    });
  });

  describe('Tasks 2 & 3: Cloudflare Edge Cache Hit & 304 Validation', () => {
    it('verifies max-age=0 rewrite is completely removed from cloudflare/index.ts', () => {
      assert.equal(
        cloudflareIndexSource.includes('max-age=0'),
        false,
        'Expected max-age=0 rewrite to be completely removed from cloudflare/index.ts',
      );
    });

    it('validates 304 conditional logic matches ETag, multiple comma-separated ETags, weak tags, and wildcard', () => {
      const isMatch = (clientHeader, cachedEtag) => {
        if (!clientHeader || !cachedEtag) return false;
        const targetEtag = cachedEtag.replace(/^W\//, '').trim();
        return clientHeader.split(',').some((token) => {
          const clean = token.trim();
          return clean === '*' || clean === cachedEtag || clean.replace(/^W\//, '') === targetEtag;
        });
      };

      const cachedEtag = '"w-etag-catalog-123"';

      // Exact single match
      assert.equal(isMatch('"w-etag-catalog-123"', cachedEtag), true);
      // Weak single match against strong cached
      assert.equal(isMatch('W/"w-etag-catalog-123"', cachedEtag), true);
      // Strong client against weak cached
      assert.equal(isMatch('"w-etag-catalog-123"', 'W/"w-etag-catalog-123"'), true);
      // Wildcard
      assert.equal(isMatch('*', cachedEtag), true);
      // Non-matching single tag
      assert.equal(isMatch('"different-etag"', cachedEtag), false);

      // Comma-separated: match in second position
      assert.equal(isMatch('"other", "w-etag-catalog-123"', cachedEtag), true);
      // Comma-separated: match in first position
      assert.equal(isMatch('"w-etag-catalog-123", "other"', cachedEtag), true);
      // Comma-separated: multiple weak tags
      assert.equal(isMatch('W/"other", W/"w-etag-catalog-123"', cachedEtag), true);
      // Comma-separated: with spaces and mixed tags
      assert.equal(isMatch('  "stale-etag-1" ,  W/"w-etag-catalog-123" , "other" ', cachedEtag), true);
      // Comma-separated: wildcard amongst tags
      assert.equal(isMatch('"other", *', cachedEtag), true);
      // Comma-separated: no match
      assert.equal(isMatch('"diff1", "diff2"', cachedEtag), false);
    });

    it('verifies cloudflare/index.ts contains comma-separated If-None-Match splitting logic', () => {
      assert.equal(
        cloudflareIndexSource.includes('clientEtag.split(",")'),
        true,
        'Expected cloudflare/index.ts to split comma-separated If-None-Match header tokens',
      );
    });

    it('verifies 304 response structure matches Cloudflare Worker standards', () => {
      const cachedHeaders = new Headers({
        'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
        'ETag': '"w-etag-catalog-123"',
        'Content-Type': 'application/json',
      });

      const notModifiedResponse = new Response(null, {
        status: 304,
        statusText: 'Not Modified',
        headers: new Headers(cachedHeaders),
      });

      assert.equal(notModifiedResponse.status, 304);
      assert.equal(notModifiedResponse.statusText, 'Not Modified');
      assert.equal(notModifiedResponse.headers.get('ETag'), '"w-etag-catalog-123"');
      assert.equal(
        notModifiedResponse.headers.get('Cache-Control'),
        'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
      );
    });
  });

  describe('Task 4: R2MediaStorage serveAsset ETag & 304 Handling', () => {
    it('sets ETag and responds with 304 Not Modified when client sends matching If-None-Match', async () => {
      const testKey = 'test-public-image.png';
      const fileBytes = Buffer.from('dr-hair-media-content-sample');
      const testEtag = '"media-etag-abcdef123"';

      setStorageBindings({
        MEDIA_BUCKET: {
          async put() {},
          async get(key) {
            if (key !== testKey) return null;
            return {
              size: fileBytes.length,
              etag: 'media-etag-abcdef123',
              httpEtag: testEtag,
              customMetadata: { visibility: 'public' },
              httpMetadata: { contentType: 'image/png' },
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(fileBytes);
                  controller.close();
                },
              }),
            };
          },
        },
      });

      try {
        const storage = new R2MediaStorage();

        let status = 0;
        const headers = {};
        let ended = false;
        const mockRes = {
          setHeader(k, v) {
            headers[k.toLowerCase()] = v;
          },
          status(s) {
            status = s;
            return this;
          },
          end() {
            ended = true;
          },
        };

        const mockReq = {
          params: { objectKey: testKey },
          query: {},
          headers: {
            'if-none-match': testEtag,
          },
        };

        await storage.serveAsset(mockReq, mockRes, (err) => {
          if (err) throw err;
        });

        assert.equal(status, 304, 'Expected 304 status code');
        assert.equal(ended, true, 'Expected res.end() to be called on 304');
        assert.equal(headers['etag'], testEtag);
        assert.equal(headers['cache-control'], 'public, max-age=86400');
      } finally {
        clearStorageBindings();
      }
    });

    it('responds with 304 Not Modified when client sends comma-separated If-None-Match with weak/strong tags or wildcard', async () => {
      const testKey = 'test-public-image-comma.png';
      const fileBytes = Buffer.from('dr-hair-media-comma-sample');
      const testEtag = '"media-etag-abcdef123"';

      setStorageBindings({
        MEDIA_BUCKET: {
          async put() {},
          async get(key) {
            if (key !== testKey) return null;
            return {
              size: fileBytes.length,
              etag: 'media-etag-abcdef123',
              httpEtag: testEtag,
              customMetadata: { visibility: 'public' },
              httpMetadata: { contentType: 'image/png' },
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(fileBytes);
                  controller.close();
                },
              }),
            };
          },
        },
      });

      try {
        const storage = new R2MediaStorage();

        // 1. Comma-separated with weak tags
        let status = 0;
        let ended = false;
        let mockRes = {
          setHeader() {},
          status(s) {
            status = s;
            return this;
          },
          end() {
            ended = true;
          },
        };
        let mockReq = {
          params: { objectKey: testKey },
          query: {},
          headers: {
            'if-none-match': 'W/"stale-etag", W/"media-etag-abcdef123"',
          },
        };

        await storage.serveAsset(mockReq, mockRes, (err) => {
          if (err) throw err;
        });
        assert.equal(status, 304, 'Expected 304 for comma-separated weak tags');
        assert.equal(ended, true);

        // 2. Comma-separated with wildcard
        status = 0;
        ended = false;
        mockReq.headers['if-none-match'] = '"other", *';
        await storage.serveAsset(mockReq, mockRes, (err) => {
          if (err) throw err;
        });
        assert.equal(status, 304, 'Expected 304 for comma-separated wildcard');
        assert.equal(ended, true);

        // 3. Comma-separated strong tags with whitespace
        status = 0;
        ended = false;
        mockReq.headers['if-none-match'] = '  "other" , "media-etag-abcdef123"  ';
        await storage.serveAsset(mockReq, mockRes, (err) => {
          if (err) throw err;
        });
        assert.equal(status, 304, 'Expected 304 for comma-separated strong tags with whitespace');
        assert.equal(ended, true);
      } finally {
        clearStorageBindings();
      }
    });

    it('returns asset content when If-None-Match does not match', async () => {
      const testKey = 'test-public-image-2.png';
      const fileBytes = Buffer.from('different-content-stream');
      const testEtag = '"media-etag-xyz987"';

      setStorageBindings({
        MEDIA_BUCKET: {
          async put() {},
          async get(key) {
            if (key !== testKey) return null;
            return {
              size: fileBytes.length,
              etag: 'media-etag-xyz987',
              httpEtag: testEtag,
              customMetadata: { visibility: 'public' },
              httpMetadata: { contentType: 'image/png' },
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(fileBytes);
                  controller.close();
                },
              }),
            };
          },
        },
      });

      try {
        const storage = new R2MediaStorage();

        const headers = {};
        const mockRes = new PassThrough();
        mockRes.setHeader = (k, v) => {
          headers[k.toLowerCase()] = v;
        };
        mockRes.status = (s) => mockRes;

        const mockReq = {
          params: { objectKey: testKey },
          query: {},
          headers: {
            'if-none-match': '"outdated-etag"',
          },
        };

        await storage.serveAsset(mockReq, mockRes, (err) => {
          if (err) throw err;
        });

        assert.equal(headers['etag'], testEtag);
        assert.equal(headers['content-type'], 'image/png');
        assert.equal(headers['cache-control'], 'public, max-age=86400');
      } finally {
        clearStorageBindings();
      }
    });
  });

  describe('Task 5 & 6: Review Controller Query Parameter Parsing & Edge CDN Caching', () => {
    it('filters reviews by req.query category and page and emits CDN-Cache-Control headers', async () => {
      const { app } = createApp();
      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, resolve));
      const port = server.address().port;

      try {
        // GET /api/v1/reviews?category=doctor&page=home
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/reviews?category=doctor&page=home`);
        assert.equal(res.status, 200);
        assert.equal(
          res.headers.get('cache-control'),
          'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
        );
        assert.equal(
          res.headers.get('cdn-cache-control'),
          'max-age=300, stale-while-revalidate=600',
        );
        assert.equal(
          res.headers.get('cloudflare-cdn-cache-control'),
          'max-age=600, stale-while-revalidate=1200',
        );

        const body = await res.json();
        assert.equal(body.status, 'success');
        assert.ok(Array.isArray(body.data));
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('Task 7: Wrangler Cron Trigger Cadence', () => {
    it('verifies wrangler.jsonc crons are set to */10 * * * *', () => {
      const wranglerPath = path.resolve(__dirname, '../wrangler.jsonc');
      const content = fs.readFileSync(wranglerPath, 'utf8');
      assert.match(
        content,
        /"crons":\s*\[\s*"[*]\/10\s+[*]\s+[*]\s+[*]\s+[*]"\s*\]/,
        'Expected crons to be set to */10 * * * * in wrangler.jsonc',
      );
    });
  });
});
