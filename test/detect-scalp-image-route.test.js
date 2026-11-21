import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import http from 'node:http';
import { createHairTestRouter } from '../src/modules/hair_test/presentation/hair_test.routes.js';

const startServer = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
};

const controllerWith = (detectScalpImage) => new Proxy({ detectScalpImage }, {
  get(target, property) {
    return target[property] || ((_req, _res, next) => next());
  },
});

test('scalp detection route accepts optional auth and one target plus one reference image', async () => {
  const app = express();
  let capturedFiles;
  const controller = controllerWith((req, res) => {
      capturedFiles = req.files;
      return res.status(200).json({ data: { status: 'personMismatch', same_person: false } });
  });
  app.use('/api/v1/hair-tests', createHairTestRouter({ hairTestController: controller }));
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
  const { server, baseUrl } = await startServer(app);

  try {
    const form = new FormData();
    form.append('image', new Blob(['target image'], { type: 'image/jpeg' }), 'target.jpg');
    form.append('reference_image', new Blob(['reference image'], { type: 'image/jpeg' }), 'reference.jpg');

    const response = await fetch(`${baseUrl}/api/v1/hair-tests/detect_scalp_image`, { method: 'POST', body: form });
    assert.equal(response.status, 200, 'the detector can be used without a bearer token');
    assert.deepEqual((await response.json()).data, { status: 'personMismatch', same_person: false });
    assert.equal(capturedFiles.image.length, 1);
    assert.equal(capturedFiles.reference_image.length, 1);
    assert.equal(capturedFiles.image[0].originalname, 'target.jpg');
    assert.equal(capturedFiles.reference_image[0].originalname, 'reference.jpg');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('scalp detection route rejects more than one file in either multipart slot', async () => {
  const app = express();
  const controller = controllerWith((_req, res) => res.status(200).end());
  app.use('/api/v1/hair-tests', createHairTestRouter({ hairTestController: controller }));
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
  const { server, baseUrl } = await startServer(app);

  try {
    for (const duplicateField of ['image', 'reference_image']) {
      const form = new FormData();
      form.append('image', new Blob(['target'], { type: 'image/jpeg' }), 'target.jpg');
      form.append('reference_image', new Blob(['reference'], { type: 'image/jpeg' }), 'reference.jpg');
      form.append(duplicateField, new Blob(['duplicate'], { type: 'image/jpeg' }), 'duplicate.jpg');

      const response = await fetch(`${baseUrl}/api/v1/hair-tests/detect_scalp_image`, { method: 'POST', body: form });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'LIMIT_UNEXPECTED_FILE');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
