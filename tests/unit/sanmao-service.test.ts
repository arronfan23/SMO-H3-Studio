// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  SanmaoService,
  normalizeClaudeExecutablePath,
  type SanmaoQuery,
  type SanmaoQueryInput,
} from '../../src/main/sanmao-service';

const credentials = {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-test',
  apiKey: 'secret-sanmao-key',
};

function successfulQuery(messages: unknown[]): SanmaoQuery {
  return async function* () {
    yield* messages as never[];
  };
}

function textDelta(text: string): unknown {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
  };
}

function success(text: string): unknown {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
  };
}

function createService(queryImpl: SanmaoQuery, timeoutMs = 1_000) {
  return new SanmaoService({
    store: {
      getCredentials: vi.fn(async () => credentials),
    },
    queryImpl,
    timeoutMs,
    claudeExecutablePath: 'G:\\claude-test\\claude.exe',
  });
}

describe('SanmaoService', () => {
  test('maps an asar native executable to its unpacked location', () => {
    expect(normalizeClaudeExecutablePath(
      'C:\\app\\resources\\app.asar\\node_modules\\claude.exe',
    )).toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\claude.exe');
    expect(normalizeClaudeExecutablePath(
      'C:\\app\\resources\\app.asar.unpacked\\node_modules\\claude.exe',
    )).toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\claude.exe');
  });

  test('streams text with tools disabled and keeps conversation context in memory', async () => {
    const prompts: string[] = [];
    const options: Options[] = [];
    const service = createService((input: SanmaoQueryInput) => {
      prompts.push(input.prompt);
      options.push(input.options);
      return successfulQuery([
        textDelta('你好'),
        textDelta('，我是三脚猫'),
        success('你好，我是三脚猫'),
      ])(input);
    });
    const chunks: string[] = [];

    const first = await service.send({
      conversationId: '00000000-0000-4000-8000-000000000001',
      replyId: '00000000-0000-4000-8000-000000000011',
      text: '你好',
      onText: (text) => chunks.push(text),
    });

    expect(first.text).toBe('你好，我是三脚猫');
    expect(chunks.join('')).toBe(first.text);
    expect(options[0]).toMatchObject({
      tools: [],
      includePartialMessages: true,
      persistSession: false,
      maxTurns: 1,
      model: 'claude-test',
      pathToClaudeCodeExecutable: 'G:\\claude-test\\claude.exe',
    });
    expect(options[0].env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'secret-sanmao-key',
    });

    await service.send({
      conversationId: '00000000-0000-4000-8000-000000000001',
      replyId: '00000000-0000-4000-8000-000000000012',
      text: '再介绍一次',
      onText: () => undefined,
    });
    expect(prompts[1]).toContain('你好，我是三脚猫');
    expect(prompts[1]).toContain('再介绍一次');
  });

  test('cancels the active reply through its AbortController', async () => {
    const query = vi.fn((input: SanmaoQueryInput) => {
      return (async function* () {
        await new Promise<never>((_resolve, reject) => {
          input.options.abortController?.signal.addEventListener('abort', () => {
            reject(new Error('aborted by user'));
          }, { once: true });
        });
      })();
    });
    const service = createService(query);
    const pending = service.send({
      conversationId: '00000000-0000-4000-8000-000000000002',
      replyId: '00000000-0000-4000-8000-000000000021',
      text: '停止测试',
      onText: () => undefined,
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

    service.cancel('00000000-0000-4000-8000-000000000021');

    await expect(pending).rejects.toThrow(/aborted|取消|停止/i);
  });

  test('rejects concurrent sends and times out a stalled request', async () => {
    const query = vi.fn((input: SanmaoQueryInput) => (async function* () {
      await new Promise<never>((_resolve, reject) => {
        input.options.abortController?.signal.addEventListener('abort', () => {
          reject(new Error('request aborted'));
        }, { once: true });
      });
    })());
    const service = createService(query, 20);

    await expect(service.send({
      conversationId: '00000000-0000-4000-8000-000000000003',
      replyId: '00000000-0000-4000-8000-000000000031',
      text: '超时测试',
      onText: () => undefined,
    })).rejects.toThrow(/超时|timeout/i);
  });

  test('rejects a second send while the first reply is active', async () => {
    const query = vi.fn((input: SanmaoQueryInput) => (async function* () {
      await new Promise<never>((_resolve, reject) => {
        input.options.abortController?.signal.addEventListener('abort', () => {
          reject(new Error('request aborted'));
        }, { once: true });
      });
    })());
    const service = createService(query);
    const first = service.send({
      conversationId: '00000000-0000-4000-8000-000000000005',
      replyId: '00000000-0000-4000-8000-000000000051',
      text: '第一条消息',
      onText: () => undefined,
    });
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());

    await expect(service.send({
      conversationId: '00000000-0000-4000-8000-000000000006',
      replyId: '00000000-0000-4000-8000-000000000052',
      text: '第二条消息',
      onText: () => undefined,
    })).rejects.toThrow(/正在回复/);
    service.cancel('00000000-0000-4000-8000-000000000051');
    await expect(first).rejects.toThrow(/停止|aborted/i);
  });

  test('sanitizes SDK failures and never exposes the API key', async () => {
    const service = createService(() => (async function* () {
      throw new Error('authentication failed for secret-sanmao-key');
    })());

    const pending = service.send({
      conversationId: '00000000-0000-4000-8000-000000000004',
      replyId: '00000000-0000-4000-8000-000000000041',
      text: '认证测试',
      onText: () => undefined,
    });

    let message = '';
    try {
      await pending;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('secret-sanmao-key');
    expect(message).toMatch(/认证|authentication/i);
  });

  test('tests the connection with a minimal tool-free query', async () => {
    const service = createService(successfulQuery([success('OK')]));

    await expect(service.testConnection()).resolves.toMatchObject({
      ok: true,
      latencyMs: expect.any(Number),
    });
  });

  test('isolates the SDK from user settings and inherited Claude credentials', async () => {
    const originalEnvironment = { ...process.env };
    let options: Options | undefined;
    process.env.ANTHROPIC_AUTH_TOKEN = 'inherited-anthropic-token';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'inherited-claude-token';
    process.env.CLAUDE_CONFIG_DIR = 'G:\\inherited-claude-config';
    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    const service = createService((input: SanmaoQueryInput) => {
      options = input.options;
      return successfulQuery([success('OK')])(input);
    });

    try {
      await service.testConnection();

      expect(options).toMatchObject({
        settingSources: [],
        mcpServers: {},
        tools: [],
      });
      expect(options?.env).toMatchObject({
        ANTHROPIC_BASE_URL: credentials.baseUrl,
        ANTHROPIC_API_KEY: credentials.apiKey,
      });
      expect(options?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(options?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(options?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
      expect(options?.env?.PATH).toBe(originalEnvironment.PATH);
    } finally {
      process.env = originalEnvironment;
    }
  });

  test('reads the latest saved model for each new request', async () => {
    let current = { ...credentials, model: 'claude-a' };
    const models: string[] = [];
    const service = new SanmaoService({
      store: { getCredentials: async () => current },
      queryImpl: (input) => {
        models.push(input.options.model ?? '');
        return successfulQuery([success('OK')])(input);
      },
      claudeExecutablePath: 'G:\\claude-test\\claude.exe',
    });
    const input = {
      conversationId: '00000000-0000-4000-8000-000000000007',
      replyId: '00000000-0000-4000-8000-000000000071',
      text: '模型测试',
      onText: () => undefined,
    };

    await service.send(input);
    current = { ...current, model: 'claude-b' };
    await service.send({ ...input, replyId: '00000000-0000-4000-8000-000000000072' });

    expect(models).toEqual(['claude-a', 'claude-b']);
  });
});
