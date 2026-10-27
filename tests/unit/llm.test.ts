// @vitest-environment node

import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, test } from 'vitest';
import { LlmService } from '../../src/main/llm';
import {
  startLlmUpstream,
  type LocalLlmUpstream,
} from '../fixtures/llm-upstream';

const API_KEY = 'sk-test-very-secret-key';
const upstreams: LocalLlmUpstream[] = [];

async function useUpstream(
  handler: Parameters<typeof startLlmUpstream>[0],
): Promise<LocalLlmUpstream> {
  const upstream = await startLlmUpstream(handler);
  upstreams.push(upstream);
  return upstream;
}

function json(response: import('node:http').ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function expectSafeRejection(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) {
    throw new Error('Expected the operation to reject with an Error');
  }

  expect(error.message).toMatch(pattern);
  expect(error.message).not.toContain(API_KEY);
  expect(error.message).not.toContain('Authorization');
  expect(error.message).not.toContain('Bearer ');
  expect(error.message.length).toBeLessThanOrEqual(300);
}

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

describe('LlmService model discovery', () => {
  test('requests models with bearer auth and returns sorted unique non-empty ids', async () => {
    const upstream = await useUpstream((_request, response) => {
      json(response, {
        object: 'list',
        data: [
          { id: 'model-z', object: 'model' },
          { id: 'model-a', object: 'model' },
          { id: 'model-z', object: 'model' },
          { id: '   ', object: 'model' },
          { id: ' model-b ', object: 'model' },
        ],
      });
    });

    const models = await new LlmService().listModels({
      baseUrl: `${upstream.baseUrl}/v1`,
      apiKey: API_KEY,
    });

    expect(models).toEqual(['model-a', 'model-b', 'model-z']);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1/models',
      authorization: `Bearer ${API_KEY}`,
      body: '',
    });
  });

  test.each([
    { scenario: 'missing data', payload: { object: 'list' } },
    { scenario: 'non-array data', payload: { data: {} } },
    { scenario: 'invalid entries', payload: { data: [{ id: 42 }] } },
  ])('rejects an invalid model list with $scenario', async ({ payload }) => {
    const upstream = await useUpstream((_request, response) => {
      json(response, payload);
    });

    await expectSafeRejection(
      new LlmService().listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /invalid model list/i,
    );
  });

  test('does not depend on a selected model for discovery', async () => {
    const upstream = await useUpstream((_request, response) => {
      json(response, { data: [{ id: 'model-a' }] });
    });

    const models = await new LlmService().listModels({
      baseUrl: `${upstream.baseUrl}/v1`,
      apiKey: API_KEY,
      model: 'ignored-model',
    });

    expect(models).toEqual(['model-a']);
    expect(upstream.requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1/models',
      body: '',
    });
  });
});

describe('LlmService chat completions', () => {
  test('tests the selected model with the minimal request and measures real latency', async () => {
    const upstream = await useUpstream(async (_request, response) => {
      await delay(30);
      json(response, {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
      });
    });

    const result = await new LlmService().testModel({
      baseUrl: `${upstream.baseUrl}/v1/`,
      apiKey: API_KEY,
      model: 'model-a',
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('OK');
    expect(result.latencyMs).toBeGreaterThanOrEqual(15);
    expect(Number.isFinite(result.latencyMs)).toBe(true);
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat/completions',
      authorization: `Bearer ${API_KEY}`,
    });
    expect(JSON.parse(upstream.requests[0].body)).toEqual({
      model: 'model-a',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      max_tokens: 4,
      stream: false,
    });
  });

  test('provides a reusable chat completion method with caller supplied messages', async () => {
    const upstream = await useUpstream((_request, response) => {
      json(response, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'first line\nsecond line',
            },
          },
        ],
      });
    });
    const messages = [
      { role: 'system', content: 'Return text only.' },
      { role: 'user', content: 'Hello' },
    ] as const;

    const content = await new LlmService().chatCompletion(
      { baseUrl: upstream.baseUrl, apiKey: API_KEY, model: 'model-a' },
      messages,
      128,
    );

    expect(content).toBe('first line\nsecond line');
    expect(JSON.parse(upstream.requests[0].body)).toEqual({
      model: 'model-a',
      messages,
      max_tokens: 128,
      stream: false,
    });
  });

  test.each([
    { scenario: 'empty choices', payload: { choices: [] } },
    { scenario: 'missing message', payload: { choices: [{}] } },
    {
      scenario: 'non-string content',
      payload: { choices: [{ message: { content: null } }] },
    },
  ])('rejects an invalid chat response with $scenario', async ({ payload }) => {
    const upstream = await useUpstream((_request, response) => {
      json(response, payload);
    });

    await expectSafeRejection(
      new LlmService().testModel({
        baseUrl: upstream.baseUrl,
        apiKey: API_KEY,
        model: 'model-a',
      }),
      /invalid chat completion/i,
    );
  });
});

describe('LlmService failures and privacy', () => {
  test.each([401, 403])('reports HTTP %i as an authentication failure', async (status) => {
    const upstream = await useUpstream((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'text/plain' });
      response.end(`Authorization: Bearer ${API_KEY}`);
    });

    await expectSafeRejection(
      new LlmService().listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /authentication failed/i,
    );
  });

  test('distinguishes a missing model or endpoint', async () => {
    const upstream = await useUpstream((_request, response) => {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `Unknown credential ${API_KEY}` }));
    });

    await expectSafeRejection(
      new LlmService().testModel({
        baseUrl: upstream.baseUrl,
        apiKey: API_KEY,
        model: 'missing-model',
      }),
      /model or endpoint.*not found/i,
    );
  });

  test('aborts a stalled upstream and reports a timeout', async () => {
    const upstream = await useUpstream(() => {
      // Deliberately leave the response open until fixture cleanup.
    });

    await expectSafeRejection(
      new LlmService(25).listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /timed out/i,
    );
  });

  test(
    'aborts a response body that stalls after headers',
    async () => {
      const upstream = await useUpstream((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write(`{"data":[{"id":"${API_KEY}"}`);
        // Keep the body open after flushing incomplete JSON.
      });

      await expectSafeRejection(
        new LlmService(25).listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
        /timed out/i,
      );
    },
    500,
  );

  test('reports a connection failure without exposing credentials', async () => {
    const upstream = await useUpstream((_request, response) => {
      response.end();
    });
    await upstream.close();

    await expectSafeRejection(
      new LlmService().listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /connect/i,
    );
  });

  test('rejects non-JSON success responses without echoing the body', async () => {
    const upstream = await useUpstream((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(`not-json ${API_KEY}`);
    });

    await expectSafeRejection(
      new LlmService().listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /invalid JSON/i,
    );
  });

  test.each([
    'file:///tmp/models',
    'ftp://example.com/v1',
    'not a URL',
    `https://user:${API_KEY}@example.com/v1`,
  ])('rejects an unsafe or unsupported base URL: %s', async (baseUrl) => {
    await expectSafeRejection(
      new LlmService().listModels({ baseUrl, apiKey: API_KEY }),
      /base URL/i,
    );
  });

  test('does not reflect a secret-bearing upstream error body', async () => {
    const upstream = await useUpstream((_request, response) => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end(
        `https://user:${API_KEY}@example.com Authorization: Bearer ${API_KEY}`.repeat(20),
      );
    });

    await expectSafeRejection(
      new LlmService().listModels({ baseUrl: upstream.baseUrl, apiKey: API_KEY }),
      /HTTP 500/i,
    );
  });
});
