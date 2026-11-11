import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ImageForm } from '../../src/renderer/ImageForm';
import { StudioPage } from '../../src/renderer/StudioPage';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';
import type { SmoApi } from '../../src/shared/ipc';
import type { MediaComponentId, MediaComponentState } from '../../src/shared/media-components';
import type { Avatar } from '../../src/shared/types';

const avatar: Avatar = {
  id: 'avatar-1',
  name: '图像测试模特',
  photoPath: 'G:\\SMO-H3-Data\\avatars\\avatar-1.png',
  createdAt: '2026-11-10T08:00:00.000Z',
};

function componentState(
  id: MediaComponentId,
  overrides: Partial<MediaComponentState> = {},
): MediaComponentState {
  return {
    id,
    status: 'ready',
    downloadedBytes: 2048,
    totalBytes: 2048,
    currentFile: null,
    error: null,
    active: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const smo = {
  speech: { getCapabilities: vi.fn() },
  components: { getState: vi.fn(), install: vi.fn(), cancel: vi.fn() },
  jobs: { start: vi.fn(), getState: vi.fn(), cancel: vi.fn() },
  files: {
    selectAudio: vi.fn(),
    authorizeDroppedAudio: vi.fn(),
    selectImage: vi.fn(),
    authorizeDroppedImage: vi.fn(),
    mediaUrl: vi.fn(),
  },
  works: { list: vi.fn() },
};

async function renderImage(selectedAvatar: Avatar | null = null) {
  const onCreateAvatar = vi.fn();
  const view = render(
    <StudioPage
      avatar={selectedAvatar}
      loading={false}
      error={null}
      modelDirectory={DEFAULT_MODEL_DIRECTORY}
      onCreateAvatar={onCreateAvatar}
    />,
  );
  fireEvent.click(screen.getByRole('tab', { name: '图像' }));
  const panel = screen.getByRole('tabpanel', { name: '图像' });
  await waitFor(() => expect(smo.components.getState).toHaveBeenCalledWith('image'));
  return { panel: within(panel), onCreateAvatar, view };
}

async function waitForImageReady() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '生成图像' })).toBeEnabled(),
  );
}

async function addReference(panel: ReturnType<typeof within>, path: string) {
  smo.files.selectImage.mockResolvedValueOnce(path);
  fireEvent.click(panel.getByRole('button', { name: '选择参考图' }));
  expect(await panel.findByText(path.split('\\').pop() as string)).toBeInTheDocument();
}

