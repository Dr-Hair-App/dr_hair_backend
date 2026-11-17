import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { store } from '../src/shared/database/store.js';

describe('Performance Headers & Optimization Middleware', () => {
  it('sets public Edge CDN and client cache headers on read-heavy public endpoints', async () => {
    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const endpoints = [
        { path: '/services', expected: 'public, max-age=60, s-maxage=120, stale-while-revalidate=300' },
        { path: '/api/v1/services', expected: 'public, max-age=60, s-maxage=120, stale-while-revalidate=300' },
        { path: '/api/v1/appointments/closed-dates', expected: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' },
        { path: '/api/v1/app/config', expected: 'public, max-age=60, s-maxage=120, stale-while-revalidate=300' },
        { path: '/api/v1/categories', expected: 'public, max-age=120, s-maxage=300, stale-while-revalidate=600' },
        { path: '/api/v1/products', expected: 'public, max-age=30, s-maxage=60, stale-while-revalidate=120' },
        { path: '/api/v1/videos', expected: 'public, max-age=30, s-maxage=60, stale-while-revalidate=120' },
        { path: '/api/v1/content', expected: 'public, max-age=60, s-maxage=120, stale-while-revalidate=300' },
      ];

      for (const ep of endpoints) {
        const res = await fetch(`http://127.0.0.1:${port}${ep.path}`);
        assert.equal(res.status, 200, `Expected 200 for ${ep.path}`);
        assert.equal(
          res.headers.get('cache-control'),
          ep.expected,
          `Expected cache-control header for ${ep.path}`,
        );
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('compresses payloads exceeding the 1024-byte compression threshold with gzip or brotli', async () => {
    const deploymentEnv = process.env.DRHAIR_DEPLOYMENT_ENV;
    delete process.env.DRHAIR_DEPLOYMENT_ENV;
    const originalProductsLength = store.products.length;
    store.products.push({
      id: 'compression-test-product',
      name: 'Compression fixture',
      description: 'test payload '.repeat(300),
      status: 'active',
      price: 100,
      stock: 1,
      in_stock: true,
      images: [],
    });
    const { app } = createApp();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const requestCompressed = (acceptEncoding) => new Promise((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/api/v1/products`, {
          headers: { 'Accept-Encoding': acceptEncoding },
        }, resolve);
        request.once('error', reject);
      });
      const resGzip = await requestCompressed('gzip');
      assert.equal(resGzip.statusCode, 200);
      assert.equal(resGzip.headers['content-encoding'], 'gzip');
      resGzip.resume();

      const resBr = await requestCompressed('br');
      assert.equal(resBr.statusCode, 200);
      assert.equal(resBr.headers['content-encoding'], 'br');
      resBr.resume();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      store.products.splice(originalProductsLength);
      if (deploymentEnv === undefined) delete process.env.DRHAIR_DEPLOYMENT_ENV;
      else process.env.DRHAIR_DEPLOYMENT_ENV = deploymentEnv;
    }
  });
});
