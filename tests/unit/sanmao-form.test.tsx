import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SanmaoPage } from '../../src/renderer/SanmaoPage';
import type { SmoApi } from '../../src/shared/ipc';
import type { SanmaoStreamEvent } from '../../src/shared/sanmao';

const profile = {
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-test',
  keyStatus: 'valid' as const,
};

const sanmao = {
  getProfile: vi.fn(),
  saveProfile: vi.fn(),
  testConnection: vi.fn(),
  listModels: vi.fn(),
  listConversations: vi.fn(),
  getConversation: vi.fn(),
  saveDraft: vi.fn(),
  deleteConversation: vi.fn(),
  selectAttachments: vi.fn(),
  authorizeDroppedAttachments: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
};

let receive: (event: SanmaoStreamEvent) => void;

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = { sanmao } as unknown as SmoApi;
  sanmao.getProfile.mockResolvedValue(profile);
  sanmao.saveProfile.mockResolvedValue(undefined);
  sanmao.testConnection.mockResolvedValue({ ok: true, latencyMs: 8 });
  sanmao.listModels.mockResolvedValue(['claude-a', 'claude-b']);
  sanmao.listConversations.mockResolvedValue([]);
  sanmao.getConversation.mockResolvedValue(null);
  sanmao.saveDraft.mockImplementation(async (input) => ({
    id: input.conversationId,
    title: '新会话',
    model: input.model,
    effort: input.effort ?? 'medium',
    draft: input.draft,
    createdAt: '2026-11-15T08:00:00.000Z',
    updatedAt: '2026-11-15T08:00:00.000Z',
    messages: [],
    draftAttachments: [],
  }));
  sanmao.deleteConversation.mockResolvedValue(undefined);
  sanmao.selectAttachments.mockResolvedValue([]);
  sanmao.authorizeDroppedAttachments.mockResolvedValue([]);
  sanmao.cancel.mockResolvedValue(undefined);
  sanmao.subscribe.mockImplementation((listener) => {
    receive = listener;
    return () => undefined;
  });
  sanmao.send.mockImplementation(async (input) => {
    receive({
      conversationId: input.conversationId,
      replyId: input.replyId,
      kind: 'delta',
      text: '这是',
    });
    receive({
      conversationId: input.conversationId,
      replyId: input.replyId,
      kind: 'done',
      text: '这是三脚猫的回复',
    });
    return { ok: true };
  });
});

afterEach(cleanup);

