import { createRequire } from 'node:module';
import type { Options } from '@anthropic-ai/claude-agent-sdk/core';
import type { SanmaoCredentials, SanmaoMessage } from '../shared/sanmao';
import type { SanmaoConnection } from '../shared/sanmao';
import type { FileSanmaoConfigStore } from './sanmao-config';
import { listSanmaoModels } from './sanmao-models';

export interface SanmaoQueryInput {
  prompt: string;
  options: Options;
}

export type SanmaoQuery = (
  input: SanmaoQueryInput,
) => AsyncIterable<unknown>;

export interface SanmaoSendInput {
  conversationId: string;
  replyId: string;
  text: string;
  onText: (text: string) => void;
}

export interface SanmaoServiceOptions {
  store: Pick<FileSanmaoConfigStore, 'getCredentials'>;
  queryImpl?: SanmaoQuery;
  timeoutMs?: number;
  claudeExecutablePath?: string;
  modelLister?: typeof listSanmaoModels;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const requireClaude = createRequire(import.meta.url);

export function normalizeClaudeExecutablePath(path: string): string {
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

const PRESERVED_CLAUDE_ENVIRONMENT_VARIABLES = new Set([
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_CERT_STORE',
]);

function createSanmaoEnvironment(
  credentials: SanmaoCredentials,
): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      if (name.startsWith('ANTHROPIC_')) return false;
      if (name.startsWith('CLAUDE_')) {
        return PRESERVED_CLAUDE_ENVIRONMENT_VARIABLES.has(name);
      }
      return true;
    }),
  );

  // Only the explicit Sanmao profile may provide Claude credentials or endpoints.
  return {
    ...environment,
    ANTHROPIC_BASE_URL: credentials.baseUrl,
    ANTHROPIC_API_KEY: credentials.apiKey,
    CLAUDE_AGENT_SDK_CLIENT_APP: 'smo-h3-studio/0.5.0',
  };
}

async function* defaultQuery(input: SanmaoQueryInput): AsyncIterable<unknown> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk/core');
  yield* query(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extractTextDelta(message: unknown): string | null {
  if (!isRecord(message) || message.type !== 'stream_event') return null;
  const event = message.event;
  if (!isRecord(event) || event.type !== 'content_block_delta') return null;
  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== 'text_delta') return null;
  return typeof delta.text === 'string' ? delta.text : null;
}

function extractAssistantText(message: unknown): string | null {
  if (!isRecord(message) || message.type !== 'assistant') return null;
  const content = isRecord(message.message) ? message.message.content : null;
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string);
  return texts.length > 0 ? texts.join('') : null;
}

function resultText(message: unknown): { text: string; error: boolean } | null {
  if (!isRecord(message) || message.type !== 'result') return null;
  const errors = Array.isArray(message.errors)
    ? message.errors.filter((item): item is string => typeof item === 'string')
    : [];
  const text = typeof message.result === 'string'
    ? message.result
    : errors.join('; ');
  return {
    text,
    error: message.is_error === true || message.subtype !== 'success',
  };
}

export class SanmaoService {
  private readonly queryImpl: SanmaoQuery;
  private readonly timeoutMs: number;
  private readonly claudeExecutablePath: string;
  private readonly modelLister: typeof listSanmaoModels;
  private readonly conversations = new Map<string, SanmaoMessage[]>();
  private active: { replyId: string; controller: AbortController } | null = null;
  private closed = false;

  constructor(private readonly options: SanmaoServiceOptions) {
    this.queryImpl = options.queryImpl ?? defaultQuery;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.claudeExecutablePath = options.claudeExecutablePath ??
      normalizeClaudeExecutablePath(
        requireClaude.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe'),
      );
    this.modelLister = options.modelLister ?? listSanmaoModels;
  }

  listModels(connection: SanmaoConnection): Promise<string[]> {
    return this.modelLister(connection);
  }

