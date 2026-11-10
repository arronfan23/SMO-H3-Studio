import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { StudioPage } from '../../src/renderer/StudioPage';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';
import type { SmoApi } from '../../src/shared/ipc';
import type { MediaComponentId, MediaComponentState } from '../../src/shared/media-components';
import type { Avatar, SpeechCapabilities, SpeechMode } from '../../src/shared/types';

const avatar: Avatar = {
  id: 'avatar-1',
  name: '语音测试模特',
  photoPath: 'G:\\SMO-H3-Data\\avatars\\avatar-1.png',
  createdAt: '2026-11-09T08:00:00.000Z',
};

function componentState(
  overrides: Partial<MediaComponentState> = {},
  id: MediaComponentId = 'speech',
): MediaComponentState {
  return {
    id,
    status: 'ready',
    downloadedBytes: 1024,
    totalBytes: 1024,
    currentFile: null,
    error: null,
    active: false,
    ...overrides,
  };
}

function capabilitiesFor(mode: SpeechMode) {
  return {
    speakers: mode === 'custom' ? ['Vivian', 'Ryan'] : [],
    languages: ['Auto', 'Chinese', 'English'],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
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
    mediaUrl: vi.fn(),
  },
  works: { list: vi.fn() },
};

async function renderSpeech(selectedAvatar: Avatar | null = null) {
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
  fireEvent.click(screen.getByRole('tab', { name: '语音' }));
  expect(screen.getByRole('tabpanel', { name: '固定音色' })).toBeVisible();
  await waitFor(() => expect(smo.components.getState).toHaveBeenCalledWith('speech'));
  return { onCreateAvatar, view };
}

async function waitForSpeechReady() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '生成语音' })).toBeEnabled(),
  );
}

