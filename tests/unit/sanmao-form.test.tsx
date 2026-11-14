import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
