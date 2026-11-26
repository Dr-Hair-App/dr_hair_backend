import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiAiService } from '../src/modules/ai/infrastructure/GeminiAiService.js';
import { clearStorageBindings, setStorageBindings } from '../src/shared/storage/runtime.js';

const responseFor = (bytes) => new Response(bytes);

test('scalp detection sends resized inference-only WebP copies for the target image only', async () => {
  const source = Buffer.alloc(3 * 1024 * 1024, 7);
  source.write('\xff\xd8\xff', 0, 'binary');
  const derivative = Buffer.alloc(64);
  derivative.write('RIFF', 0);
  derivative.write('WEBP', 8);
  let bindingCalls = 0;
  let requestBody;
  setStorageBindings({
    MEDIA_BUCKET: { async put() {} },
    IMAGES: {
      input(bytes) {
        assert.equal(bytes.length, source.length);
        return {
          transform(options) {
            assert.deepEqual(options, { width: 2048, height: 2048, fit: 'scale-down' });
            return this;
          },
          output(options) {
            assert.deepEqual(options, { format: 'image/webp', quality: 100 });
            return Promise.resolve({ response: async () => { bindingCalls += 1; return responseFor(derivative); } });
          },
        };
      },
    },
  });
  try {
    const service = new GeminiAiService({
      apiKey: 'test-key',
      fetchFn: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'hairDetected', is_hair: true }) }] } }] }) };
      },
    });
    const result = await service.detectHairAndScalpImage({
      imageBuffer: source,
      referenceImageBuffer: source,
      mimeType: 'image/jpeg',
      referenceMimeType: 'image/jpeg',
    });
    assert.equal(result.status, 'hairDetected');
    assert.equal(bindingCalls, 1);
    const imageParts = requestBody.contents[0].parts.filter((part) => part.inline_data);
    assert.equal(imageParts.length, 1);
    assert.deepEqual(imageParts.map((part) => part.inline_data.mime_type), ['image/webp']);
    assert.deepEqual(imageParts.map((part) => Buffer.from(part.inline_data.data, 'base64')), [derivative]);
    assert.equal(source.length, 3 * 1024 * 1024, 'the source buffer remains unchanged');
  } finally {
    clearStorageBindings();
  }
});

test('scalp detection does not send an oversized raw inline request when optimization is unavailable', async () => {
  setStorageBindings({ MEDIA_BUCKET: { async put() {} } });
  let requests = 0;
  try {
    const service = new GeminiAiService({
      apiKey: 'test-key',
      fetchFn: async () => { requests += 1; throw new Error('must not dispatch oversized inline data'); },
    });
    const result = await service.detectHairAndScalpImage({
      base64Data: 'a'.repeat(19 * 1024 * 1024),
      referenceBase64: 'b'.repeat(10 * 1024 * 1024),
    });
    assert.equal(result.status, 'verificationUnavailable');
    assert.equal(requests, 0);
  } finally {
    clearStorageBindings();
  }
});

test('scalp detection deduplicates concurrent and repeated checks for the same image and label', async () => {
  let fetchCalls = 0;
  const service = new GeminiAiService({
    apiKey: 'test-key',
    fetchFn: async () => {
      fetchCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'hairDetected', is_hair: true, confidence: 0.94 }) }] } }],
        }),
      };
    },
  });

  const sample = Buffer.from('scalp-sample-bytes');
  const [first, second] = await Promise.all([
    service.detectHairAndScalpImage({ imageBuffer: sample, mimeType: 'image/jpeg', label: 'Top' }),
    service.detectHairAndScalpImage({ imageBuffer: sample, mimeType: 'image/jpeg', label: 'Top' }),
  ]);
  const third = await service.detectHairAndScalpImage({ imageBuffer: sample, mimeType: 'image/jpeg', label: 'Top' });

  assert.equal(first.status, 'hairDetected');
  assert.equal(second.status, 'hairDetected');
  assert.equal(third.status, 'hairDetected');
  assert.equal(fetchCalls, 1);
});

test('scalp detection retries once on transient 503 and does not cache unavailable results', async () => {
  let calls = 0;
  const service = new GeminiAiService({
    apiKey: 'test-key',
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 503, text: async () => 'overloaded' };
      }
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'hairDetected', is_hair: true, confidence: 0.91 }) }] } }],
        }),
      };
    },
  });

  const result = await service.detectHairAndScalpImage({
    imageBuffer: Buffer.from('transient-retry-bytes'),
    mimeType: 'image/jpeg',
    label: 'Front',
  });

  assert.equal(result.status, 'hairDetected');
  assert.equal(calls, 2);
});
