import { createRequire } from 'node:module';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk/core';
import type {
  SanmaoAttachmentMetadata,
  SanmaoConversation,
  SanmaoConversationSummary,
  SanmaoCredentials,
  SanmaoEffort,
  SanmaoMessage,
} from '../shared/sanmao';
import type { SanmaoConnection } from '../shared/sanmao';
import {
  SanmaoConversationStore,
  type SanmaoDraftAttachmentInput,
} from './sanmao-conversations';
import {
  SanmaoAttachmentService,
  type SanmaoContentBlock,
} from './sanmao-attachments';
import type { FileSanmaoConfigStore } from './sanmao-config';
import { listSanmaoModels } from './sanmao-models';

export interface SanmaoQueryInput {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type SanmaoQuery = (
  input: SanmaoQueryInput,
) => AsyncIterable<unknown>;

export interface SanmaoSendInput {
  conversationId: string;
  replyId: string;
  text: string;
  effort?: SanmaoEffort;
  attachments?: Array<Pick<SanmaoAttachmentMetadata, 'id'>>;
  onText: (text: string) => void;
  onTool?: (text: string) => void;
}

export interface SanmaoToolPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
}

export interface SanmaoServiceOptions {
  store: Pick<FileSanmaoConfigStore, 'getCredentials'>;
  conversations?: SanmaoConversationStore;
  attachments?: SanmaoAttachmentService;
  queryImpl?: SanmaoQuery;
  timeoutMs?: number;
  claudeExecutablePath?: string;
  modelLister?: typeof listSanmaoModels;
  workingDirectory?: string;
  configurationDirectory?: string;
  requestPermission?: (request: SanmaoToolPermissionRequest) => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const SANMAO_SYSTEM_PROMPT =
  '你是 SMO.H3 Studio 中的 AI 助手“三脚猫”。使用中文回答，表达清晰、简洁、可靠。需要检查或操作时应实际调用工具，不要只描述准备执行的动作。';
const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ListAgents',
  'ListMcpResourcesTool', 'ReadMcpResourceDirTool', 'ReadMcpResourceTool',
  'TaskGet', 'TaskList', 'TodoWrite', 'ToolSearch',
]);
const requireClaude = createRequire(import.meta.url);

function attachmentMetadata(
  attachments: SanmaoDraftAttachmentInput[],
): SanmaoAttachmentMetadata[] {
  return attachments.map(({ id, name, kind, mimeType, size }) => ({
    id,
    name,
    kind,
    mimeType,
    size,
  }));
}

async function* attachmentPrompt(
  text: string,
  attachments: SanmaoContentBlock[],
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }, ...attachments],
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

export function normalizeClaudeExecutablePath(path: string): string {
  return path.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

const PRESERVED_CLAUDE_ENVIRONMENT_VARIABLES = new Set([
  'CLAUDE_CODE_GIT_BASH_PATH',
  'CLAUDE_CODE_CERT_STORE',
]);

function createSanmaoEnvironment(
  credentials: SanmaoCredentials,
  configurationDirectory?: string,
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
    CLAUDE_AGENT_SDK_CLIENT_APP: 'smo-h3-studio/0.5.1',
    ...(configurationDirectory === undefined
      ? {}
      : { CLAUDE_CONFIG_DIR: configurationDirectory }),
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

function extractToolUses(message: unknown): Array<{ id: string; name: string }> {
  if (!isRecord(message) || message.type !== 'assistant') return [];
  const content = isRecord(message.message) ? message.message.content : null;
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord).flatMap((block) =>
    block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, name: block.name }]
      : [],
  );
}

function extractToolProgress(message: unknown): string | null {
  if (
    !isRecord(message) || message.type !== 'tool_progress' ||
    typeof message.tool_name !== 'string'
  ) return null;
  const seconds = typeof message.elapsed_time_seconds === 'number'
    ? Math.max(0, Math.floor(message.elapsed_time_seconds))
    : 0;
  return `正在执行 ${message.tool_name}（${seconds} 秒）`;
}

