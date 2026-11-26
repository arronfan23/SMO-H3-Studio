import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    ['speech', 'G:\\output\\voice.wav', '生成语音结果', 'audio', 'generation-result-audio'],
    ['image', 'G:\\output\\image.png', '生成图像结果', 'img', 'generation-result-image'],
    ['text', 'G:\\output\\video.mp4', '生成视频结果', 'video', 'generation-result-video'],
    ['audio', 'G:\\output\\digital-human.mp4', '生成视频结果', 'video', 'generation-result-video'],
  ] as const)('renders the completed %s result with native controls', (mode, outputPath, label, selector, className) => {
    mockApi(completedWork(mode, outputPath));

    render(<GenerationResultPreview jobId="job-1" onOpenWorks={vi.fn()} />);

    return waitFor(() => {
      const media = screen.getByLabelText(label);
      expect(media.tagName.toLowerCase()).toBe(selector);
      expect(media).toHaveClass(className);
      expect(media).not.toHaveAttribute('style');
      if (mode === 'image') {
        expect(media).not.toHaveAttribute('controls');
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

  test('renders the empty result preview without querying without a job id', () => {
    const api = mockApi(null);
    render(<GenerationResultPreview jobId={null} onOpenWorks={vi.fn()} />);

    const result = screen.getByRole('region', { name: '生成结果预览' });
    expect(result).toHaveClass('generation-result');
    expect(within(result).getByRole('heading', { name: '生成结果' })).toBeVisible();
    expect(within(result).getByText('完成生成后在这里预览')).toHaveClass('generation-result-empty');
    expect(api.works.list).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'unfinished',
      work: { ...completedWork('image', ''), status: 'running' as const, outputPath: null },
    },
    {
      name: 'completed without an output path',
      work: { ...completedWork('image', ''), outputPath: null },
    },
  ])('renders the empty result preview for $name work', async ({ work }) => {
    const api = mockApi(null);
    let resolveWorks!: (works: Work[]) => void;
    const worksResponse = new Promise<Work[]>((resolve) => {
      resolveWorks = resolve;
    });
    api.works.list.mockReturnValue(worksResponse);

    render(<GenerationResultPreview jobId="job-1" onOpenWorks={vi.fn()} />);

    await waitFor(() => expect(api.works.list).toHaveBeenCalledTimes(1));
    expect(screen.getByText('完成生成后在这里预览')).toHaveClass('generation-result-empty');

    await act(async () => {
      resolveWorks([work]);
      await worksResponse;
    });

    const empty = screen.getByText('完成生成后在这里预览');
    expect(empty).toHaveClass('generation-result-empty');
    expect(screen.getByRole('region', { name: '生成结果预览' })).toContainElement(empty);
  });
});
