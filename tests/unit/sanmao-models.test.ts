// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import { listSanmaoModels } from '../../src/main/sanmao-models';

const connection = {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'secret-key',
};

describe('Sanmao model discovery', () => {
  test('lists unique model ids with Anthropic authentication', async () => {
    let requestUrl = '';
    let headers: Record<string, string> = {};
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      requestUrl = String(input);
      headers = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([key, value]) => [key, String(value)]),
      );
      return Response.json({
        data: [{ id: 'claude-b' }, { id: 'claude-a' }, { id: 'claude-a' }, { id: '' }],
      });
    });

    await expect(listSanmaoModels(connection, { fetchImpl })).resolves.toEqual([
      'claude-a',
      'claude-b',
    ]);
    expect(requestUrl).toBe('https://api.anthropic.com/v1/models');
    expect(headers).toMatchObject({
      'x-api-key': 'secret-key',
      'anthropic-version': '2023-06-01',
    });
  });

  test('does not duplicate an existing v1 path', async () => {
    let requestUrl = '';
    const fetchImpl = vi.fn(async (input: unknown) => {
      requestUrl = String(input);
      return Response.json({ data: [{ id: 'claude-a' }] });
    });

    await listSanmaoModels({
      ...connection,
      baseUrl: 'https://claude.test/v1/',
    }, { fetchImpl });

    expect(requestUrl).toBe('https://claude.test/v1/models');
  });

  test.each([
    'https://api.anthropic.com/v1/messages',
    'https://api.anthropic.com/v1/chat/completions',
  ])('normalizes a full chat endpoint to the models endpoint: %s', async (baseUrl) => {
    let requestUrl = '';
    const fetchImpl = vi.fn(async (input: unknown) => {
      requestUrl = String(input);
      return Response.json({ data: [{ id: 'claude-a' }] });
    });

    await listSanmaoModels({ ...connection, baseUrl }, { fetchImpl });

    expect(requestUrl).toBe('https://api.anthropic.com/v1/models');
  });

  test('rejects authentication failures without exposing the key', async () => {
    const pending = listSanmaoModels(connection, {
      fetchImpl: async () => new Response(null, { status: 401 }),
    });

    let message = '';
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/认证|401/);
    expect(message).not.toContain(connection.apiKey);
  });

  test('rejects an invalid model response', async () => {
    await expect(listSanmaoModels(connection, {
      fetchImpl: async () => Response.json({ models: [] }),
    })).rejects.toThrow(/模型|model|response/i);
  });

  test('times out a stalled model request', async () => {
    await expect(listSanmaoModels(connection, {
      timeoutMs: 10,
      fetchImpl: async (_input, init) => new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
          once: true,
        });
      }),
    })).rejects.toThrow(/超时|timeout/i);
  });
});