function extractSessionId(message: unknown): string | null {
  if (
    !isRecord(message) || message.type !== 'system' ||
    message.subtype !== 'init' || typeof message.session_id !== 'string'
  ) return null;
  return message.session_id;
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
  private readonly conversations: SanmaoConversationStore;
  private active: { replyId: string; controller: AbortController } | null = null;
  private closed = false;

  constructor(private readonly options: SanmaoServiceOptions) {
    this.conversations = options.conversations ?? new SanmaoConversationStore(':memory:');
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

  listConversations(): SanmaoConversationSummary[] {
    return this.conversations.listConversations();
  }

  getConversation(conversationId: string): SanmaoConversation | null {
    return this.conversations.getConversation(conversationId);
  }

  saveDraft(input: {
    conversationId: string;
    model: string;
    effort?: SanmaoEffort;
    draft: string;
    attachments?: Array<Pick<SanmaoAttachmentMetadata, 'id'>>;
  }): SanmaoConversation {
    return this.conversations.updateDraft({
      ...input,
      attachments: this.resolveAttachments(input.conversationId, input.attachments ?? []),
    });
  }

  selectAttachments(
    conversationId: string,
    existingIds: string[],
  ): Promise<SanmaoAttachmentMetadata[]> {
    const attachments = this.requireAttachments();
    attachments.restore(this.conversations.getDraftAttachmentInputs(conversationId));
    return attachments.selectAttachments(existingIds);
  }

  authorizeDroppedAttachments(
    paths: string[],
    conversationId: string,
    existingIds: string[],
  ): Promise<SanmaoAttachmentMetadata[]> {
    const attachments = this.requireAttachments();
    attachments.restore(this.conversations.getDraftAttachmentInputs(conversationId));
    return attachments.authorizeDroppedAttachments(paths, existingIds);
  }

  deleteConversation(conversationId: string): void {
    this.conversations.deleteConversation(conversationId);
  }

  async send(input: SanmaoSendInput): Promise<{ replyId: string; text: string }> {
    if (this.closed) throw new Error('三脚猫服务已关闭');
    if (this.active !== null) throw new Error('三脚猫正在回复，请稍候');
    const effort = input.effort ?? 'medium';
    const attachmentRefs = [...(input.attachments ?? [])];
    const text = input.text.trim();
    if (!text) throw new Error('消息不能为空');

    const credentials = await this.requireCredentials();
    const attachments = this.resolveAttachments(input.conversationId, attachmentRefs);
    const history = this.conversations.getConversation(input.conversationId)?.messages ?? [];
    const sdkSessionId = this.conversations.getSdkSessionId(input.conversationId);
    this.conversations.appendMessage({
      conversationId: input.conversationId,
      model: credentials.model,
      effort,
      message: {
        id: `${input.replyId}:user`,
        role: 'user',
        text,
        ...(attachments.length === 0 ? {} : { attachments: attachmentMetadata(attachments) }),
      },
    });
    const historyPrompt = sdkSessionId === null
      ? this.buildPrompt(history, text)
      : text;
    const prompt = attachments.length === 0
      ? historyPrompt
      : attachmentPrompt(
          historyPrompt,
          await this.requireAttachments().createContentBlocks(attachments),
        );
    const response = await this.execute(
      prompt,
      input.replyId,
      input.onText,
      credentials,
      effort,
      {
        conversationId: input.conversationId,
        resumeSessionId: sdkSessionId,
        onTool: input.onTool,
      },
    );
    this.conversations.setSdkSessionId(
      input.conversationId,
      sdkSessionId ?? input.conversationId,
    );
    this.conversations.appendMessage({
      conversationId: input.conversationId,
      model: credentials.model,
      effort,
      message: { id: `${input.replyId}:assistant`, role: 'assistant', text: response },
    });
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
    if (this.closed) return;
    this.closed = true;
    this.active?.controller.abort(new Error('三脚猫服务已关闭'));
    this.conversations.close();
  }

  private buildPrompt(history: readonly SanmaoMessage[], text: string): string {
    if (history.length === 0) return text;
    const transcript = history.map((message) =>
      `${message.role === 'user' ? '用户' : '三脚猫'}：${message.text}`,
    );
    return [
      '以下是本次会话此前的消息记录：',
      ...transcript,
      `用户：${text}`,
    ].join('\n\n');
  }

  private async execute(
    prompt: string | AsyncIterable<SDKUserMessage>,
    replyId: string,
    onText: (text: string) => void,
    credentialsOverride?: SanmaoCredentials,
    effort: SanmaoEffort = 'medium',
    session?: {
      conversationId: string;
      resumeSessionId: string | null;
      onTool?: (text: string) => void;
    },
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
    const announcedTools = new Set<string>();
    const isChat = session !== undefined;

    try {
      const messages = this.queryImpl({
        prompt,
        options: {
          model: credentials.model,
          effort,
          env: createSanmaoEnvironment(
            credentials,
            isChat ? this.options.configurationDirectory : undefined,
          ),
          includePartialMessages: true,
          pathToClaudeCodeExecutable: this.claudeExecutablePath,
          abortController: controller,
          ...(isChat ? {
            tools: { type: 'preset', preset: 'claude_code' },
            maxTurns: 50,
            persistSession: true,
            settingSources: ['user', 'project', 'local'],
            systemPrompt: SANMAO_SYSTEM_PROMPT,
            cwd: this.options.workingDirectory,
            enableFileCheckpointing: true,
            agentProgressSummaries: true,
            permissionMode: 'default',
            permissionPrompts: 'host',
            canUseTool: async (toolName, toolInput, details) => {
              if (READ_ONLY_TOOLS.has(toolName)) return { behavior: 'allow' as const };
              const allowed = await this.options.requestPermission?.({
                toolName,
                input: toolInput,
                ...(details.title === undefined ? {} : { title: details.title }),
              }) ?? false;
              return allowed
                ? { behavior: 'allow' as const }
                : { behavior: 'deny' as const, message: '用户拒绝了本次工具调用' };
            },
            ...(session.resumeSessionId === null
              ? { sessionId: session.conversationId }
              : { resume: session.resumeSessionId }),
          } : {
            tools: [],
            mcpServers: {},
            maxTurns: 1,
            persistSession: false,
            verbatimPrompts: true,
            settingSources: [],
          }),
        },
      });
      for await (const message of messages) {
        const sessionId = extractSessionId(message);
        if (session !== undefined && sessionId !== null) {
          this.conversations.setSdkSessionId(session.conversationId, sessionId);
        }
        for (const tool of extractToolUses(message)) {
          if (announcedTools.has(tool.id)) continue;
          announcedTools.add(tool.id);
          session?.onTool?.(`正在调用 ${tool.name}`);
        }
        const toolProgress = extractToolProgress(message);
        if (toolProgress !== null) session?.onTool?.(toolProgress);
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

  private requireAttachments(): SanmaoAttachmentService {
    if (this.options.attachments === undefined) {
      throw new Error('三脚猫附件服务未配置');
    }
    return this.options.attachments;
  }

  private resolveAttachments(
    conversationId: string,
    references: Array<Pick<SanmaoAttachmentMetadata, 'id'>>,
  ): SanmaoDraftAttachmentInput[] {
    const persisted = this.conversations.getDraftAttachmentInputs(conversationId);
    this.options.attachments?.restore(persisted);
    return references.map((reference) => {
      const attachment = this.options.attachments?.getAuthorized(reference.id) ??
        persisted.find((candidate) => candidate.id === reference.id);
      if (attachment === undefined) throw new Error('附件未授权或已移除');
      return attachment;
    });
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
