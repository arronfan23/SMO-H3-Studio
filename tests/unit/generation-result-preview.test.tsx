import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GenerationResultPreview } from '../../src/renderer/GenerationResultPreview';
import type { SmoApi } from '../../src/shared/ipc';
import type { Work } from '../../src/shared/types';

function completedWork(mode: Work['mode'], outputPath: string): Work {
  return {
    id: 'job-1',
    avatarId: null,
    mode,
    outputPath,
    status: 'done',
    createdAt: '2026-11-15T01:00:00.000Z',
    title: null,
    completedAt: '2026-11-15T01:01:00.000Z',
    promptId: 'prompt-1',
    metadata: null,
    error: null,
  };
}

function mockApi(work: Work | null) {
  const api = {
    works: { list: vi.fn(async () => work ? [work] : []) },
    files: {
      mediaUrl: vi.fn(async (path: string) => `smo-media://media/${encodeURIComponent(path)}`),
      openFolder: vi.fn(async () => undefined),
    },
  };
  window.smo = api as unknown as SmoApi;
  return api;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GenerationResultPreview', () => {
  test.each([
    ['speech', 'G:\\output\\voice.wav', '生成语音结果', 'audio'],
    ['image', 'G:\\output\\image.png', '生成图像结果', 'img'],
    ['text', 'G:\\output\\video.mp4', '生成视频结果', 'video'],
  ] as const)('renders the completed %s result with native controls', (mode, outputPath, label, selector) => {
    mockApi(completedWork(mode, outputPath));

    render(<GenerationResultPreview jobId="job-1" onOpenWorks={vi.fn()} />);

    return waitFor(() => {
      const media = screen.getByLabelText(label);
      expect(media.tagName.toLowerCase()).toBe(selector);
      if (mode === 'image') {
        expect(media).toHaveStyle({ objectFit: 'contain' });
      } else {
        expect(media).toHaveAttribute('controls');
      }
    });
  });

  test('opens the output directory and works repository with explicit actions', async () => {
    const api = mockApi(completedWork('speech', 'G:\\output\\voice.wav'));
    const onOpenWorks = vi.fn();
    render(<GenerationResultPreview jobId="job-1" onOpenWorks={onOpenWorks} />);

    fireEvent.click(await screen.findByRole('button', { name: '打开目录' }));
    fireEvent.click(screen.getByRole('button', { name: '进入我的作品' }));

    expect(api.files.openFolder).toHaveBeenCalledWith('G:\\output');
    expect(onOpenWorks).toHaveBeenCalledTimes(1);
  });

  test('does not render an unfinished result or query without a job id', () => {
    const api = mockApi(null);
    const { container } = render(<GenerationResultPreview jobId={null} onOpenWorks={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
    expect(api.works.list).not.toHaveBeenCalled();
  });
});