async function loadFirstReference(
  panel: ReturnType<typeof within>,
  naturalWidth: number,
  naturalHeight: number,
) {
  const image = await panel.findByTestId('reference-image-dimensions');
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: naturalWidth },
    naturalHeight: { configurable: true, value: naturalHeight },
  });
  fireEvent.load(image);
  return image;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  smo.speech.getCapabilities.mockImplementation(async (mode: 'custom' | 'clone') => ({
    speakers: mode === 'custom' ? ['Vivian'] : [],
    languages: ['Auto', 'Chinese'],
  }));
  smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
    componentState(id),
  );
  smo.components.install.mockImplementation(async (id: MediaComponentId) =>
    componentState(id),
  );
  smo.components.cancel.mockResolvedValue(undefined);
  smo.jobs.start.mockResolvedValue({ id: 'image-job-1' });
  smo.jobs.getState.mockResolvedValue({ activeId: null });
  smo.jobs.cancel.mockResolvedValue(undefined);
  smo.files.selectAudio.mockResolvedValue(null);
  smo.files.authorizeDroppedAudio.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  smo.files.selectImage.mockResolvedValue(null);
  smo.files.authorizeDroppedImage.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  smo.files.mediaUrl.mockImplementation(
    async (path: string) => `smo-media://media/${encodeURIComponent(path)}`,
  );
  smo.works.list.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('图像工作区', () => {
  test('文字生图与参考生图切换对应控件', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();

    const textTab = panel.getByRole('tab', { name: '文字生图' });
    const referenceTab = panel.getByRole('tab', { name: '参考生图' });
    expect(textTab).toHaveAttribute('aria-selected', 'true');
    expect(referenceTab).toHaveAttribute('aria-selected', 'false');
    expect(textTab).toHaveAttribute('tabindex', '0');
    expect(referenceTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(panel.getByRole('tablist', { name: '图像模式' }), {
      key: 'ArrowRight',
    });
    expect(referenceTab).toHaveAttribute('aria-selected', 'true');
    expect(referenceTab).toHaveFocus();
    expect(panel.getByRole('group', { name: '参考图拖放区' })).toBeInTheDocument();
    expect(panel.queryByLabelText('图像比例')).not.toBeInTheDocument();

    fireEvent.click(textTab);
    expect(textTab).toHaveAttribute('aria-selected', 'true');
    expect(panel.getByLabelText('图像比例')).toBeInTheDocument();
    expect(panel.queryByRole('group', { name: '参考图拖放区' })).not.toBeInTheDocument();
  });

  test('两个图像模式 panel 始终存在且仅当前 panel 可见', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();

    const textPanel = document.getElementById('text-image-panel');
    const referencePanel = document.getElementById('reference-image-panel');
    expect(textPanel).toBeVisible();
    expect(referencePanel).not.toBeVisible();
    expect(panel.getByRole('tab', { name: '文字生图' })).toHaveAttribute(
      'aria-controls',
      'text-image-panel',
    );
    expect(panel.getByRole('tab', { name: '参考生图' })).toHaveAttribute(
      'aria-controls',
      'reference-image-panel',
    );
    expect(document.querySelectorAll('#image-resolution')).toHaveLength(1);

    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    expect(textPanel).not.toBeVisible();
    expect(referencePanel).toBeVisible();
    expect(document.querySelectorAll('#image-resolution')).toHaveLength(1);

    fireEvent.click(panel.getByRole('tab', { name: '文字生图' }));
    expect(textPanel).toBeVisible();
    expect(referencePanel).not.toBeVisible();
    expect(document.querySelectorAll('#image-resolution')).toHaveLength(1);
  });

  test('参考生图没有参考图时说明原因且不能提交', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '没有参考图也不能提交' },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));

    const submit = panel.getByRole('button', { name: '生成图像' });
    expect(submit).toBeDisabled();
    expect(panel.getByText(/至少.*1.*参考图/)).toHaveAttribute('role', 'status');
    fireEvent.submit(submit.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test('参考生图添加首图后等待自然尺寸读取', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));

    await addReference(panel, 'G:\\refs\\landscape.png');

    expect(panel.queryByText('0 / 4')).not.toBeInTheDocument();
    expect(panel.getByText('1 / 4')).toBeInTheDocument();
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(panel.getByText(/正在读取首图尺寸/)).toHaveAttribute('role', 'status');
  });

  test('参考生图按横向首图自然比例提交 1MP 尺寸和路径', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '  根据首图延伸画面  ' },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\landscape.png');
    await loadFirstReference(panel, 1920, 1080);

    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled());
    expect(panel.getByLabelText('分辨率')).toHaveValue('1');
    expect(panel.getByText(/输出 1376 × 768 px/)).toHaveAttribute('role', 'status');
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledWith({
      mode: 'image',
      prompt: '根据首图延伸画面',
      width: 1376,
      height: 768,
      seed: 42,
      steps: 25,
      referenceImagePaths: ['G:\\refs\\landscape.png'],
    }));
  });

  test('参考生图按竖向首图自然比例提交尺寸', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '竖图参考生图' },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\portrait.png');
    await loadFirstReference(panel, 1200, 1600);
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ width: 896, height: 1184 }),
    ));
  });

  test.each([
    [2, 1920, 1088],
    [4, 2720, 1536],
  ])('参考生图横向首图 %iMP 使用首图比例和具体像素', async (mp, width, height) => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: `${mp}MP 参考生图` },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\landscape.png');
    await loadFirstReference(panel, 1920, 1080);

    const resolution = panel.getByLabelText('分辨率');
    fireEvent.change(resolution, { target: { value: String(mp) } });
    expect(resolution).toHaveDisplayValue(`${width} × ${height} px`);
    expect(within(resolution).getAllByRole('option').every(
      (option) => /^\d+ × \d+ px$/.test(option.textContent ?? ''),
    )).toBe(true);
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ width, height }),
    ));
  });

  test('参考生图按选择顺序提交 4 张参考图路径', async () => {
    const paths = Array.from({ length: 4 }, (_, index) => `G:\\refs\\ordered-${index + 1}.png`);
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '四张参考图保持顺序' },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    for (const path of paths) {
      await addReference(panel, path);
    }
    await loadFirstReference(panel, 1000, 1000);

    const items = within(panel.getByRole('list', { name: '已选参考图' }))
      .getAllByRole('listitem');
    expect(items).toHaveLength(4);
    items.forEach((item, index) => {
      expect(item).toHaveTextContent(`${index + 1}`);
      expect(item).toHaveTextContent(`ordered-${index + 1}.png`);
    });
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ referenceImagePaths: paths }),
    ));
  });

  test('删除首图后重新读取新首图且旧加载回调不能覆盖', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\old-first.png');
    await addReference(panel, 'G:\\refs\\new-first.png');
    const oldImage = await loadFirstReference(panel, 1920, 1080);

    fireEvent.click(panel.getByRole('button', { name: '删除参考图 1' }));
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(panel.getByText(/正在读取首图尺寸/)).toBeInTheDocument();
    await loadFirstReference(panel, 1200, 1600);
    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled());
    expect(panel.getByText(/输出 896 × 1184 px/)).toBeInTheDocument();

    fireEvent.load(oldImage);
    expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled();
    expect(panel.getByText(/输出 896 × 1184 px/)).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: '删除参考图 1' }));
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(panel.getByText(/至少.*1.*参考图/)).toBeInTheDocument();
  });

  test('同路径删除重选使旧尺寸失效且旧加载回调不能覆盖新代次', async () => {
    const path = 'G:\\refs\\same-path.png';
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, path);
    const oldImage = await loadFirstReference(panel, 1920, 1080);
    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled());

    fireEvent.click(panel.getByRole('button', { name: '删除参考图 1' }));
    await addReference(panel, path);
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(panel.getByText(/正在读取首图尺寸/)).toBeInTheDocument();
    fireEvent.load(oldImage);
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();

    const newImage = await loadFirstReference(panel, 1200, 1600);
    expect(newImage).not.toBe(oldImage);
    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled());
    expect(panel.getByText(/输出 896 × 1184 px/)).toBeInTheDocument();

    fireEvent.load(oldImage);
    expect(panel.getByText(/输出 896 × 1184 px/)).toBeInTheDocument();
    expect(panel.queryByText(/输出 1376 × 768 px/)).not.toBeInTheDocument();
  });

  test('切换模式保留参考图草稿且文字生图始终提交空路径数组', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '模式切换保留草稿' },
    });
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\draft.png');
    await loadFirstReference(panel, 1920, 1080);

    fireEvent.click(panel.getByRole('tab', { name: '文字生图' }));
    expect(panel.queryByRole('group', { name: '参考图拖放区' })).not.toBeInTheDocument();
    expect(panel.queryByAltText('参考图 1：draft.png')).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    expect(panel.getByText('draft.png')).toBeInTheDocument();
    expect(panel.getByText(/输出 1376 × 768 px/)).toBeInTheDocument();

    fireEvent.click(panel.getByRole('tab', { name: '文字生图' }));
    fireEvent.change(panel.getByLabelText('图像比例'), {
      target: { value: '16:9 (Widescreen)' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));
    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1376,
        height: 768,
        referenceImagePaths: [],
      }),
    ));
  });

  test('参考生图 busy 禁用参考图和参数控件但保留提示词编辑', async () => {
    const view = render(<ImageForm active pageActive />);
    const panel = within(screen.getByRole('region', { name: '图像制作' }));
    await waitForImageReady();
    fireEvent.click(panel.getByRole('tab', { name: '参考生图' }));
    await addReference(panel, 'G:\\refs\\busy.png');
    await loadFirstReference(panel, 1000, 1000);

    view.rerender(<ImageForm active pageActive busy />);

    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '选择参考图' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '删除参考图 1' })).toBeDisabled();
    expect(panel.getByRole('group', { name: '参考图拖放区' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(panel.getByLabelText('分辨率')).toBeDisabled();
    expect(panel.getByLabelText('随机种子')).toBeDisabled();
    expect(panel.getByRole('spinbutton', { name: '采样步数' })).toBeDisabled();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: 'busy 参考图草稿' },
    });
    expect(panel.getByLabelText('图像提示词')).toHaveValue('busy 参考图草稿');
  });

  test('图像 jobs:start 后等待活动任务同步成功才解除本地提交锁', async () => {
    const refreshGate = deferred<{ activeId: string | null }>();
    smo.jobs.getState
      .mockResolvedValueOnce({ activeId: null })
      .mockImplementationOnce(() => refreshGate.promise)
      .mockResolvedValue({ activeId: 'image-job-1' });
    const { panel } = await renderImage();
    await waitForImageReady();
    await waitFor(() => expect(smo.jobs.getState).toHaveBeenCalledTimes(1));
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '等待任务状态同步的图像' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));
    const submitting = await panel.findByRole('button', { name: '正在提交…' });
    expect(submitting).toBeDisabled();
    fireEvent.submit(submitting.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      refreshGate.resolve({ activeId: 'image-job-1' });
      await refreshGate.promise;
    });
    expect(await panel.findByRole('button', { name: '生成图像' })).toBeDisabled();
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);
  });

  test('图像活动任务同步失败保持禁用，后续 activeId 到达后恢复且不重复提交', async () => {
    smo.jobs.getState
      .mockResolvedValueOnce({ activeId: null })
      .mockRejectedValueOnce(new Error('任务状态读取失败'))
      .mockResolvedValue({ activeId: 'image-job-1' });
    const { panel } = await renderImage();
    await waitForImageReady();
    await waitFor(() => expect(smo.jobs.getState).toHaveBeenCalledTimes(1));
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '同步失败后不能重复提交的图像' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));
    expect(await panel.findByRole('alert')).toHaveTextContent(/任务状态同步失败/);
    const submitting = panel.getByRole('button', { name: '正在提交…' });
    expect(submitting).toBeDisabled();
    fireEvent.submit(submitting.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(panel.queryByText(/任务状态同步失败/)).not.toBeInTheDocument();
      expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();
    }, { timeout: 3_000 });
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);
  });

  test('图像同步失败后成功查询 null 也解除等待且不重复提交', async () => {
    smo.jobs.getState
      .mockResolvedValueOnce({ activeId: null })
      .mockRejectedValueOnce(new Error('任务状态读取失败'))
      .mockResolvedValue({ activeId: null });
    const { panel } = await renderImage();
    await waitForImageReady();
    await waitFor(() => expect(smo.jobs.getState).toHaveBeenCalledTimes(1));
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '任务已结束但状态同步成功的图像' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));
    expect(await panel.findByRole('alert')).toHaveTextContent(/任务状态同步失败/);
    const submitting = panel.getByRole('button', { name: '正在提交…' });
    expect(submitting).toBeDisabled();
    fireEvent.submit(submitting.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);

    await waitFor(() => {
      expect(panel.queryByText(/任务状态同步失败/)).not.toBeInTheDocument();
      expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled();
    }, { timeout: 3_000 });
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);
  });

  test('图像组件慢响应轮询串行调度并最终更新进度，卸载后不再读取', async () => {
    vi.useFakeTimers();
    const slowPoll = deferred<MediaComponentState>();
    smo.components.getState
      .mockResolvedValueOnce(componentState('image', {
        status: 'installing',
        downloadedBytes: 256,
        totalBytes: 1024,
        currentFile: 'qwen-image.safetensors',
        active: true,
      }))
      .mockReturnValueOnce(slowPoll.promise)
      .mockResolvedValue(componentState('image', {
        status: 'installing',
        downloadedBytes: 768,
        totalBytes: 1024,
        currentFile: 'qwen-image.safetensors',
        active: true,
      }));
    const view = render(<ImageForm active pageActive />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(smo.components.getState).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(smo.components.getState).toHaveBeenCalledTimes(2);

    await act(async () => {
      slowPoll.resolve(componentState('image', {
        status: 'installing',
        downloadedBytes: 512,
        totalBytes: 1024,
        currentFile: 'qwen-image.safetensors',
        active: true,
      }));
      await slowPoll.promise;
    });
    expect(screen.getByRole('progressbar', { name: '图像组件安装进度' }))
      .toHaveAttribute('value', '512');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(smo.components.getState).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(smo.components.getState).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('progressbar', { name: '图像组件安装进度' }))
      .toHaveAttribute('value', '768');

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(smo.components.getState).toHaveBeenCalledTimes(3);
  });

  test('图像 active=false 或 pageActive=false 时不读取组件，激活后才读取', async () => {
    const view = render(<ImageForm active={false} pageActive={false} />);
    expect(smo.components.getState).not.toHaveBeenCalled();

    view.rerender(<ImageForm active pageActive={false} />);
    expect(smo.components.getState).not.toHaveBeenCalled();
    view.rerender(<ImageForm active={false} pageActive />);
    expect(smo.components.getState).not.toHaveBeenCalled();

    view.rerender(<ImageForm active pageActive />);
    await waitFor(() => expect(smo.components.getState).toHaveBeenCalledWith('image'));
    expect(smo.components.getState).toHaveBeenCalledTimes(1);
  });

  test('图像隐藏时禁止安装并停止轮询，过期结果在恢复后不会覆盖最新状态', async () => {
    const installGate = deferred<MediaComponentState>();
    let imageState = componentState('image', {
      status: 'missing',
      downloadedBytes: 0,
    });
    let installStarted = false;
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      id === 'image' ? imageState : componentState(id),
    );
    smo.components.install.mockImplementation((id: MediaComponentId) => {
      if (id === 'image') {
        installStarted = true;
        return installGate.promise;
      }
      return Promise.resolve(componentState(id));
    });
    const view = render(<ImageForm active pageActive />);
    const installButton = await screen.findByRole('button', { name: '安装图像组件' });

    view.rerender(<ImageForm active={false} pageActive />);
    fireEvent.click(installButton);
    expect(smo.components.install).not.toHaveBeenCalled();

    view.rerender(<ImageForm active pageActive />);
    fireEvent.click(await screen.findByRole('button', { name: '安装图像组件' }));
    await waitFor(() => expect(installStarted).toBe(true));
    await waitFor(() =>
      expect(smo.components.getState.mock.calls.filter(([id]) => id === 'image').length)
        .toBeGreaterThanOrEqual(3),
    );

    view.rerender(<ImageForm active={false} pageActive />);
    const readsAtHide = smo.components.getState.mock.calls.filter(([id]) => id === 'image').length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(smo.components.getState.mock.calls.filter(([id]) => id === 'image').length)
      .toBe(readsAtHide);

    imageState = componentState('image');
    await act(async () => {
      installGate.resolve(imageState);
      await installGate.promise;
    });
    expect(screen.queryByText('图像组件已就绪')).not.toBeInTheDocument();

    view.rerender(<ImageForm active pageActive />);
    expect(await screen.findByText('图像组件已就绪')).toBeInTheDocument();
  });

  test('图像无需数字模特，提供实际像素和默认参数且不含视频专属控件', async () => {
    const { panel, onCreateAvatar } = await renderImage();
    await waitForImageReady();

    expect(screen.queryByRole('heading', { name: '还没有数字模特' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '当前人物预览' })).not.toBeInTheDocument();
    expect(onCreateAvatar).not.toHaveBeenCalled();
    expect(panel.getByLabelText('图像提示词').tagName).toBe('TEXTAREA');
    expect(panel.getByLabelText('图像比例')).toHaveValue('1:1 (Square)');

    const resolution = panel.getByLabelText('分辨率');
    expect(resolution).toHaveValue('1');
    expect(within(resolution).getAllByRole('option').map((option) => [
      option.getAttribute('value'),
      option.textContent,
    ])).toEqual([
      ['0.3', '576 × 576 px'],
      ['0.4', '640 × 640 px'],
      ['0.55', '768 × 768 px'],
      ['0.7', '864 × 864 px'],
      ['0.85', '960 × 960 px'],
      ['1', '1024 × 1024 px'],
      ['1.2', '1120 × 1120 px'],
      ['2', '1440 × 1440 px'],
      ['4', '2048 × 2048 px'],
    ]);
    expect(within(resolution).getByRole('option', { name: '1024 × 1024 px' })).toBeInTheDocument();
    expect(within(resolution).getAllByRole('option').every(
      (option) => /^\d+ × \d+ px$/.test(option.textContent ?? ''),
    )).toBe(true);
    expect(panel.getByLabelText('随机种子')).toHaveValue(42);
    expect(panel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(25);
    expect(panel.queryByText(/AI 润色|图片编辑|参考人物|当前模特/)).not.toBeInTheDocument();
    expect(panel.queryByRole('group', { name: '参考图拖放区' })).not.toBeInTheDocument();
    expect(panel.queryByLabelText('H3 模型')).not.toBeInTheDocument();
    expect(panel.queryByLabelText('视频时长（秒）')).not.toBeInTheDocument();

    fireEvent.change(panel.getByLabelText('图像比例'), {
      target: { value: '16:9 (Widescreen)' },
    });
    expect(panel.getByLabelText('分辨率')).toHaveDisplayValue('1376 × 768 px');
  });

  test('图像采样步数支持加减、直接输入和推荐值提示', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    const input = panel.getByRole('spinbutton', { name: '采样步数' });

    fireEvent.click(panel.getByRole('button', { name: '增加步数' }));
    expect(input).toHaveValue(26);
    expect(document.getElementById('image-steps-hint')).toHaveAttribute('aria-live', 'polite');
    expect(panel.getByText('高于推荐值会增加耗时')).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: '减少步数' }));
    expect(input).toHaveValue(25);
    expect(panel.queryByText('高于推荐值会增加耗时')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '30' } });
    expect(input).toHaveValue(30);
  });

  test('图像 jobs:start 包含提示词、实际宽高、种子和直接输入的步数并刷新 busy', async () => {
    smo.jobs.getState.mockImplementation(async () => ({
      activeId: smo.jobs.start.mock.calls.length > 0 ? 'image-job-1' : null,
    }));
    const { panel } = await renderImage();
    await waitForImageReady();

    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '  清晨山谷中的红色木屋  ' },
    });
    fireEvent.change(panel.getByLabelText('图像比例'), {
      target: { value: '16:9 (Widescreen)' },
    });
    fireEvent.change(panel.getByLabelText('分辨率'), { target: { value: '1' } });
    fireEvent.change(panel.getByLabelText('随机种子'), { target: { value: '123456' } });
    fireEvent.change(panel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '30' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith({
        mode: 'image',
        prompt: '清晨山谷中的红色木屋',
        width: 1376,
        height: 768,
        seed: 123456,
        steps: 30,
        referenceImagePaths: [],
      }),
    );
    expect(smo.jobs.start.mock.calls[0][0]).not.toHaveProperty('avatarId');
    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled());
  });

  test('图像组件未 ready 只禁用图像，不影响语音和视频生成入口', async () => {
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      componentState(id, id === 'image' ? { status: 'missing', downloadedBytes: 0 } : {}),
    );
    const { panel } = await renderImage(avatar);

    expect(await panel.findByRole('button', { name: '安装图像组件' })).toBeEnabled();
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();

    fireEvent.click(screen.getByRole('tab', { name: '语音' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '生成语音' })).toBeEnabled());
    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    expect(screen.getByRole('region', { name: '当前人物预览' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled();
  });

  test('图像组件安装显示进度并在 ready 后恢复生成', async () => {
    const installGate = deferred<void>();
    let imageState = componentState('image', {
      status: 'missing',
      downloadedBytes: 0,
      totalBytes: 2048,
    });
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      id === 'image' ? imageState : componentState(id),
    );
    smo.components.install.mockImplementation(async (id: MediaComponentId) => {
      if (id === 'image') {
        imageState = componentState('image', {
          status: 'installing',
          downloadedBytes: 1024,
          totalBytes: 2048,
          currentFile: 'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
          active: true,
        });
        await installGate.promise;
        imageState = componentState('image');
      }
      return imageState;
    });
    const { panel } = await renderImage();

    fireEvent.click(await panel.findByRole('button', { name: '安装图像组件' }));
    expect(await panel.findByText('50%')).toBeInTheDocument();
    expect(panel.getByRole('progressbar', { name: '图像组件安装进度' })).toHaveAttribute(
      'value',
      '1024',
    );
    expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled();

    await act(async () => installGate.resolve());
    expect(await panel.findByText('图像组件已就绪')).toBeInTheDocument();
    await waitForImageReady();
  });

  test('图像全局 busy 禁用生成和参数控件但保留提示词编辑', async () => {
    smo.jobs.getState.mockResolvedValue({ activeId: 'video-job-1' });
    const { panel } = await renderImage();

    await waitFor(() => expect(panel.getByRole('button', { name: '生成图像' })).toBeDisabled());
    expect(panel.getByLabelText('图像比例')).toBeDisabled();
    expect(panel.getByLabelText('分辨率')).toBeDisabled();
    expect(panel.getByLabelText('随机种子')).toBeDisabled();
    expect(panel.getByRole('spinbutton', { name: '采样步数' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '增加步数' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '减少步数' })).toBeDisabled();

    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: 'busy 时继续编辑图像草稿' },
    });
    expect(panel.getByLabelText('图像提示词')).toHaveValue('busy 时继续编辑图像草稿');
  });

  test('图像提交中有明确 busy，错误后保留草稿且不会重复启动任务', async () => {
    const startGate = deferred<{ id: string }>();
    smo.jobs.start.mockImplementation(() => startGate.promise);
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '提交失败后保留这幅画面' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));
    const submitting = await panel.findByRole('button', { name: '正在提交…' });
    expect(submitting).toBeDisabled();
    fireEvent.submit(submitting.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);

    await act(async () => startGate.reject(new Error('图像后端不可用')));
    expect(await panel.findByRole('alert')).toHaveTextContent('图像后端不可用');
    expect(panel.getByLabelText('图像提示词')).toHaveValue('提交失败后保留这幅画面');
    expect(panel.getByRole('button', { name: '生成图像' })).toBeEnabled();
  });

  test('图像空提示词显示错误且不提交', async () => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    expect(await panel.findByRole('alert')).toHaveTextContent('请填写图像提示词');
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test.each([-1, 1.5])('图像随机种子 %s 非法时显示错误且不提交', async (seed) => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '非法种子不能提交' },
    });
    fireEvent.change(panel.getByLabelText('随机种子'), {
      target: { value: String(seed) },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    expect(await panel.findByRole('alert')).toHaveTextContent(/随机种子.*非负.*整数/);
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test.each([0, 101, 1.5])('图像采样步数 %s 非法时显示错误且不提交', async (steps) => {
    const { panel } = await renderImage();
    await waitForImageReady();
    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '非法步数不能提交' },
    });
    fireEvent.change(panel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: String(steps) },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成图像' }));

    expect(await panel.findByRole('alert')).toHaveTextContent(/采样步数.*1.*100.*整数/);
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });
});
