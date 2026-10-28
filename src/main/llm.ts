import type { LlmConnection, LlmCredentials } from '../shared/types';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_POLISH_TIMEOUT_MS = 120_000;

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmTestResult {
  ok: true;
  latencyMs: number;
  summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createEndpoint(connection: LlmConnection, path: string): URL {
  let baseUrl: URL;
  try {
    baseUrl = new URL(connection.baseUrl);
  } catch {
    throw new Error('LLM base URL must be a valid HTTP or HTTPS URL');
  }

  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0 ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  ) {
    throw new Error(
      'LLM base URL must use HTTP or HTTPS without credentials, query, or fragment',
    );
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, '')}/`;
  return new URL(path, baseUrl);
}

function createHttpError(status: number): Error {
  if (status === 401 || status === 403) {
    return new Error(`LLM authentication failed (HTTP ${status}). Check the API key`);
  }
  if (status === 404) {
    return new Error('LLM model or endpoint was not found (HTTP 404)');
  }
  return new Error(`LLM request failed (HTTP ${status})`);
}

function parseModelList(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('LLM service returned an invalid model list');
  }

  const ids = new Set<string>();
  for (const item of value.data) {
    if (!isRecord(item) || typeof item.id !== 'string') {
      throw new Error('LLM service returned an invalid model list');
    }

    const id = item.id.trim();
    if (id.length > 0) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

function parseChatContent(value: unknown): string {
  if (
    !isRecord(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length === 0 ||
    !isRecord(value.choices[0]) ||
    !isRecord(value.choices[0].message) ||
    typeof value.choices[0].message.content !== 'string'
  ) {
    throw new Error('LLM service returned an invalid chat completion response');
  }

  return value.choices[0].message.content;
}

export class LlmService {
  constructor(
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly polishTimeoutMs = DEFAULT_POLISH_TIMEOUT_MS,
  ) {}

  async listModels(profile: LlmConnection): Promise<string[]> {
    return parseModelList(
      await this.request('models', profile, undefined, this.timeoutMs),
    );
  }

  async testModel(profile: LlmCredentials): Promise<LlmTestResult> {
    const started = performance.now();
    const summary = await this.chatCompletion(
      profile,
      [{ role: 'user', content: 'Reply with OK only.' }],
      4,
      this.timeoutMs,
    );

    return {
      ok: true,
      latencyMs: Math.round(performance.now() - started),
      summary,
    };
  }

  async chatCompletion(
    profile: LlmCredentials,
    messages: readonly LlmChatMessage[],
    maxTokens: number,
    timeoutMs: number = this.polishTimeoutMs,
  ): Promise<string> {
    const data = await this.request(
      'chat/completions',
      profile,
      {
        model: profile.model,
        messages,
        max_tokens: maxTokens,
        stream: false,
      },
      timeoutMs,
    );
    return parseChatContent(data);
  }

  private async request(
    path: string,
    connection: LlmConnection,
    body?: unknown,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const endpoint = createEndpoint(connection, path);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${connection.apiKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      }).catch(() => {
        if (controller.signal.aborted) {
          throw new Error(`LLM request timed out after ${timeoutMs} ms`);
        }
        throw new Error('Could not connect to the LLM service');
      });

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw createHttpError(response.status);
      }

      const text = await response.text().catch(() => {
        if (controller.signal.aborted) {
          throw new Error(`LLM request timed out after ${timeoutMs} ms`);
        }
        throw new Error('Could not read the LLM service response');
      });

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error('LLM service returned invalid JSON');
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
