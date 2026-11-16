import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeAssistantAction, StreamPatientAssistantReplyUseCase } from '../src/modules/ai/application/StreamPatientAssistantReplyUseCase.js';
import { GeminiAiService } from '../src/modules/ai/infrastructure/GeminiAiService.js';
import { PatientAssistantController } from '../src/modules/ai/presentation/patient-assistant.controller.js';

test('patient assistant validates bounded, alternating chat history before calling AI', async () => {
  const calls = [];
  const useCase = new StreamPatientAssistantReplyUseCase({
    geminiAiService: {
      async streamAssistantReply(args) { calls.push(args); },
    },
  });

  await assert.rejects(
    useCase.execute({ messages: [{ role: 'user', content: '  ' }], onToken() {} }),
    /supported role and text/,
  );
  await assert.rejects(
    useCase.execute({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Again' },
      ],
      onToken() {},
    }),
    /alternate/,
  );
  await assert.rejects(
    useCase.execute({ messages: [{ role: 'assistant', content: 'Not a user turn' }], onToken() {} }),
    /start with a user message/,
  );

  await useCase.execute({
    messages: [
      { role: 'user', content: 'What can cause dry scalp?' },
      { role: 'assistant', content: 'There are several common causes.' },
      { role: 'user', content: 'What should I try first?' },
    ],
    onToken() {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages.length, 3);
});

test('Gemini assistant streams SSE text and keeps the API key out of query strings', async () => {
  let request;
  const encoder = new TextEncoder();
  const events = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Start ' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'streaming.' }] } }] })}\n\n`,
  ];
  const service = new GeminiAiService({
    apiKey: 'server-only-test-key',
    model: 'gemini-test',
    logger: { warn() {} },
    fetchFn: async (url, options) => {
      request = { url, options };
      return new Response(new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const chunks = [];
  await service.streamAssistantReply({
    messages: [{ role: 'user', content: 'Help with dry scalp' }],
    onToken: async (chunk) => chunks.push(chunk),
  });

  assert.match(request.url, /models\/gemini-test:streamGenerateContent\?alt=sse/);
  assert.doesNotMatch(request.url, /server-only-test-key/);
  assert.equal(request.options.headers['x-goog-api-key'], 'server-only-test-key');
  assert.equal(JSON.parse(request.options.body).tools[0].functionDeclarations[0].name, 'prepare_app_action');
  assert.deepEqual(chunks, ['Start ', 'streaming.']);
});

test('Gemini assistant returns structured, allowlisted action proposals', async () => {
  const encoder = new TextEncoder();
  const action = {
    kind: 'navigate',
    screen: 'settings',
    message: 'I can open settings for you.',
  };
  const service = new GeminiAiService({
    apiKey: 'test-key',
    logger: { warn() {} },
    fetchFn: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'prepare_app_action', args: action } }] } }] })}\n\n`));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const actions = [];
  await service.streamAssistantReply({
    messages: [{ role: 'user', content: 'Open settings' }],
    patientContext: { profile: { age: 31 } },
    onToken() {},
    onAction: async (value) => actions.push(value),
  });

  assert.deepEqual(actions, [action]);
});

test('assistant action proposals reject unsafe destinations and invalid reminders', () => {
  assert.equal(normalizeAssistantAction({
    kind: 'navigate', screen: 'https://example.com', message: 'Open this link',
  }), null);
  assert.equal(normalizeAssistantAction({
    kind: 'reminder', reminderTitle: 'Take extra medicine', reminderTime: '25:99',
    repeatDays: [1], message: 'Set this reminder',
  }), null);
  assert.deepEqual(normalizeAssistantAction({
    kind: 'navigate', screen: 'settings', message: 'Open app settings',
  }), { kind: 'navigate', screen: 'settings', message: 'Open app settings' });
});

test('controller sends only bounded authenticated patient context to Gemini', async () => {
  let captured;
  const useCase = new StreamPatientAssistantReplyUseCase({
    geminiAiService: {
      async streamAssistantReply(args) { captured = args; },
    },
  });
  const controller = new PatientAssistantController({
    streamPatientAssistantReplyUseCase: useCase,
    userRepository: {
      async findById(id) {
        assert.equal(id, 41);
        return { age: 32, gender: 'female', email: 'private@example.com', phone: '9999999999' };
      },
    },
    hairTestRepository: {
      async findByUserId() {
        return [{
          status: 'submitted',
          main_concern: 'Hair fall',
          scalp_symptoms: ['itching', 'dryness'],
          scalp_photos: [{ url: 'private-photo' }],
        }];
      },
    },
    treatmentRepository: {
      async findByUserId() {
        return [{
          stage: 'Stage 2',
          medications: [{ name: 'private medication' }],
          routine_steps: [{ title: 'Gentle wash', category: 'Lifestyle', time_of_day: 'Night' }],
        }];
      },
    },
  });
  class MockResponse extends EventEmitter {
    writableEnded = false;
    destroyed = false;
    chunks = [];
    status() { return this; }
    set() { return this; }
    flushHeaders() {}
    flush() {}
    write(chunk) { this.chunks.push(chunk); return true; }
    end() { this.writableEnded = true; }
  }
  const response = new MockResponse();
  await controller.streamChat({
    user: { id: 41 },
    body: { messages: [{ role: 'user', content: 'What should I know?' }] },
  }, response, (error) => { throw error; });

  assert.equal(captured.patientContext.profile.age, 32);
  assert.equal(captured.patientContext.latestAssessment.mainConcern, 'Hair fall');
  assert.equal(captured.patientContext.currentCarePlan.routineSteps[0].title, 'Gentle wash');
  assert.doesNotMatch(JSON.stringify(captured.patientContext), /private@example|9999999999|private-photo|private medication/);
});

test('Gemini assistant fails closed when no API key or provider response is available', async () => {
  const missingKey = new GeminiAiService({ apiKey: '', logger: { warn() {} } });
  await assert.rejects(
    missingKey.streamAssistantReply({ messages: [{ role: 'user', content: 'Help' }], onToken() {} }),
    /not configured/,
  );

  const unavailable = new GeminiAiService({
    apiKey: 'test-key',
    fetchFn: async () => new Response('not available', { status: 503 }),
    logger: { warn() {} },
  });
  await assert.rejects(
    unavailable.streamAssistantReply({ messages: [{ role: 'user', content: 'Help' }], onToken() {} }),
    /temporarily unavailable/,
  );
});

test('patient assistant controller returns SSE deltas and action proposals', async () => {
  const useCase = new StreamPatientAssistantReplyUseCase({
    geminiAiService: {
      async streamAssistantReply({ onToken, onAction }) {
        await onToken('Hello ');
        await onToken('there.');
        await onAction({ kind: 'navigate', screen: 'settings', message: 'Open settings' });
      },
    },
  });
  const controller = new PatientAssistantController({
    streamPatientAssistantReplyUseCase: useCase,
  });
  class MockResponse extends EventEmitter {
    statusCode = 0;
    headers = {};
    chunks = [];
    writableEnded = false;
    destroyed = false;

    status(code) { this.statusCode = code; return this; }
    set(headers) { this.headers = headers; return this; }
    flushHeaders() {}
    flush() {}
    write(chunk) { this.chunks.push(chunk); return true; }
    end() { this.writableEnded = true; }
  }

  const response = new MockResponse();
  let forwardedError = null;
  await controller.streamChat(
    { body: { messages: [{ role: 'user', content: 'Hello' }] } },
    response,
    (error) => { forwardedError = error; },
  );

  assert.equal(forwardedError, null);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.equal(response.writableEnded, true);
  assert.ok(response.chunks.some((chunk) => chunk.includes('"text":"Hello "')));
  assert.ok(response.chunks.some((chunk) => chunk.includes('"text":"there."')));
  assert.ok(response.chunks.some((chunk) => chunk.includes('"type":"action"')));
  assert.ok(response.chunks.some((chunk) => chunk.includes('"type":"done"')));
});