describe('SanmaoPage', () => {
  test('streams replies and clears them for a new conversation', async () => {
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');

    fireEvent.change(input, { target: { value: '帮我写一句商品文案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('这是三脚猫的回复')).toBeInTheDocument();
    expect(sanmao.send).toHaveBeenCalledWith(expect.objectContaining({
      text: '帮我写一句商品文案',
    }));
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(screen.queryByText('这是三脚猫的回复')).not.toBeInTheDocument();
  });

  test('stops the active reply', async () => {
    sanmao.send.mockImplementation(() => new Promise(() => undefined));
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');

    fireEvent.change(input, { target: { value: '等待停止' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const stop = await screen.findByRole('button', { name: '停止' });
    fireEvent.click(stop);

    expect(sanmao.cancel).toHaveBeenCalledWith(expect.any(String));
  });

  test('switches the current model without clearing the conversation', async () => {
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');
    fireEvent.change(input, { target: { value: '保留这段对话' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('这是三脚猫的回复');

    fireEvent.click(screen.getByRole('button', { name: '刷新模型' }));
    await waitFor(() => expect(sanmao.listModels).toHaveBeenCalledWith({}));
    fireEvent.change(screen.getByLabelText('当前模型'), {
      target: { value: 'claude-b' },
    });

    await waitFor(() => expect(sanmao.saveProfile).toHaveBeenCalledWith({
      baseUrl: profile.baseUrl,
      model: 'claude-b',
      apiKey: '',
    }));
    expect(screen.getByText('这是三脚猫的回复')).toBeInTheDocument();
    expect(screen.getByLabelText('当前模型')).toHaveValue('claude-b');
  });

  test('opens the Sanmao section in settings when unconfigured', async () => {
    sanmao.getProfile.mockResolvedValue(null);
    const onOpenSettings = vi.fn();
    render(<SanmaoPage onOpenSettings={onOpenSettings} />);

    fireEvent.click(await screen.findByRole('button', { name: '前往设置' }));

    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  test('opens and deletes an old conversation with its messages and draft restored', async () => {
    const summary = {
      id: '00000000-0000-4000-8000-000000000301',
      title: '旧口播讨论',
      model: 'claude-a',
      effort: 'high' as const,
      draft: '恢复未发送草稿',
      createdAt: '2026-11-15T08:00:00.000Z',
      updatedAt: '2026-11-15T08:00:00.000Z',
    };
    sanmao.listConversations.mockResolvedValueOnce([summary]).mockResolvedValue([]);
    sanmao.getConversation.mockResolvedValue({
      ...summary,
      messages: [{ id: 'old-message', role: 'assistant', text: '旧会话回复' }],
      draftAttachments: [],
    });
    render(<SanmaoPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^旧口播讨论/ }));
    expect(await screen.findByText('旧会话回复')).toBeInTheDocument();
    expect(screen.getByLabelText('发送给三脚猫的消息')).toHaveValue('恢复未发送草稿');
    expect(screen.getByLabelText('思考深度')).toHaveValue('high');

    fireEvent.click(screen.getByRole('button', { name: '删除会话 旧口播讨论' }));
    const dialog = screen.getByRole('dialog', { name: '删除旧会话' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(sanmao.deleteConversation).toHaveBeenCalledWith(summary.id));
    expect(screen.queryByRole('button', { name: /^旧口播讨论/ })).not.toBeInTheDocument();
  });

  test('keeps the composer after a separate message log and places model and effort beside send', async () => {
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');
    const composer = input.closest('form') as HTMLFormElement;
    const log = screen.getByRole('log');

    expect(log).toHaveClass('sanmao-message-log');
    expect(log.nextElementSibling).toBe(composer);
    expect(within(composer).getByLabelText('当前模型')).toBeInTheDocument();
    expect(within(composer).getByLabelText('思考深度')).toBeInTheDocument();
    expect(within(composer).getByRole('button', { name: '添加附件' })).toBeInTheDocument();
    expect(within(composer).getByRole('button', { name: '发送' })).toHaveClass(
      'sanmao-send-button',
    );

    fireEvent.change(within(composer).getByLabelText('思考深度'), {
      target: { value: 'high' },
    });
    await waitFor(() => expect(sanmao.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ effort: 'high' }),
    ));
  });

  test('shows distinct thinking and streaming states until the reply completes', async () => {
    sanmao.send.mockImplementation(() => new Promise(() => undefined));
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');
    const sendInput = {
      conversationId: '',
      replyId: '',
    };
    sanmao.send.mockImplementation((input) => {
      sendInput.conversationId = input.conversationId;
      sendInput.replyId = input.replyId;
      return new Promise(() => undefined);
    });

    fireEvent.change(input, { target: { value: '开始思考' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByRole('status', { name: '正在思考' })).toBeInTheDocument();

    await act(async () => {
      receive({
        ...sendInput,
        kind: 'delta',
        text: '正在生成',
      });
    });
    expect(screen.getByRole('status', { name: '正在生成回复' })).toBeInTheDocument();

    await act(async () => {
      receive({
        ...sendInput,
        kind: 'done',
        text: '正在生成',
      });
    });
    expect(screen.queryByRole('status', { name: '正在生成回复' })).not.toBeInTheDocument();
  });

  test('selects real attachments and sends their IDs with the selected effort', async () => {
    const attachment = {
      id: 'attachment-image',
      name: 'reference.png',
      kind: 'image' as const,
      mimeType: 'image/png',
      size: 128,
    };
    sanmao.selectAttachments.mockResolvedValue([attachment]);
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');

    fireEvent.click(screen.getByRole('button', { name: '添加附件' }));
    expect(await screen.findByText('reference.png')).toBeInTheDocument();
    await waitFor(() => expect(sanmao.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: [{ id: attachment.id }] }),
    ));
    fireEvent.change(screen.getByLabelText('思考深度'), { target: { value: 'high' } });
    fireEvent.change(input, { target: { value: '分析这张图片' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(sanmao.send).toHaveBeenCalledWith(expect.objectContaining({
      effort: 'high',
      attachments: [attachment],
    })));
    expect(sanmao.selectAttachments).toHaveBeenCalledWith(expect.any(String), []);
  });

  test('authorizes dropped attachments and removes them before sending', async () => {
    const attachment = {
      id: 'attachment-text',
      name: 'brief.txt',
      kind: 'text' as const,
      mimeType: 'text/plain',
      size: 64,
    };
    sanmao.authorizeDroppedAttachments.mockResolvedValue([attachment]);
    render(<SanmaoPage />);
    const input = await screen.findByLabelText('发送给三脚猫的消息');
    const composer = input.closest('form') as HTMLFormElement;
    const file = new File(['brief'], 'brief.txt', { type: 'text/plain' });

    fireEvent.drop(composer, { dataTransfer: { files: [file] } });
    expect(await screen.findByText('brief.txt')).toBeInTheDocument();
    expect(sanmao.authorizeDroppedAttachments).toHaveBeenCalledWith(
      [file],
      expect.any(String),
      [],
    );
    fireEvent.click(screen.getByRole('button', { name: '移除附件 brief.txt' }));
    expect(screen.queryByText('brief.txt')).not.toBeInTheDocument();
  });
});