  async send(input: SanmaoSendInput): Promise<{ replyId: string; text: string }> {
    if (this.closed) throw new Error('三脚猫服务已关闭');
    if (this.active !== null) throw new Error('三脚猫正在回复，请稍候');
    const text = input.text.trim();
    if (!text) throw new Error('消息不能为空');

    const history = this.conversations.get(input.conversationId) ?? [];
    const response = await this.execute(
      this.buildPrompt(history, text),
      input.replyId,
      input.onText,
    );
    this.conversations.set(input.conversationId, [
      ...history,
      { id: `${input.replyId}:user`, role: 'user', text },
      { id: `${input.replyId}:assistant`, role: 'assistant', text: response },
    ]);
    return { replyId: input.replyId, text: response };
  }

  async testConnection(
    credentials?: SanmaoCredentials,
  ): Promise<{ ok: true; latencyMs: number }> {
    if (this.closed) throw new Error('三脚猫服务已关闭');
    if (this.active !== null) throw new Error('三脚猫正在回复，请稍候');
    const started = performance.now();
    await this.execute('只回复 OK。', 'connection-test', () => undefined, credentials);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  }

  cancel(replyId: string): void {
    if (this.active?.replyId === replyId) {
      this.active.controller.abort(new Error('三脚猫回复已停止'));
    }
  }

  close(): void {
    this.closed = true;
    this.active?.controller.abort(new Error('三脚猫服务已关闭'));
    this.conversations.clear();
  }

  private buildPrompt(history: readonly SanmaoMessage[], text: string): string {
    const transcript = history.map((message) =>
      `${message.role === 'user' ? '用户' : '三脚猫'}：${message.text}`,
    );
    return [
      '你是 SMO.H3 Studio 中的 AI 助手“三脚猫”。使用中文回答，表达清晰、简洁、可靠。',
      ...transcript,
      `用户：${text}`,
      '三脚猫：',
    ].join('\n\n');
  }

  private async execute(
    prompt: string,
    replyId: string,
    onText: (text: string) => void,
    credentialsOverride?: SanmaoCredentials,
  ): Promise<string> {
    const credentials = credentialsOverride ?? await this.requireCredentials();
    const controller = new AbortController();
    this.active = { replyId, controller };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('三脚猫请求超时'));
    }, this.timeoutMs);
    let streamed = '';
    let completedBlocks = '';

    try {
      const messages = this.queryImpl({
        prompt,
        options: {
          model: credentials.model,
          env: createSanmaoEnvironment(credentials),
          tools: [],
          mcpServers: {},
          maxTurns: 1,
          includePartialMessages: true,
          persistSession: false,
          verbatimPrompts: true,
          settingSources: [],
          pathToClaudeCodeExecutable: this.claudeExecutablePath,
          abortController: controller,
        },
      });
      for await (const message of messages) {
        const delta = extractTextDelta(message);
        if (delta !== null) {
          streamed += delta;
          onText(delta);
        }
        const assistant = extractAssistantText(message);
        if (assistant !== null) completedBlocks += assistant;
        const result = resultText(message);
        if (result === null) continue;
        if (result.error) throw new Error(result.text || 'Claude 返回错误');
        const text = result.text || streamed || completedBlocks;
        if (!text.trim()) throw new Error('Claude 返回了空回复');
        if (!streamed) onText(text);
        return text;
      }
      const text = streamed || completedBlocks;
      if (!text.trim()) throw new Error('Claude 未返回完整回复');
      return text;
    } catch (error) {
      if (timedOut) throw new Error('三脚猫请求超时，请重试');
      if (controller.signal.aborted) throw new Error('三脚猫回复已停止');
      throw this.sanitizeError(error, credentials.apiKey);
    } finally {
      clearTimeout(timeout);
      if (this.active?.replyId === replyId) this.active = null;
    }
  }

  private async requireCredentials(): Promise<SanmaoCredentials> {
    const credentials = await this.options.store.getCredentials();
    if (credentials === null) throw new Error('请先配置三脚猫的服务地址、API Key 和模型');
    return credentials;
  }

  private sanitizeError(error: unknown, apiKey: string): Error {
    const message = errorMessage(error);
    if (/authentication|401|403/i.test(message)) {
      return new Error('Claude 认证失败，请检查 API Key、服务地址和模型');
    }
    const safe = message.split(apiKey).join('[已隐藏]');
    return new Error(`三脚猫请求失败：${safe}`);
  }
}