function speechField(label: string, mode: SpeechMode = 'custom') {
  const panel = screen.getByRole('tabpanel', {
    name: mode === 'custom' ? '固定音色' : '声音克隆',
  });
  return within(panel).getByLabelText(label);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  smo.speech.getCapabilities.mockImplementation(async (mode: SpeechMode) =>
    capabilitiesFor(mode),
  );
  smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
    componentState({}, id),
  );
  smo.components.install.mockImplementation(async (id: MediaComponentId) =>
    componentState({}, id),
  );
  smo.components.cancel.mockResolvedValue(undefined);
  smo.jobs.start.mockResolvedValue({ id: 'speech-job-1' });
  smo.jobs.getState.mockResolvedValue({ activeId: null });
  smo.jobs.cancel.mockResolvedValue(undefined);
  smo.files.selectAudio.mockResolvedValue(null);
  smo.files.authorizeDroppedAudio.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  smo.files.mediaUrl.mockImplementation(
    async (path: string) => `smo-media://media/${encodeURIComponent(path)}`,
  );
  smo.works.list.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('语音工作区', () => {
  test('语音无需数字模特，只有视频显示新建模特空状态', async () => {
    const { onCreateAvatar } = await renderSpeech();
    await waitForSpeechReady();

    const mainTabs = screen.getByRole('tablist', { name: '主制作模式' });
    expect(within(mainTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '语音',
      '图像',
      '视频',
    ]);
    expect(screen.queryByRole('region', { name: '当前人物预览' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    expect(screen.getByRole('heading', { name: '还没有数字模特' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '新建数字模特' }));
    expect(onCreateAvatar).toHaveBeenCalledTimes(1);
  });

  test('语音固定音色与克隆 tab 展示对应字段、四种格式且无采样步数', async () => {
    await renderSpeech();
    await waitForSpeechReady();

    const speechPanel = screen.getByRole('tabpanel', { name: '语音' });
    const customPanel = within(screen.getByRole('tabpanel', { name: '固定音色' }));
    expect(customPanel.getByLabelText('口播文字')).toBeInTheDocument();
    expect(customPanel.getByLabelText('音色')).toHaveValue('Vivian');
    expect(customPanel.getByLabelText('语言')).toHaveValue('Auto');
    expect(customPanel.getByLabelText('情绪/语气')).toBeInTheDocument();
    const output = customPanel.getByLabelText('输出格式');
    expect(output).toHaveValue('wav');
    expect(within(output).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'WAV',
      'MP3',
      'FLAC',
      'M4A',
    ]);
    expect(within(speechPanel).queryByLabelText('采样步数')).not.toBeInTheDocument();

    const customTab = within(speechPanel).getByRole('tab', { name: '固定音色' });
    const cloneTab = within(speechPanel).getByRole('tab', { name: '声音克隆' });
    customTab.focus();
    fireEvent.keyDown(customTab, { key: 'ArrowRight' });
    expect(cloneTab).toHaveFocus();
    expect(cloneTab).toHaveAttribute('aria-selected', 'true');

    const clonePanel = within(screen.getByRole('tabpanel', { name: '声音克隆' }));
    expect(clonePanel.getByRole('group', { name: '音频拖放区' })).toBeVisible();
    expect(clonePanel.getByLabelText('参考原文（可选）')).toBeInTheDocument();
    expect(clonePanel.getByText(/留空质量可能降低/)).toBeInTheDocument();
    expect(clonePanel.queryByLabelText('音色')).not.toBeInTheDocument();
    expect(clonePanel.queryByLabelText('情绪/语气')).not.toBeInTheDocument();

    fireEvent.keyDown(cloneTab, { key: 'ArrowRight' });
    expect(customTab).toHaveFocus();
    expect(customTab).toHaveAttribute('aria-selected', 'true');
  });

  test('语音能力加载失败会明确提示并允许重试', async () => {
    smo.speech.getCapabilities
      .mockRejectedValueOnce(new Error('语音服务尚未启动'))
      .mockImplementation(async (mode: SpeechMode) => capabilitiesFor(mode));
    await renderSpeech();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '音色与语言加载失败：语音服务尚未启动',
    );
    expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '重试加载' }));
    await waitForSpeechReady();
    expect(speechField('音色')).toHaveValue('Vivian');
    expect(screen.queryByText(/音色与语言加载失败/)).not.toBeInTheDocument();
  });

  test('语音 custom 请求包含所选音色、情绪、语言和格式并刷新 busy', async () => {
    smo.jobs.getState.mockImplementation(async () => ({
      activeId: smo.jobs.start.mock.calls.length > 0 ? 'speech-job-1' : null,
    }));
    await renderSpeech();
    await waitForSpeechReady();

    fireEvent.change(speechField('口播文字'), {
      target: { value: '欢迎来到本地语音工作区' },
    });
    fireEvent.change(speechField('音色'), { target: { value: 'Ryan' } });
    fireEvent.change(speechField('情绪/语气'), {
      target: { value: '温暖而从容' },
    });
    fireEvent.change(speechField('语言'), { target: { value: 'Chinese' } });
    fireEvent.change(speechField('输出格式'), { target: { value: 'mp3' } });
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith({
        mode: 'speech',
        speechMode: 'custom',
        prompt: '欢迎来到本地语音工作区',
        speaker: 'Ryan',
        instruct: '温暖而从容',
        language: 'Chinese',
        outputFormat: 'mp3',
      }),
    );
    expect(smo.jobs.start.mock.calls[0][0]).not.toHaveProperty('avatarId');
    expect(smo.jobs.start.mock.calls[0][0]).not.toHaveProperty('steps');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled(),
    );
  });

  test.each(['wav', 'mp3', 'flac', 'm4a'])('语音支持 %s 输出格式', async (outputFormat) => {
    await renderSpeech();
    await waitForSpeechReady();
    fireEvent.change(speechField('口播文字'), {
      target: { value: `生成 ${outputFormat} 音频` },
    });
    fireEvent.change(speechField('输出格式'), { target: { value: outputFormat } });
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'speech',
          speechMode: 'custom',
          outputFormat,
        }),
      ),
    );
  });

  test('语音 clone 接受拖入参考音，参考原文可留空并随请求提交', async () => {
    await renderSpeech();
    fireEvent.click(screen.getByRole('tab', { name: '声音克隆' }));
    await waitForSpeechReady();

    const file = new File(['reference'], 'reference.wav', { type: 'audio/wav' });
    fireEvent.drop(screen.getByRole('group', { name: '音频拖放区' }), {
      dataTransfer: { files: [file] },
    });
    expect(await screen.findByText('reference.wav')).toBeInTheDocument();
    expect(smo.files.authorizeDroppedAudio).toHaveBeenCalledWith(file);

    fireEvent.change(speechField('口播文字', 'clone'), {
      target: { value: '这是克隆声音朗读的文字' },
    });
    fireEvent.change(speechField('语言', 'clone'), { target: { value: 'English' } });
    fireEvent.change(speechField('输出格式', 'clone'), { target: { value: 'flac' } });
    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith({
        mode: 'speech',
        speechMode: 'clone',
        prompt: '这是克隆声音朗读的文字',
        referenceAudioPath: 'G:\\dropped\\reference.wav',
        referenceText: '',
        language: 'English',
        outputFormat: 'flac',
      }),
    );
    expect(smo.jobs.start.mock.calls[0][0]).not.toHaveProperty('speaker');
    expect(smo.jobs.start.mock.calls[0][0]).not.toHaveProperty('instruct');
  });

  test('语音组件未安装只禁用语音，视频布局和生成入口保持可用', async () => {
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      componentState(
        id === 'speech'
          ? { status: 'missing', downloadedBytes: 0, totalBytes: 1024 ** 3 }
          : {},
        id,
      ),
    );
    await renderSpeech(avatar);

    const speechPanel = within(screen.getByRole('tabpanel', { name: '语音' }));
    expect(await speechPanel.findByText(/1\.0 GB/)).toBeInTheDocument();
    expect(smo.speech.getCapabilities).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '安装语音组件' })).toBeEnabled();

    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    expect(screen.getByRole('region', { name: '当前人物预览' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成视频' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: '还没有数字模特' })).not.toBeInTheDocument();
  });

  test('语音组件安装显示实时进度并可取消', async () => {
    let state = componentState({
      status: 'missing',
      downloadedBytes: 0,
      totalBytes: 1024 ** 3,
    });
    let rejectInstall!: (error: Error) => void;
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      id === 'speech' ? state : componentState({}, id),
    );
    smo.components.install.mockImplementation(
      (id: MediaComponentId) =>
        id !== 'speech'
          ? Promise.resolve(componentState({}, id))
          : new Promise<MediaComponentState>((_resolve, reject) => {
          rejectInstall = reject;
          state = componentState({
            status: 'installing',
            active: true,
            downloadedBytes: 512 * 1024 ** 2,
            totalBytes: 1024 ** 3,
            currentFile: 'CustomVoice/model.safetensors',
          });
        }),
    );
    smo.components.cancel.mockImplementation(async () => {
      state = componentState({
        status: 'missing',
        downloadedBytes: 0,
        totalBytes: 1024 ** 3,
      });
      rejectInstall(new Error('安装已取消'));
    });
    await renderSpeech();

    fireEvent.click(await screen.findByRole('button', { name: '安装语音组件' }));
    expect(await screen.findByText('CustomVoice/model.safetensors')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: '语音组件安装进度' });
    expect(progress).toHaveAttribute('max', String(1024 ** 3));
    expect(progress).toHaveAttribute('value', String(512 * 1024 ** 2));
    expect(screen.getByText('50%')).toBeInTheDocument();

    const speechPanel = within(screen.getByRole('tabpanel', { name: '语音' }));
    fireEvent.click(speechPanel.getByRole('button', { name: '取消安装' }));
    await waitFor(() => expect(smo.components.cancel).toHaveBeenCalledWith('speech'));
    expect(await screen.findByRole('button', { name: '安装语音组件' })).toBeEnabled();
  });

  test('语音组件安装失败后可重试并恢复生成', async () => {
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      componentState(
        id === 'speech' ? { status: 'failed', error: '磁盘空间不足' } : {},
        id,
      ),
    );
    await renderSpeech();

    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘空间不足');
    fireEvent.click(screen.getByRole('button', { name: '重试安装' }));

    await waitFor(() => expect(smo.components.install).toHaveBeenCalledWith('speech'));
    expect(await screen.findByText('语音组件已就绪')).toBeInTheDocument();
    await waitForSpeechReady();
  });

  test('语音活动任务禁止安装组件', async () => {
    smo.jobs.getState.mockResolvedValue({ activeId: 'video-job-1' });
    smo.components.getState.mockImplementation(async (id: MediaComponentId) =>
      componentState(
        id === 'speech' ? { status: 'missing', downloadedBytes: 0 } : {},
        id,
      ),
    );
    await renderSpeech();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '安装语音组件' })).toBeDisabled(),
    );
    const speechPanel = within(screen.getByRole('tabpanel', { name: '语音' }));
    expect(speechPanel.getByText(/当前有生成任务，完成后才能安装/)).toBeInTheDocument();
    expect(smo.components.install).not.toHaveBeenCalled();
  });

  test('语音全局 busy 禁止生成和替换参考音，但保留文字草稿编辑', async () => {
    smo.jobs.getState.mockResolvedValue({ activeId: 'video-job-1' });
    await renderSpeech();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '生成语音' })).toBeDisabled(),
    );
    fireEvent.change(speechField('口播文字'), {
      target: { value: 'busy 时继续编辑口播草稿' },
    });
    fireEvent.change(speechField('情绪/语气'), {
      target: { value: '平静' },
    });
    expect(speechField('口播文字')).toHaveValue('busy 时继续编辑口播草稿');
    expect(speechField('情绪/语气')).toHaveValue('平静');

    fireEvent.click(screen.getByRole('tab', { name: '声音克隆' }));
    await waitFor(() => expect(smo.speech.getCapabilities).toHaveBeenCalledWith('clone'));
    expect(screen.getByRole('button', { name: '选择音频' })).toBeDisabled();
    fireEvent.drop(screen.getByRole('group', { name: '音频拖放区' }), {
      dataTransfer: { files: [new File(['audio'], 'busy.wav')] },
    });
    expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
  });

  test('语音提交中有 busy，错误后保留草稿且不会重复启动任务', async () => {
    let rejectStart!: (error: Error) => void;
    smo.jobs.start.mockImplementation(
      () =>
        new Promise<{ id: string }>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    await renderSpeech();
    await waitForSpeechReady();
    fireEvent.change(speechField('口播文字'), {
      target: { value: '提交失败后保留这段文字' },
    });

    fireEvent.click(screen.getByRole('button', { name: '生成语音' }));
    const submitting = await screen.findByRole('button', { name: '正在提交…' });
    expect(submitting).toBeDisabled();
    fireEvent.submit(submitting.closest('form') as HTMLFormElement);
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectStart(new Error('本地语音进程不可用'));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('本地语音进程不可用');
    expect(speechField('口播文字')).toHaveValue('提交失败后保留这段文字');
    expect(screen.getByRole('button', { name: '生成语音' })).toBeEnabled();
  });

  test('语音首装成功后自动恢复 capabilities，清除旧错误并启用生成', async () => {
    smo.components.getState.mockResolvedValue(
      componentState({ status: 'missing', downloadedBytes: 0 }),
    );
    smo.speech.getCapabilities
      .mockRejectedValueOnce(new Error('语音模型仍在启动'))
      .mockImplementation(async (mode: SpeechMode) => capabilitiesFor(mode));
    await renderSpeech();

    expect(await screen.findByRole('button', { name: '安装语音组件' })).toBeEnabled();
    expect(smo.speech.getCapabilities).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '安装语音组件' }));

    await waitForSpeechReady();
    expect(smo.speech.getCapabilities).toHaveBeenCalledTimes(2);
    expect(speechField('音色')).toHaveValue('Vivian');
    expect(speechField('语言')).toHaveValue('Auto');
    expect(screen.queryByText(/语音模型仍在启动/)).not.toBeInTheDocument();
    expect(screen.queryByText(/音色与语言加载失败/)).not.toBeInTheDocument();
  });

  test('语音 custom→clone→custom 乱序返回只应用最新 capabilities', async () => {
    const requests: Array<Deferred<SpeechCapabilities>> = [];
    smo.speech.getCapabilities.mockImplementation(() => {
      const request = deferred<SpeechCapabilities>();
      requests.push(request);
      return request.promise;
    });
    await renderSpeech();
    await waitFor(() => expect(requests).toHaveLength(1));

    fireEvent.click(screen.getByRole('tab', { name: '声音克隆' }));
    await waitFor(() => expect(requests).toHaveLength(2));
    fireEvent.click(screen.getByRole('tab', { name: '固定音色' }));
    await waitFor(() => expect(requests).toHaveLength(3));

    await act(async () => {
      requests[1].resolve({ speakers: [], languages: ['CloneOnly'] });
      requests[0].resolve({ speakers: ['StaleVoice'], languages: ['StaleLanguage'] });
      await Promise.resolve();
    });
    expect(speechField('音色')).toHaveValue('');
    expect(speechField('语言')).toHaveValue('');

    await act(async () => {
      requests[2].resolve({ speakers: ['FreshVoice'], languages: ['FreshLanguage'] });
      await requests[2].promise;
    });
    expect(speechField('音色')).toHaveValue('FreshVoice');
    expect(speechField('语言')).toHaveValue('FreshLanguage');
    expect(speechField('音色')).not.toHaveValue('StaleVoice');
  });

  test('语音 capabilities 在卸载后返回不会更新状态或报告 React 错误', async () => {
    const request = deferred<SpeechCapabilities>();
    smo.speech.getCapabilities.mockReturnValue(request.promise);
    const { view } = await renderSpeech();
    await waitFor(() => expect(smo.speech.getCapabilities).toHaveBeenCalledTimes(1));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    view.unmount();
    await act(async () => {
      request.resolve(capabilitiesFor('custom'));
      await request.promise;
    });

    expect(consoleError).not.toHaveBeenCalled();
  });

  test('语音 custom/clone 子面板始终挂载并保持 aria-controls 目标', async () => {
    await renderSpeech();
    const customTab = screen.getByRole('tab', { name: '固定音色' });
    const cloneTab = screen.getByRole('tab', { name: '声音克隆' });
    const customPanel = document.getElementById('custom-speech-panel');
    const clonePanel = document.getElementById('clone-speech-panel');

    expect(customTab).toHaveAttribute('aria-controls', 'custom-speech-panel');
    expect(cloneTab).toHaveAttribute('aria-controls', 'clone-speech-panel');
    expect(customPanel).not.toBeNull();
    expect(clonePanel).not.toBeNull();
    expect(customPanel).toBeVisible();
    expect(clonePanel).not.toBeVisible();

    const instruct = document.getElementById('custom-speech-instruct');
    fireEvent.change(speechField('口播文字'), { target: { value: '共享口播草稿' } });
    fireEvent.change(speechField('情绪/语气'), { target: { value: '冷静' } });
    fireEvent.click(cloneTab);
    expect(customPanel).not.toBeVisible();
    expect(clonePanel).toBeVisible();
    expect(speechField('口播文字', 'clone')).toHaveValue('共享口播草稿');

    fireEvent.click(customTab);
    expect(customPanel).toBeVisible();
    expect(clonePanel).not.toBeVisible();
    expect(document.getElementById('custom-speech-instruct')).toBe(instruct);
    expect(speechField('情绪/语气')).toHaveValue('冷静');
  });

  test('语音子面板 hidden CSS 不被 display:grid 覆盖', async () => {
    const { readFile } = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    const css = await readFile(resolve(process.cwd(), 'src/renderer/styles.css'), 'utf8');

    expect(css).toMatch(/\.speech-mode-fields\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  });

  test('语音参考音预览处理同文件重选、旧 metadata 和隐藏暂停', async () => {
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\same-reference.wav');
    await renderSpeech();
    fireEvent.click(screen.getByRole('tab', { name: '声音克隆' }));
    await waitForSpeechReady();

    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const first = await screen.findByLabelText('参考音频');
    expect(first).toHaveAttribute('controls');
    Object.defineProperty(first, 'duration', { configurable: true, value: 6.5 });
    fireEvent.loadedMetadata(first);
    expect(screen.getByText('音频时长：6.50 秒')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    await waitFor(() => expect(screen.getByLabelText('参考音频')).not.toBe(first));
    const second = screen.getByLabelText('参考音频');
    expect(screen.queryByText('音频时长：6.50 秒')).not.toBeInTheDocument();

    Object.defineProperty(first, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(first);
    expect(screen.queryByText('音频时长：12.00 秒')).not.toBeInTheDocument();
    Object.defineProperty(second, 'duration', { configurable: true, value: 2.75 });
    fireEvent.loadedMetadata(second);
    expect(screen.getByText('音频时长：2.75 秒')).toBeInTheDocument();

    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    expect(pause).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('tab', { name: '语音' }));
    fireEvent.click(screen.getByRole('tab', { name: '固定音色' }));
    expect(pause).toHaveBeenCalledTimes(2);
  });

  test('语音安装 ready 结果不会被较旧轮询覆盖', async () => {
    const stalePoll = deferred<MediaComponentState>();
    const install = deferred<MediaComponentState>();
    let installStarted = false;
    let stalePollRequested = false;
    smo.components.getState.mockImplementation((id: MediaComponentId) => {
      if (id !== 'speech') {
        return Promise.resolve(componentState({}, id));
      }
      if (!installStarted) {
        return Promise.resolve(componentState({ status: 'missing', downloadedBytes: 0 }));
      }
      if (!stalePollRequested) {
        stalePollRequested = true;
        return stalePoll.promise;
      }
      return Promise.resolve(componentState());
    });
    smo.components.install.mockImplementation((id: MediaComponentId) => {
      if (id === 'speech') {
        installStarted = true;
        return install.promise;
      }
      return Promise.resolve(componentState({}, id));
    });
    await renderSpeech();

    fireEvent.click(await screen.findByRole('button', { name: '安装语音组件' }));
    await waitFor(() => expect(stalePollRequested).toBe(true));
    await act(async () => {
      install.resolve(componentState());
      await install.promise;
    });
    expect(await screen.findByText('语音组件已就绪')).toBeInTheDocument();

    await act(async () => {
      stalePoll.resolve(componentState({ status: 'failed', error: '过期轮询' }));
      await stalePoll.promise;
    });
    expect(screen.getByText('语音组件已就绪')).toBeInTheDocument();
    expect(screen.queryByText('过期轮询')).not.toBeInTheDocument();
  });

  test('语音取消结果不会被较旧安装轮询覆盖', async () => {
    const stalePoll = deferred<MediaComponentState>();
    const install = deferred<MediaComponentState>();
    let installStarted = false;
    let stalePollRequested = false;
    smo.components.getState.mockImplementation((id: MediaComponentId) => {
      if (id !== 'speech') {
        return Promise.resolve(componentState({}, id));
      }
      if (!installStarted) {
        return Promise.resolve(componentState({ status: 'missing', downloadedBytes: 0 }));
      }
      if (!stalePollRequested) {
        stalePollRequested = true;
        return stalePoll.promise;
      }
      return Promise.resolve(componentState({ status: 'missing', downloadedBytes: 0 }));
    });
    smo.components.install.mockImplementation((id: MediaComponentId) => {
      if (id === 'speech') {
        installStarted = true;
        return install.promise;
      }
      return Promise.resolve(componentState({}, id));
    });
    smo.components.cancel.mockImplementation(async () => {
      install.reject(new Error('安装已取消'));
    });
    await renderSpeech();

    fireEvent.click(await screen.findByRole('button', { name: '安装语音组件' }));
    await waitFor(() => expect(stalePollRequested).toBe(true));
    const speechPanel = within(screen.getByRole('tabpanel', { name: '语音' }));
    fireEvent.click(speechPanel.getByRole('button', { name: '取消安装' }));
    expect(await screen.findByRole('button', { name: '安装语音组件' })).toBeEnabled();

    await act(async () => {
      stalePoll.resolve(componentState({ status: 'installing', active: true }));
      await stalePoll.promise;
    });
    expect(screen.getByRole('button', { name: '安装语音组件' })).toBeEnabled();
    expect(screen.queryByRole('progressbar', { name: '语音组件安装进度' })).not.toBeInTheDocument();
  });
});
