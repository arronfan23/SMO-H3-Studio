import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ReleaseNotesDialog } from '../../src/renderer/ReleaseNotesDialog';
import type { SmoApi } from '../../src/shared/ipc';

const CURRENT_NOTES = [
  '制作台支持自适应双栏，宽屏并排、窄屏自动堆叠。',
  '图片与视频在输出区完整缩放，保持原始比例。',
  '语音入口已合并到制作台，情绪与语气为可选项。',
  '旧作品保持兼容，可继续查看和使用已有结果。',
];

function mockVersion(version: string): void {
  window.smo = {
    app: { getVersion: vi.fn(async () => version) },
  } as unknown as SmoApi;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('ReleaseNotesDialog', () => {
  test('shows all 0.6.3 changes without falling back to generic or legacy notes', async () => {
    mockVersion('0.6.3');
    render(<ReleaseNotesDialog />);

    const dialog = await screen.findByRole('dialog', { name: '更新内容' });
    expect(dialog).toHaveTextContent('版本 0.6.3');
    for (const note of CURRENT_NOTES) {
      expect(dialog).toHaveTextContent(note);
    }
    expect(dialog).not.toHaveTextContent('优化了稳定性与使用体验');
    expect(dialog).not.toHaveTextContent('三脚猫支持多轮工具调用');
  });

  test('keeps the 0.6.0 legacy notes separate from 0.6.3', async () => {
    mockVersion('0.6.0');
    render(<ReleaseNotesDialog />);

    const dialog = await screen.findByRole('dialog', { name: '更新内容' });
    expect(dialog).toHaveTextContent('版本 0.6.0');
    expect(dialog).toHaveTextContent('三脚猫支持多轮工具调用');
    expect(dialog).toHaveTextContent('新增版本更新内容提示');
    expect(dialog).not.toHaveTextContent(CURRENT_NOTES[0]);
    expect(dialog).not.toHaveTextContent('优化了稳定性与使用体验');
  });
});
