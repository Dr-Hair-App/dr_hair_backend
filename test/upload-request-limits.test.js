import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { config } from '../src/config/env.js';
import { enforceUploadRequestSize, uploadProfile, uploadScalpPhotosToR2 } from '../src/shared/middlewares/upload.middleware.js';
import { uploadMediaFiles } from '../src/shared/middlewares/media-upload.middleware.js';
import { uploadClinicalReportFile } from '../src/shared/middlewares/clinical-report-upload.middleware.js';
import { createPatientClinicalRouter } from '../src/modules/patient/presentation/patient-clinical.routes.js';

test('Content-Length guard rejects oversized bodies before parsing or storage', () => {
  const originalLimit = config.upload.maxRequestSize;
  config.upload.maxRequestSize = 100;
  try {
    let capturedError;
    let nextCalled = false;
    enforceUploadRequestSize(
      { headers: { 'content-length': '101' } },
      {},
      (error) => { capturedError = error; nextCalled = true; },
    );

    assert.equal(nextCalled, true);
    assert.equal(capturedError.statusCode, 413);
    assert.equal(capturedError.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    config.upload.maxRequestSize = originalLimit;
  }
});

test('Content-Length guard permits requests at the configured limit and unknown-length streams', () => {
  const originalLimit = config.upload.maxRequestSize;
  config.upload.maxRequestSize = 100;
  try {
    for (const headers of [{ 'content-length': '100' }, {}]) {
      let nextCalled = false;
      enforceUploadRequestSize({ headers }, {}, (error) => {
        assert.equal(error, undefined);
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    }
  } finally {
    config.upload.maxRequestSize = originalLimit;
  }
});

test('patient assessment uploads enforce request size and mark originals for private source-preserving R2 storage', () => {
  const noOpController = new Proxy({}, { get: () => (_req, _res, next) => next() });
  const router = createPatientClinicalRouter({
    patientClinicalController: noOpController,
    appointmentController: noOpController,
  });
  const route = router.stack.find((layer) => layer.route?.path === '/assessment/submit')?.route;
  assert.ok(route);
  const handlers = route.stack.map((layer) => layer.handle);
  assert.equal(handlers[0], enforceUploadRequestSize, 'the declared body size is rejected before the multipart parser runs');
  assert.equal(handlers[1].name, 'markAssessmentPhotoPurpose');
  assert.equal(typeof handlers[2], 'function', 'R2 streaming multipart parser is installed');
  assert.equal(handlers.at(-1).length, 4, 'upload failures clean up any stored image objects');

  const req = { headers: {} };
  handlers[1](req, {}, () => {});
  assert.equal(req.headers['x-media-purpose'], 'assessment');
});

test('streaming multipart parser bounds both field count and individual field size', async () => {
  const app = express();
  app.post('/upload', uploadScalpPhotosToR2.none(), (_req, res) => res.status(200).end());
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const tooManyFields = new FormData();
    for (let index = 0; index <= config.upload.maxFieldsPerRequest; index += 1) {
      tooManyFields.append(`field_${index}`, 'x');
    }
    const countResponse = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: tooManyFields,
    });
    assert.equal(countResponse.status, 400);
    assert.equal((await countResponse.json()).code, 'LIMIT_FIELD_COUNT');

    const oversizedField = new FormData();
    oversizedField.append('questionnaire', 'x'.repeat(config.upload.maxFieldSize + 1));
    const sizeResponse = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: oversizedField,
    });
    assert.equal(sizeResponse.status, 400);
    assert.equal((await sizeResponse.json()).code, 'LIMIT_FIELD_VALUE');

    assert.equal(config.upload.maxPartsPerRequest, 80);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('clinical report parser preserves title while limiting text field count and size', async () => {
  const app = express();
  app.post('/upload', uploadClinicalReportFile, (req, res) => res.status(200).json({ title: req.body.title }));
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const expectedTitle = 'Blood test results';
    const validReportForm = new FormData();
    validReportForm.append('title', expectedTitle);
    const validResponse = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: validReportForm,
    });
    assert.equal(validResponse.status, 200);
    assert.equal((await validResponse.json()).title, expectedTitle);

    const tooManyFields = new FormData();
    for (let index = 0; index <= config.upload.maxFieldsPerRequest; index += 1) {
      tooManyFields.append(`field_${index}`, 'x');
    }
    const countResponse = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: tooManyFields,
    });
    assert.equal(countResponse.status, 400);
    assert.equal((await countResponse.json()).code, 'LIMIT_FIELD_COUNT');

    const oversizedTitle = new FormData();
    oversizedTitle.append('title', 'x'.repeat(config.upload.maxFieldSize + 1));
    const sizeResponse = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      body: oversizedTitle,
    });
    assert.equal(sizeResponse.status, 400);
    assert.equal((await sizeResponse.json()).code, 'LIMIT_FIELD_VALUE');
    assert.equal(config.upload.maxPartsPerRequest, 80);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('profile and shared media parsers also bound multipart text fields', async () => {
  for (const middleware of [uploadProfile.none(), uploadMediaFiles]) {
    const app = express();
    app.post('/upload', middleware, (_req, res) => res.status(200).end());
    app.use((error, _req, res, _next) => res.status(400).json({ code: error.code }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const form = new FormData();
    for (let index = 0; index <= config.upload.maxFieldsPerRequest; index += 1) {
      form.append(`field_${index}`, 'x');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/upload`, {
        method: 'POST',
        body: form,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'LIMIT_FIELD_COUNT');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }
});
