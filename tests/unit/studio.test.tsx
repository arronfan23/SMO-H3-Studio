import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { AudioDigitalHumanForm } from '../../src/renderer/AudioDigitalHumanForm';
import { AudioRecorder } from '../../src/renderer/AudioRecorder';
import { StudioPage } from '../../src/renderer/StudioPage';
import { SKILL_NAMES } from '../../src/shared/skills';
import {
  AUTO_SKILL_OPTION,
  SKILL_OPTIONS,
} from '../../src/renderer/skill-options';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';
import type { PolishResult, SmoApi } from '../../src/shared/ipc';
import type { EnvironmentState } from '../../src/shared/environment';
import type { Avatar, SpeechCapabilities, Work } from '../../src/shared/types';

const avatar: Avatar = {
  id: 'avatar-1',
  name: '薄荷主播',
  photoPath: 'G:\\SMO-H3-Data\\avatars\\avatar-1.png',
  createdAt: '2026-10-26T08:00:00.000Z',
};

function createWork(overrides: Partial<Work>): Work {
  return {
    id: 'work-1',
    avatarId: avatar.id,
    mode: 'text',
    outputPath: null,
    status: 'pending',
    createdAt: '2026-10-26T08:01:00.000Z',
    title: null,
    completedAt: null,
    promptId: null,
    metadata: null,
    error: null,
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

function createSmoMock() {
  return {
    app: { getVersion: vi.fn() },
    avatars: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    jobs: { start: vi.fn(), retry: vi.fn(), cancel: vi.fn(), getState: vi.fn() },
    speech: { getCapabilities: vi.fn() },
    components: { getState: vi.fn(), install: vi.fn(), cancel: vi.fn() },
    recordings: { save: vi.fn(), discard: vi.fn() },
    files: {
      selectImage: vi.fn(),
      selectAudio: vi.fn(),
      mediaUrl: vi.fn(),
      openFolder: vi.fn(),
      authorizeDroppedImage: vi.fn(),
      authorizeDroppedAudio: vi.fn(),
    },
    llm: {
      saveProfile: vi.fn(),
      getProfile: vi.fn(),
      listModels: vi.fn(),
      testModel: vi.fn(),
      polish: vi.fn(),
    },
    comfy: { health: vi.fn(), open: vi.fn(), start: vi.fn() },
    environment: {
      getState: vi.fn(),
      detect: vi.fn(),
      start: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(),
      validate: vi.fn(),
    },
    hardware: { detect: vi.fn(), recommend: vi.fn(), apply: vi.fn() },
    works: { list: vi.fn(), delete: vi.fn(), rename: vi.fn() },
  };
}

const smo = createSmoMock();

async function renderStudio() {
  render(<App />);
  await screen.findByRole('heading', { name: avatar.name });
}

function studioSpeechField(label: string, mode: 'custom' | 'clone' = 'custom') {
  const panel = screen.getByRole('tabpanel', {
    name: mode === 'custom' ? '固定音色' : '声音克隆',
  });
  return within(panel).getByLabelText(label);
}

function studioModeButton(label: '语音' | '图像' | '视频') {
  return within(screen.getByRole('navigation', { name: '主导航' })).getByRole('button', {
    name: label,
    exact: true,
  });
}

function studioModePanel(label: '语音' | '图像' | '视频') {
  const mode = { 语音: 'speech', 图像: 'image', 视频: 'video' }[label];
  const panel = document.getElementById(`${mode}-main-panel`);
  if (panel === null) {
    throw new Error(`Missing ${label} studio panel`);
  }
  return panel;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  smo.app.getVersion.mockResolvedValue('0.3.15-test');
  smo.avatars.list.mockResolvedValue([avatar]);
  smo.avatars.create.mockRejectedValue(new Error('Unexpected avatar creation'));
  smo.avatars.update.mockRejectedValue(new Error('Unexpected avatar rename'));
  smo.avatars.delete.mockRejectedValue(new Error('Unexpected avatar deletion'));
  smo.files.selectImage.mockResolvedValue(null);
  smo.files.selectAudio.mockResolvedValue(null);
  smo.files.mediaUrl.mockImplementation(async (path: string) =>
    `smo-media://media/${encodeURIComponent(path)}`,
  );
  smo.files.authorizeDroppedImage.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  smo.files.authorizeDroppedAudio.mockImplementation(
    async (file: { name: string }) => `G:\\dropped\\${file.name}`,
  );
  smo.recordings.save.mockResolvedValue('G:\\data\\recordings\\recorded.wav');
  smo.recordings.discard.mockResolvedValue(undefined);
  smo.works.list.mockResolvedValue([]);
  smo.works.rename.mockRejectedValue(new Error('Unexpected work rename'));
  smo.jobs.start.mockResolvedValue({ id: 'job-1' });
  smo.jobs.retry.mockRejectedValue(new Error('Unexpected retry'));
  smo.jobs.cancel.mockResolvedValue(undefined);
  smo.jobs.getState.mockResolvedValue({ activeId: null });
  smo.speech.getCapabilities.mockImplementation(async (mode: 'custom' | 'clone') => ({
    speakers: mode === 'custom' ? ['Vivian', 'Ryan'] : [],
    languages: ['Auto', 'Chinese', 'English'],
  }));
  smo.components.getState.mockImplementation(async (id: 'speech' | 'image') => ({
    id,
    status: 'ready',
    downloadedBytes: 1024,
    totalBytes: 1024,
    currentFile: null,
    error: null,
    active: false,
  }));
  smo.components.install.mockImplementation(async (id: 'speech' | 'image') => ({
    id,
    status: 'ready',
    downloadedBytes: 1024,
    totalBytes: 1024,
    currentFile: null,
    error: null,
    active: false,
  }));
  smo.components.cancel.mockResolvedValue(undefined);
  smo.llm.getProfile.mockResolvedValue(null);
  smo.llm.saveProfile.mockResolvedValue(undefined);
  smo.llm.polish.mockRejectedValue(new Error('Unexpected polish'));
  smo.comfy.health.mockResolvedValue({ system: {}, devices: [] });
  smo.comfy.start.mockResolvedValue({ system: {}, devices: [] });
  const environment: EnvironmentState = {
    config: {
      schemaVersion: 1,
      runtimeId: 'sm120',
      runtimeRoot: 'G:\\SMO-H3-Data\\runtime',
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
      outputDirectory: 'G:\\SMO-H3-Data\\output',
      profile: 'balanced-16gb',
      hardwareFingerprint: {
        gpu: 'NVIDIA GeForce RTX 5080',
        vramGiB: 16,
        ramGiB: 64,
        cudaComputeCapability: '12.0',
      },
      manifestVersion: '1',
      status: 'ready',
      createdAt: '2026-10-30T08:00:00.000Z',
      updatedAt: '2026-10-30T08:00:00.000Z',
    },
    hardware: null,
    selection: null,
    installRoot: 'G:\\SMO-H3-Data',
    stage: 'ready',
    progress: { downloadedBytes: 0, totalBytes: 0 },
    error: null,
    active: false,
    healthy: true,
  };
  smo.environment.getState.mockResolvedValue(environment);
  smo.environment.detect.mockRejectedValue(new Error('Unexpected environment detection'));
  smo.environment.start.mockRejectedValue(new Error('Unexpected environment start'));
  smo.environment.retry.mockRejectedValue(new Error('Unexpected environment retry'));
  smo.environment.cancel.mockRejectedValue(new Error('Unexpected environment cancel'));
  smo.environment.validate.mockResolvedValue(environment);
  smo.hardware.detect.mockResolvedValue({
    gpu: 'NVIDIA GeForce RTX 5080',
    vramGiB: 16,
    ramGiB: 64,
    windowsVersion: 'Microsoft Windows 11 Pro 10.0.22631',
    driverVersion: '576.88',
    cudaComputeCapability: '12.0',
    freeDiskGiB: 512,
  });
  smo.hardware.recommend.mockResolvedValue({
    preset: 'balanced-16gb',
    modelPolicy: 'int8',
    megapixels: 0.7,
    lowvram: true,
    tiling: 'auto',
    requiresConfirmation: true,
  });
  smo.hardware.apply.mockResolvedValue({
    path: 'G:\\SMO-H3-Data\\workflow-profiles\\balanced-16gb-text.json',
    profile: {},
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SMO.H3 Studio navigation and avatars', () => {
  test('uses the real brand and switches between actual pages without TTS modes', async () => {
    await renderStudio();

    expect(screen.getByRole('heading', { name: 'SMO.H3 Studio' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'SMO.H3 Studio 标志' })).toHaveAttribute(
      'src',
      './brand/icon.png',
    );
    expect(screen.queryByText(/Fish Speech|TTS/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '数字模特' }));
    expect(screen.getByRole('heading', { name: '数字模特' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
  });

  test('切换导航页面时保留未提交文字草稿', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '切换模块后保留这段草稿' },
    });

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(studioModeButton('视频'));
      expect(screen.getByLabelText('原始文字')).toHaveValue('切换模块后保留这段草稿');
    }
  });

  test('offers a real creation entry when no avatar exists', async () => {
    smo.avatars.list.mockResolvedValue([]);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    expect(screen.getByRole('heading', { name: '数字模特' })).toBeInTheDocument();
    expect(screen.getByLabelText('模特名称')).toBeInTheDocument();
  });

  test('selects an image, creates an avatar, refreshes the list, and shares selection', async () => {
    const created: Avatar = {
      ...avatar,
      id: 'avatar-new',
      name: '新模特',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\new.png',
    };
    smo.avatars.list.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\new-photo.png');
    smo.avatars.create.mockResolvedValue(created);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '新模特' } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    expect(await screen.findByText('new-photo.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));

    expect(smo.avatars.create).toHaveBeenCalledWith({
      name: '新模特',
      photoPath: 'G:\\photos\\new-photo.png',
    });
    await screen.findByRole('heading', { name: '新模特' });
    expect(smo.avatars.list).toHaveBeenCalledTimes(2);
    fireEvent.click(studioModeButton('视频'));
    expect(await screen.findByRole('heading', { name: '新模特' })).toBeInTheDocument();
  });

  test('previews the selected photo before saving and removes it without deleting the avatar', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\preview-photo.png');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '待保存模特照片预览' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));

    const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });
    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\photos\\preview-photo.png')}`,
    );
    expect(screen.queryByText('尚未选择照片')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '移除照片' }));

    expect(screen.queryByRole('img', { name: '待保存模特照片预览' })).not.toBeInTheDocument();
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
    expect(smo.avatars.delete).not.toHaveBeenCalled();
  });

  test('authorizes a dropped photo through IPC, previews it, and saves with the dropped path', async () => {
    const created: Avatar = {
      ...avatar,
      id: 'avatar-drop',
      name: '拖放模特',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\drop.png',
    };
    smo.avatars.list.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    smo.avatars.create.mockResolvedValue(created);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');
    fireEvent.dragLeave(dropzone);
    expect(dropzone).not.toHaveAttribute('data-drop-active');

    const file = new File(['image'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    expect(smo.files.authorizeDroppedImage).toHaveBeenCalledWith(file);
    expect(smo.files.selectImage).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('img', { name: '待保存模特照片预览' }),
    ).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\dropped.png')}`,
    );
    expect(screen.getByText('dropped.png')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '拖放模特' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));

    await screen.findByRole('heading', { name: '拖放模特' });
    expect(smo.avatars.create).toHaveBeenCalledWith({
      name: '拖放模特',
      photoPath: 'G:\\dropped\\dropped.png',
    });
  });

  test('keeps the drop highlight when moving into a child element', async () => {
    smo.avatars.list.mockResolvedValue([]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    const child = screen.getByText('尚未选择照片');
    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');

    // jsdom's DragEvent does not reliably populate relatedTarget, so set it
    // explicitly on a bubbling mouse event.
    const enterChild = new MouseEvent('dragleave', { bubbles: true });
    Object.defineProperty(enterChild, 'relatedTarget', { value: child });
    fireEvent(dropzone, enterChild);
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');

    const leaveZone = new MouseEvent('dragleave', { bubbles: true });
    Object.defineProperty(leaveZone, 'relatedTarget', { value: document.body });
    fireEvent(dropzone, leaveZone);
    expect(dropzone).not.toHaveAttribute('data-drop-active');

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['x'], 'reset.png')] },
    });
    expect(dropzone).not.toHaveAttribute('data-drop-active');
  });

  test('discards a stale dialog selection that resolves after a newer drop', async () => {
    smo.avatars.list.mockResolvedValue([]);
    let resolveSelect!: (path: string | null) => void;
    smo.files.selectImage.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => { resolveSelect = resolve; }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], 'dropped.png')] } });

    const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });
    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\dropped.png')}`,
    );

    await act(async () => {
      resolveSelect('G:\\photos\\stale-dialog.png');
    });

    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\dropped.png')}`,
    );
    expect(screen.getByText('dropped.png')).toBeInTheDocument();
    expect(screen.queryByText('stale-dialog.png')).not.toBeInTheDocument();
  });

  test('rejects dropping multiple files with a clear error', async () => {
    smo.avatars.list.mockResolvedValue([]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, {
      dataTransfer: {
        files: [new File(['a'], 'a.png'), new File(['b'], 'b.png')],
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('一次只能拖入一张照片');
    expect(smo.files.authorizeDroppedImage).not.toHaveBeenCalled();
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
  });

  test.each(['notes.txt', 'clip.gif', 'voice.mp3'])(
    'rejects a dropped %s with a clear error',
    async (name) => {
      smo.avatars.list.mockResolvedValue([]);
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

      const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
      fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], name)] } });

      expect(await screen.findByRole('alert')).toHaveTextContent(
        '仅支持 PNG、JPG、JPEG 或 WebP 图片',
      );
      expect(smo.files.authorizeDroppedImage).not.toHaveBeenCalled();
      expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
    },
  );

  test('surfaces a main-process authorization failure for a dropped photo', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.authorizeDroppedImage.mockRejectedValue(new Error('文件不存在'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['x'], 'missing.png')] },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('文件不存在');
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
  });

  test('discards a stale drop authorization that resolves after a newer drop', async () => {
    smo.avatars.list.mockResolvedValue([]);
    let resolveFirst!: (path: string) => void;
    smo.files.authorizeDroppedImage
      .mockImplementationOnce(
        () => new Promise<string>((resolve) => { resolveFirst = resolve; }),
      )
      .mockImplementationOnce(
        async (file: { name: string }) => `G:\\dropped\\${file.name}`,
      );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));
    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });

    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['a'], 'first.png')] } });
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['b'], 'second.png')] } });

    const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });
    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\second.png')}`,
    );

    await act(async () => {
      resolveFirst('G:\\dropped\\first.png');
    });

    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\second.png')}`,
    );
    expect(screen.getByText('second.png')).toBeInTheDocument();
    expect(screen.queryByText('first.png')).not.toBeInTheDocument();
  });

  test('ignores a drop authorization that resolves after the photo is removed', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\original.png');
    let resolveAuth!: (path: string) => void;
    smo.files.authorizeDroppedImage.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveAuth = resolve; }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    await screen.findByRole('img', { name: '待保存模特照片预览' });

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['x'], 'replacement.png')] },
    });

    fireEvent.click(screen.getByRole('button', { name: '移除照片' }));
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();

    await act(async () => {
      resolveAuth('G:\\dropped\\replacement.png');
    });

    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
    expect(
      screen.queryByRole('img', { name: '待保存模特照片预览' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('replacement.png')).not.toBeInTheDocument();
  });

  test('a newer selection invalidates a pending drop authorization', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\reselected.png');
    let resolveAuth!: (path: string) => void;
    smo.files.authorizeDroppedImage.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveAuth = resolve; }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], 'dropped.png')] } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));

    const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });
    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\photos\\reselected.png')}`,
    );

    await act(async () => {
      resolveAuth('G:\\dropped\\dropped.png');
    });

    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\photos\\reselected.png')}`,
    );
    expect(screen.getByText('reselected.png')).toBeInTheDocument();
    expect(screen.queryByText('dropped.png')).not.toBeInTheDocument();
  });

  test('blocks saving while a drop authorization is pending', async () => {
    const created: Avatar = {
      ...avatar,
      id: 'avatar-pending',
      name: '待定模特',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\pending.png',
    };
    smo.avatars.list.mockResolvedValue([]);
    smo.avatars.create.mockResolvedValue(created);
    let resolveAuth!: (path: string) => void;
    smo.files.authorizeDroppedImage.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveAuth = resolve; }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '待定模特' } });
    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(['x'], 'pending.png')] } });

    const saveButton = screen.getByRole('button', { name: '保存模特' });
    expect(saveButton).toBeDisabled();
    fireEvent.submit(saveButton.closest('form') as HTMLFormElement);
    expect(smo.avatars.create).not.toHaveBeenCalled();

    await act(async () => {
      resolveAuth('G:\\dropped\\pending.png');
    });
    await screen.findByRole('img', { name: '待保存模特照片预览' });

    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);
    expect(smo.avatars.create).toHaveBeenCalledWith({
      name: '待定模特',
      photoPath: 'G:\\dropped\\pending.png',
    });
  });

  test('ignores a drop while saving and only clears the form for an unchanged selection', async () => {
    const created: Avatar = {
      ...avatar,
      id: 'avatar-saved',
      name: '模特甲',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\saved.png',
    };
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\original.png');
    let resolveCreate!: (value: Avatar) => void;
    smo.avatars.create.mockImplementationOnce(
      () => new Promise<Avatar>((resolve) => { resolveCreate = resolve; }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '模特甲' } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    const preview = await screen.findByRole('img', { name: '待保存模特照片预览' });

    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));

    const dropzone = screen.getByRole('group', { name: '模特照片拖放区' });
    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).not.toHaveAttribute('data-drop-active');
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['b'], 'during-save.png')] },
    });

    expect(smo.files.authorizeDroppedImage).not.toHaveBeenCalled();
    expect(preview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\photos\\original.png')}`,
    );

    await act(async () => {
      resolveCreate(created);
    });
    await screen.findByText(/已保存并选择/);
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();

    const afterFile = new File(['c'], 'after-save.png');
    fireEvent.drop(dropzone, { dataTransfer: { files: [afterFile] } });
    expect(smo.files.authorizeDroppedImage).toHaveBeenCalledWith(afterFile);
    const nextPreview = await screen.findByRole('img', { name: '待保存模特照片预览' });
    expect(nextPreview).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\after-save.png')}`,
    );
    expect(screen.getByText('after-save.png')).toBeInTheDocument();
  });

  test('clears the form error when removing the selected photo', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\clear-error.png');
    smo.avatars.create.mockRejectedValue(new Error('保存失败：磁盘已满'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '清错' } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    await screen.findByRole('img', { name: '待保存模特照片预览' });

    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘已满');

    fireEvent.click(screen.getByRole('button', { name: '移除照片' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
    expect(smo.avatars.delete).not.toHaveBeenCalled();
  });

  test('keeps the photo preview when saving fails', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\keep-photo.png');
    smo.avatars.create.mockRejectedValue(new Error('保存失败：磁盘已满'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '保留预览' } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    await screen.findByRole('img', { name: '待保存模特照片预览' });
    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('磁盘已满');
    expect(screen.getByRole('img', { name: '待保存模特照片预览' })).toBeInTheDocument();
    expect(screen.getByText('keep-photo.png')).toBeInTheDocument();
  });

  test('disables photo removal while re-selecting or saving', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValueOnce('G:\\photos\\first.png');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    await screen.findByRole('img', { name: '待保存模特照片预览' });

    let resolveSelect: ((value: string | null) => void) | undefined;
    smo.files.selectImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSelect = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    expect(screen.getByRole('button', { name: '移除照片' })).toBeDisabled();
    await act(async () => {
      resolveSelect?.(null);
    });
    expect(screen.getByRole('button', { name: '移除照片' })).toBeEnabled();

    let resolveSave: ((value: Avatar) => void) | undefined;
    smo.avatars.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '保存中' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));
    expect(screen.getByRole('button', { name: '移除照片' })).toBeDisabled();
    await act(async () => {
      resolveSave?.({ ...avatar, id: 'avatar-save', name: '保存中' });
    });
    expect(screen.getByRole('button', { name: '选择照片' })).toBeEnabled();
    expect(screen.queryByRole('img', { name: '待保存模特照片预览' })).not.toBeInTheDocument();
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
  });

  test('disables photo selection and removal while saving', async () => {
    smo.avatars.list.mockResolvedValue([]);
    smo.files.selectImage.mockResolvedValue('G:\\photos\\saving.png');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建数字模特' }));

    fireEvent.change(screen.getByLabelText('模特名称'), { target: { value: '保存中' } });
    fireEvent.click(screen.getByRole('button', { name: '选择照片' }));
    await screen.findByRole('img', { name: '待保存模特照片预览' });

    let resolveSave: ((value: Avatar) => void) | undefined;
    smo.avatars.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存模特' }));

    expect(screen.getByRole('button', { name: '移除照片' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择照片' })).toBeDisabled();

    await act(async () => {
      resolveSave?.({ ...avatar, id: 'avatar-save', name: '保存中' });
    });

    expect(screen.getByRole('button', { name: '选择照片' })).toBeEnabled();
    expect(screen.queryByRole('img', { name: '待保存模特照片预览' })).not.toBeInTheDocument();
    expect(screen.getByText('尚未选择照片')).toBeInTheDocument();
  });

  test('rejects an empty avatar rename before calling IPC', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '数字模特' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名 薄荷主播' }));

    fireEvent.change(screen.getByLabelText('模特新名称'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模特名称不能为空');
    expect(smo.avatars.update).not.toHaveBeenCalled();
  });

  test('renames an avatar and refreshes the shared list', async () => {
    const renamed = { ...avatar, name: '新名称' };
    smo.avatars.update.mockResolvedValue(renamed);
    smo.avatars.list.mockResolvedValueOnce([avatar]).mockResolvedValueOnce([renamed]);
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '数字模特' }));
    fireEvent.click(screen.getByRole('button', { name: '重命名 薄荷主播' }));

    fireEvent.change(screen.getByLabelText('模特新名称'), { target: { value: '  新名称  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存名称' }));

    expect(smo.avatars.update).toHaveBeenCalledWith({ id: avatar.id, name: '新名称' });
    expect(await screen.findByRole('heading', { name: '新名称' })).toBeInTheDocument();
    expect(smo.avatars.list).toHaveBeenCalledTimes(2);
  });

  test('deletes an avatar only after confirmation and refreshes the list', async () => {
    smo.avatars.delete.mockResolvedValue(undefined);
    smo.avatars.list.mockResolvedValueOnce([avatar]).mockResolvedValueOnce([]);
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '数字模特' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 薄荷主播' }));

    expect(screen.getByRole('dialog', { name: '删除模特' })).toBeInTheDocument();
    expect(smo.avatars.delete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(smo.avatars.delete).toHaveBeenCalledWith(avatar.id);
    expect(await screen.findByText('保存后，数字模特会显示在这里。')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('shows the real deletion error and keeps the confirmation dialog open', async () => {
    smo.avatars.delete.mockRejectedValue(new Error('该模特已有作品，无法删除'));
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '数字模特' }));
    fireEvent.click(screen.getByRole('button', { name: '删除 薄荷主播' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('该模特已有作品，无法删除');
    expect(screen.getByRole('dialog', { name: '删除模特' })).toBeInTheDocument();
  });
});

describe('text-to-video studio', () => {
  test('二级制作目录提供语音、图像、视频按钮和完整面板 ARIA', async () => {
    await renderStudio();

    const parent = screen.getByRole('button', { name: '制作台', exact: true });
    expect(parent).toHaveAttribute('aria-expanded', 'true');
    expect(parent).toHaveAttribute('aria-controls', 'studio-mode-navigation');
    expect(parent).toHaveAttribute('aria-current', 'page');

    const directory = screen.getByRole('group', { name: '制作模式' });
    expect(directory).toHaveAttribute('id', 'studio-mode-navigation');
    expect(within(directory).getAllByRole('button').map((button) => button.textContent))
      .toEqual(['语音', '图像', '视频']);
    expect(studioModeButton('视频')).toHaveAttribute('aria-current', 'page');
    expect(studioModeButton('语音')).not.toHaveAttribute('aria-current');
    expect(studioModeButton('图像')).toHaveAttribute('aria-controls', 'image-main-panel');

    expect(document.getElementById('speech-main-panel')).not.toBeVisible();
    expect(document.getElementById('image-main-panel')).not.toBeVisible();
    expect(document.getElementById('video-main-panel')).toBeVisible();
    expect(screen.getByRole('region', { name: '视频制作', exact: true })).toBe(
      studioModePanel('视频'),
    );
    expect(document.getElementById('image-main-panel')).toHaveAttribute(
      'aria-label',
      '图像制作',
    );
    expect(document.getElementById('image-main-panel')).not.toHaveAttribute('aria-labelledby');
    expect(screen.queryByRole('tablist', { name: '主制作模式' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '视频', exact: true })).not.toBeInTheDocument();

    const preview = screen.getByRole('region', { name: '当前人物预览' });
    const controls = screen.getByRole('region', { name: '制作控制区' });
    const modeTabs = within(controls).getByRole('tablist', { name: '制作模式' });
    expect(within(modeTabs).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '文字生视频',
      '音频数字人',
    ]);
    const textTab = within(modeTabs).getByRole('tab', { name: '文字生视频' });
    const audioTab = within(modeTabs).getByRole('tab', { name: '音频数字人' });
    const textPanel = document.getElementById('text-mode-panel');
    const audioPanel = document.getElementById('audio-mode-panel');
    expect(textTab).toHaveAttribute('aria-controls', 'text-mode-panel');
    expect(audioTab).toHaveAttribute('aria-controls', 'audio-mode-panel');
    expect(textPanel).toHaveAttribute('role', 'tabpanel');
    expect(textPanel).toHaveAttribute('aria-labelledby', 'text-mode-tab');
    expect(audioPanel).toHaveAttribute('role', 'tabpanel');
    expect(audioPanel).toHaveAttribute('aria-labelledby', 'audio-mode-tab');
    expect(textPanel).toBeVisible();
    expect(audioPanel).not.toBeVisible();
    expect(preview).not.toBeNull();
    expect(controls).not.toContainElement(preview);

    fireEvent.click(audioTab);
    expect(textPanel).not.toBeVisible();
    expect(audioPanel).toBeVisible();
    expect(textTab).toHaveAttribute('aria-selected', 'false');
    expect(audioTab).toHaveAttribute('aria-selected', 'true');
  });

  test('独立受控 StudioPage 使用自包含的面板可访问名称', () => {
    const onModeChange = vi.fn();
    const props = {
      avatar,
      loading: false,
      error: null,
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
      onCreateAvatar: vi.fn(),
      onModeChange,
    };
    const view = render(<StudioPage {...props} mode="speech" />);

    for (const { mode, label } of [
      { mode: 'speech', label: '语音制作' },
      { mode: 'image', label: '图像制作' },
      { mode: 'video', label: '视频制作' },
    ] as const) {
      view.rerender(<StudioPage {...props} mode={mode} />);
      const panel = document.getElementById(`${mode}-main-panel`);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('aria-label', label);
      expect(panel).not.toHaveAttribute('aria-labelledby');
      expect(panel).toHaveAccessibleName(label);
      expect(panel).toBeVisible();
    }
    expect(screen.queryByRole('tablist', { name: '主制作模式' })).not.toBeInTheDocument();
    expect(document.getElementById('studio-speech-button')).not.toBeInTheDocument();
  });

  test('非受控主 tab 支持方向键、Home/End 和 roving tabindex', () => {
    render(
      <StudioPage
        avatar={avatar}
        loading={false}
        error={null}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
        onCreateAvatar={vi.fn()}
      />,
    );

    const mainTabs = screen.getByRole('tablist', { name: '主制作模式' });
    const speechTab = within(mainTabs).getByRole('tab', { name: '语音' });
    const imageTab = within(mainTabs).getByRole('tab', { name: '图像' });
    const videoTab = within(mainTabs).getByRole('tab', { name: '视频' });
    expect(videoTab).toHaveAttribute('aria-selected', 'true');
    expect(videoTab).toHaveAttribute('tabindex', '0');

    videoTab.focus();
    fireEvent.keyDown(videoTab, { key: 'ArrowRight' });
    expect(speechTab).toHaveFocus();
    expect(speechTab).toHaveAttribute('aria-selected', 'true');
    expect(speechTab).toHaveAttribute('tabindex', '0');
    expect(imageTab).toHaveAttribute('tabindex', '-1');
    expect(videoTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(speechTab, { key: 'ArrowRight' });
    expect(imageTab).toHaveFocus();
    expect(imageTab).toHaveAttribute('aria-selected', 'true');
    expect(imageTab).toHaveAttribute('tabindex', '0');
    expect(speechTab).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(imageTab, { key: 'ArrowRight' });
    expect(videoTab).toHaveFocus();
    expect(videoTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(videoTab, { key: 'ArrowLeft' });
    expect(imageTab).toHaveFocus();
    expect(imageTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(imageTab, { key: 'Home' });
    expect(speechTab).toHaveFocus();
    expect(speechTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(speechTab, { key: 'End' });
    expect(videoTab).toHaveFocus();
    expect(videoTab).toHaveAttribute('aria-selected', 'true');
    expect(videoTab).toHaveAttribute('tabindex', '0');
  });

  test('二级目录子项同时切换应用页面和制作模式，父目录只切换展开状态', async () => {
    await renderStudio();

    fireEvent.click(studioModeButton('图像'));
    expect(studioModePanel('图像')).toBeVisible();
    expect(studioModePanel('视频')).not.toBeVisible();
    expect(studioModeButton('图像')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
    const parent = screen.getByRole('button', { name: '制作台', exact: true });
    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '制作模式' })).not.toBeInTheDocument();

    fireEvent.click(parent);
    fireEvent.click(studioModeButton('语音'));
    expect(studioModePanel('语音')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '设置' })).not.toBeInTheDocument();
    expect(studioModeButton('语音')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    fireEvent.click(studioModeButton('视频'));
    expect(studioModePanel('视频')).toBeVisible();
    expect(studioModeButton('视频')).toHaveAttribute('aria-current', 'page');
  });

  test('收起二级目录不卸载语音、图像和视频草稿', async () => {
    await renderStudio();
    const videoDraft = screen.getByLabelText('原始文字');
    fireEvent.change(videoDraft, { target: { value: '收起目录后保留视频草稿' } });

    fireEvent.click(studioModeButton('图像'));
    const imageDraft = screen.getByLabelText('图像提示词');
    fireEvent.change(imageDraft, { target: { value: '收起目录后保留图像草稿' } });

    fireEvent.click(studioModeButton('语音'));
    const speechDraft = studioSpeechField('口播文字');
    fireEvent.change(speechDraft, { target: { value: '收起目录后保留语音草稿' } });

    const parent = screen.getByRole('button', { name: '制作台', exact: true });
    fireEvent.click(parent);
    expect(parent).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('studio-mode-navigation')).not.toBeVisible();
    expect(studioModePanel('语音')).toBeVisible();
    expect(speechDraft).toHaveValue('收起目录后保留语音草稿');

    fireEvent.click(parent);
    fireEvent.click(studioModeButton('图像'));
    expect(screen.getByLabelText('图像提示词')).toBe(imageDraft);
    expect(imageDraft).toHaveValue('收起目录后保留图像草稿');
    fireEvent.click(studioModeButton('视频'));
    expect(screen.getByLabelText('原始文字')).toBe(videoDraft);
    expect(videoDraft).toHaveValue('收起目录后保留视频草稿');
    fireEvent.click(studioModeButton('语音'));
    expect(studioSpeechField('口播文字')).toBe(speechDraft);
  });

  test('二级目录导航保留父项与激活子项的键盘焦点', async () => {
    await renderStudio();

    const parent = screen.getByRole('button', { name: '制作台', exact: true });
    parent.focus();
    fireEvent.click(parent);
    expect(parent).toHaveFocus();
    expect(parent).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(parent);
    expect(parent).toHaveFocus();
    const imageButton = studioModeButton('图像');
    imageButton.focus();
    fireEvent.click(imageButton);
    expect(imageButton).toHaveFocus();
    expect(studioModePanel('图像')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const videoButton = studioModeButton('视频');
    videoButton.focus();
    fireEvent.click(videoButton);
    expect(videoButton).toHaveFocus();
    expect(studioModePanel('视频')).toBeVisible();
  });

  test('图像草稿在二级语音、视频目录和应用页面切换后保留', async () => {
    await renderStudio();
    fireEvent.click(studioModeButton('图像'));
    const panel = within(studioModePanel('图像'));

    fireEvent.change(panel.getByLabelText('图像提示词'), {
      target: { value: '切换后保留的图像草稿' },
    });
    fireEvent.change(panel.getByLabelText('图像比例'), {
      target: { value: '16:9 (Widescreen)' },
    });
    fireEvent.change(panel.getByLabelText('分辨率'), { target: { value: '0.7' } });
    fireEvent.change(panel.getByLabelText('随机种子'), { target: { value: '9876' } });
    fireEvent.change(panel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '31' },
    });

    fireEvent.click(studioModeButton('语音'));
    expect(document.getElementById('image-main-panel')).not.toBeVisible();
    fireEvent.click(studioModeButton('视频'));
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '图像切换后仍保留的视频草稿' },
    });

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(studioModeButton('图像'));
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(studioModeButton('图像'));
      const currentPanel = within(studioModePanel('图像'));
      expect(currentPanel.getByLabelText('图像提示词')).toHaveValue('切换后保留的图像草稿');
      expect(currentPanel.getByLabelText('图像比例')).toHaveValue('16:9 (Widescreen)');
      expect(currentPanel.getByLabelText('分辨率')).toHaveValue('0.7');
      expect(currentPanel.getByLabelText('随机种子')).toHaveValue(9876);
      expect(currentPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(31);
    }

    fireEvent.click(studioModeButton('视频'));
    expect(screen.getByLabelText('原始文字')).toHaveValue('图像切换后仍保留的视频草稿');
    fireEvent.click(studioModeButton('图像'));
    expect(screen.getByLabelText('图像提示词')).toHaveValue('切换后保留的图像草稿');
  });

  test('语音与视频草稿在切换二级目录和应用页面后保留', async () => {
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\speech-clone.wav');
    await renderStudio();

    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '主模式切换后保留的视频草稿' },
    });
    fireEvent.click(studioModeButton('语音'));
    fireEvent.change(studioSpeechField('口播文字'), {
      target: { value: '主模式切换后保留的口播草稿' },
    });
    fireEvent.change(studioSpeechField('情绪/语气'), {
      target: { value: '亲切自然' },
    });
    fireEvent.change(studioSpeechField('输出格式'), { target: { value: 'mp3' } });

    fireEvent.click(screen.getByRole('tab', { name: '声音克隆' }));
    await waitFor(() => expect(smo.speech.getCapabilities).toHaveBeenCalledWith('clone'));
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    expect(await screen.findByText('speech-clone.wav')).toBeInTheDocument();
    fireEvent.change(studioSpeechField('参考原文（可选）', 'clone'), {
      target: { value: '保留的参考原文' },
    });

    fireEvent.click(studioModeButton('视频'));
    expect(screen.getByLabelText('原始文字')).toHaveValue('主模式切换后保留的视频草稿');
    fireEvent.click(studioModeButton('语音'));
    expect(studioSpeechField('口播文字', 'clone')).toHaveValue('主模式切换后保留的口播草稿');
    expect(studioSpeechField('输出格式', 'clone')).toHaveValue('mp3');
    expect(studioSpeechField('参考原文（可选）', 'clone')).toHaveValue('保留的参考原文');
    expect(screen.getByText('speech-clone.wav')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '固定音色' }));
    expect(studioSpeechField('情绪/语气')).toHaveValue('亲切自然');

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(studioModeButton('语音'));
      expect(studioSpeechField('口播文字')).toHaveValue('主模式切换后保留的口播草稿');
      expect(studioSpeechField('情绪/语气')).toHaveValue('亲切自然');
      expect(studioSpeechField('输出格式')).toHaveValue('mp3');
    }

    fireEvent.click(studioModeButton('视频'));
    expect(screen.getByLabelText('原始文字')).toHaveValue('主模式切换后保留的视频草稿');
  });

  test('语音 capabilities 默认视频和切应用页面不调用，返回后只应用新结果', async () => {
    const first = deferred<SpeechCapabilities>();
    const second = deferred<SpeechCapabilities>();
    smo.speech.getCapabilities
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await renderStudio();
    await waitFor(() => expect(smo.components.getState).toHaveBeenCalledWith('speech'));

    expect(smo.speech.getCapabilities).not.toHaveBeenCalled();
    fireEvent.click(studioModeButton('语音'));
    await waitFor(() => expect(smo.speech.getCapabilities).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
    await act(async () => {
      first.resolve({ speakers: ['StaleHiddenVoice'], languages: ['StaleHiddenLanguage'] });
      await first.promise;
    });
    expect(document.getElementById('custom-speech-speaker')).toHaveValue('');

    fireEvent.click(studioModeButton('语音'));
    await waitFor(() => expect(smo.speech.getCapabilities).toHaveBeenCalledTimes(2));
    await act(async () => {
      second.resolve({ speakers: ['ReturnVoice'], languages: ['Chinese'] });
      await second.promise;
    });
    expect(studioSpeechField('音色')).toHaveValue('ReturnVoice');
    expect(studioSpeechField('语言')).toHaveValue('Chinese');
    expect(screen.getByRole('button', { name: '生成语音' })).toBeEnabled();
  });

  test('视频子 tab 支持 roving tabindex 和键盘循环导航', async () => {
    await renderStudio();

    const controls = screen.getByRole('region', { name: '制作控制区' });
    const modeTabs = within(controls).getByRole('tablist', { name: '制作模式' });
    const textTab = within(modeTabs).getByRole('tab', { name: '文字生视频' });
    const audioTab = within(modeTabs).getByRole('tab', { name: '音频数字人' });

    textTab.focus();
    fireEvent.keyDown(textTab, { key: 'ArrowRight' });
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute('aria-selected', 'true');
    expect(textTab).toHaveAttribute('tabindex', '-1');
    expect(audioTab).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(audioTab, { key: 'ArrowRight' });
    expect(textTab).toHaveFocus();
    expect(textTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(textTab, { key: 'ArrowLeft' });
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(audioTab, { key: 'Home' });
    expect(textTab).toHaveFocus();
    expect(textTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(textTab, { key: 'End' });
    expect(audioTab).toHaveFocus();
    expect(audioTab).toHaveAttribute('aria-selected', 'true');
    expect(textTab).toHaveAttribute('tabindex', '-1');
    expect(audioTab).toHaveAttribute('tabindex', '0');
  });

  test('polishes without media payloads, edits the result, and starts the confirmed text', async () => {
    smo.llm.polish.mockResolvedValue({
      text: '润色后的镜头',
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '主播转身并挥手' },
    });
    fireEvent.change(
      within(screen.getByRole('tabpanel', { name: '文字生视频' })).getByLabelText(
        '视频风格（Skill）',
      ),
      { target: { value: 'h3-prompt-writing' } },
    );
    fireEvent.change(screen.getByLabelText('视频时长（秒）'), { target: { value: '9' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '随机种子' }), { target: { value: '42' } });

    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));

    expect(await screen.findByRole('textbox', { name: '润色结果' })).toHaveValue('润色后的镜头');
    expect(smo.llm.polish).toHaveBeenCalledWith({
      text: '主播转身并挥手',
      duration: 9,
      imageCount: 1,
      mode: 'ref2va',
      referenceLabels: ['<Picture 1>'],
      skill: 'h3-prompt-writing',
    });
    expect(smo.llm.polish.mock.calls[0][0]).not.toHaveProperty('audioPath');
    expect(smo.llm.polish.mock.calls[0][0]).not.toHaveProperty('photoPath');
    expect(screen.getByRole('tab', { name: '润色结果' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.change(screen.getByRole('textbox', { name: '润色结果' }), {
      target: { value: '用户最终确认的镜头文本' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith({
        mode: 'text',
        avatarId: avatar.id,
        prompt: '用户最终确认的镜头文本',
        duration: 9,
        seed: 42,
        steps: 8,
      }),
    );
    expect(await screen.findByText('job-1')).toBeInTheDocument();
    expect(screen.getByText('等待中（pending）')).toBeInTheDocument();
  });

  test('rejects an explicit 4.5 second text duration without submitting', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '显式时长必须保持整数约束' },
    });
    fireEvent.change(screen.getByLabelText('视频时长（秒）'), {
      target: { value: '4.5' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    });

    expect(smo.jobs.start).not.toHaveBeenCalled();
    expect(smo.hardware.apply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('视频时长必须在 4–15 秒之间');
  });

  test('rejects an explicit 4.5 second text duration without polishing', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '润色也保持显式整数时长约束' },
    });
    fireEvent.change(screen.getByLabelText('视频时长（秒）'), {
      target: { value: '4.5' },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));
    });

    expect(smo.llm.polish).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('视频时长必须在 4–15 秒之间');
  });

  test('allows a fractional estimated duration when the text duration is blank', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '汉'.repeat(10) },
    });
    fireEvent.change(screen.getByLabelText('视频时长（秒）'), {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ duration: 4.5 }),
      ),
    );
  });

  test('estimates a blank duration from the original text and reuses it after polishing', async () => {
    const originalText = 'one two three four five six seven eight nine ten';
    const changedOriginalText = '汉'.repeat(100);
    const polishedText =
      '<Picture 1> 中的主播在明亮演播室里面对镜头，' +
      '缓慢转身并自然挥手，镜头平稳推进。'.repeat(12);
    let resolvePolish: ((value: PolishResult) => void) | undefined;
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvePolish = resolve;
        }),
    );
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: originalText },
    });
    const durationInput = screen.getByLabelText('视频时长（秒）');
    fireEvent.change(durationInput, { target: { value: '' } });

    expect(durationInput).toHaveAttribute('aria-describedby', 'text-duration-hint');
    expect(screen.getByText('留空自动：约 6 秒（含 2 秒收尾）')).toHaveAttribute(
      'id',
      'text-duration-hint',
    );

    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));

    await waitFor(() =>
      expect(smo.llm.polish).toHaveBeenCalledWith(expect.objectContaining({ duration: 6 })),
    );
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: changedOriginalText },
    });
    expect(screen.getByText('留空自动：约 15 秒（含 2 秒收尾）')).toBeInTheDocument();

    await act(async () => {
      resolvePolish?.({
        text: polishedText,
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });

    expect(await screen.findByRole('textbox', { name: '润色结果' })).toHaveValue(polishedText);

    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: polishedText, duration: 6 }),
      ),
    );
    expect(screen.getByText('留空自动：约 6 秒（含 2 秒收尾）')).toHaveAttribute(
      'id',
      'text-duration-hint',
    );
    expect(screen.queryByText('留空自动：约 15 秒（含 2 秒收尾）')).not.toBeInTheDocument();
  });

  test('keeps the original text after a polish failure and can generate it', async () => {
    smo.llm.polish.mockRejectedValue(new Error('LLM 暂时不可用'));
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '保留这段原文' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('LLM 暂时不可用');
    expect(screen.getByLabelText('原始文字')).toHaveValue('保留这段原文');
    expect(screen.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '保留这段原文', mode: 'text' }),
      ),
    );
  });

  test('blocks text generation entry while a polish request is pending', async () => {
    let resolvePolish: ((value: PolishResult) => void) | undefined;
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvePolish = resolve;
        }),
    );
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '润色期间不能生成' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));

    const generateButton = screen.getByRole('button', { name: '生成视频' });
    expect(generateButton).toBeDisabled();
    fireEvent.submit(generateButton.closest('form') as HTMLFormElement);
    expect(smo.hardware.apply).not.toHaveBeenCalled();
    expect(smo.jobs.start).not.toHaveBeenCalled();

    await act(async () => {
      resolvePolish?.({
        text: '互斥测试润色结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });
    expect(await screen.findByRole('textbox', { name: '润色结果' })).toBeInTheDocument();
  });

  test('blocks text polish entry while generation is pending', async () => {
    let resolveStart: ((value: { id: string }) => void) | undefined;
    smo.jobs.start.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '生成期间不能润色' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));

    const polishButton = screen.getByRole('button', { name: 'AI 润色' });
    expect(polishButton).toBeDisabled();
    fireEvent.click(polishButton);
    expect(smo.llm.polish).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart?.({ id: 'text-exclusive-job' });
    });
    expect(screen.getByRole('button', { name: 'AI 润色' })).toBeEnabled();
  });

  test('keeps an unsubmitted text draft when switching production modes', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '尚未提交的草稿' },
    });

    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));

    expect(screen.getByLabelText('原始文字')).toHaveValue('尚未提交的草稿');
    expect(screen.getByRole('heading', { name: avatar.name })).toBeInTheDocument();
  });

  test('视频子模式切换和应用页面往返保留原文、润色文本、音频与步数', async () => {
    smo.llm.polish.mockImplementation(async ({ text }: { text: string }) => ({
      text: `润色：${text}`,
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    }));
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\video-submode.mp3');
    await renderStudio();

    let textPanel = within(screen.getByRole('tabpanel', { name: '文字生视频' }));
    fireEvent.change(textPanel.getByLabelText('原始文字'), {
      target: { value: '视频子模式原文' },
    });
    fireEvent.change(textPanel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '11' },
    });
    fireEvent.click(textPanel.getByRole('button', { name: 'AI 润色' }));
    expect(await textPanel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '润色：视频子模式原文',
    );
    fireEvent.change(textPanel.getByRole('textbox', { name: '润色结果' }), {
      target: { value: '编辑后的视频子模式润色文本' },
    });

    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    let audioPanel = within(screen.getByRole('tabpanel', { name: '音频数字人' }));
    fireEvent.click(audioPanel.getByRole('button', { name: '选择音频' }));
    const selectedAudio = await audioPanel.findByLabelText('所选音频');
    Object.defineProperty(selectedAudio, 'duration', { configurable: true, value: 9 });
    fireEvent.loadedMetadata(selectedAudio);
    fireEvent.change(audioPanel.getByLabelText('动作/画面提示词'), {
      target: { value: '音频子模式原文' },
    });
    fireEvent.change(audioPanel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '9' },
    });
    fireEvent.click(audioPanel.getByRole('button', { name: 'AI 润色' }));
    expect(await audioPanel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '润色：音频子模式原文',
    );
    fireEvent.change(audioPanel.getByRole('textbox', { name: '润色结果' }), {
      target: { value: '编辑后的音频子模式润色文本' },
    });

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    textPanel = within(screen.getByRole('tabpanel', { name: '文字生视频' }));
    expect(textPanel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
      '编辑后的视频子模式润色文本',
    );
    expect(textPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(11);
    fireEvent.click(textPanel.getByRole('tab', { name: '原文' }));
    expect(textPanel.getByLabelText('原始文字')).toHaveValue('视频子模式原文');
    fireEvent.click(textPanel.getByRole('tab', { name: '润色结果' }));

    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    audioPanel = within(screen.getByRole('tabpanel', { name: '音频数字人' }));
    expect(audioPanel.getByLabelText('所选音频')).toBe(selectedAudio);
    expect(audioPanel.getByText('video-submode.mp3')).toBeInTheDocument();
    expect(audioPanel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
      '编辑后的音频子模式润色文本',
    );
    expect(audioPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(9);
    fireEvent.click(audioPanel.getByRole('tab', { name: '原文' }));
    expect(audioPanel.getByLabelText('动作/画面提示词')).toHaveValue('音频子模式原文');
    fireEvent.click(audioPanel.getByRole('tab', { name: '润色结果' }));

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(studioModeButton('视频'));
      audioPanel = within(screen.getByRole('tabpanel', { name: '音频数字人' }));
      expect(audioPanel.getByLabelText('所选音频')).toBe(selectedAudio);
      expect(audioPanel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
        '编辑后的音频子模式润色文本',
      );
      expect(audioPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(9);
    }

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    textPanel = within(screen.getByRole('tabpanel', { name: '文字生视频' }));
    expect(textPanel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
      '编辑后的视频子模式润色文本',
    );
    expect(textPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(11);
  });

  test('uses works:list for real running and done states instead of inventing completion', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'job-real', status: 'running' }),
    ]);
    smo.jobs.start.mockResolvedValue({ id: 'job-real' });
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '真实任务状态' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(await screen.findByText('运行中（running）')).toBeInTheDocument();
    smo.works.list.mockResolvedValue([
      createWork({ id: 'job-real', status: 'done', outputPath: 'G:\\output\\real.mp4' }),
    ]);
    expect(await screen.findByText('已完成（done）', {}, { timeout: 2500 })).toBeInTheDocument();
  });
});

describe('用于音频数字人', () => {
  function doneSpeechWork(id: string, outputPath: string): Work {
    return createWork({
      id,
      avatarId: null,
      mode: 'speech',
      status: 'done',
      outputPath,
      title: id,
    });
  }

  async function openWorksWith(works: Work[]): Promise<void> {
    smo.works.list.mockResolvedValue(works);
    await renderStudio();
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByRole('heading', { name: '我的作品' });
  }

  async function useSpeechWork(id: string) {
    fireEvent.click(
      await screen.findByRole('button', { name: `用于音频数字人 ${id}` }),
    );
    const panel = await screen.findByRole('tabpanel', { name: '音频数字人' });
    await waitFor(() => expect(panel).toBeVisible());
    return within(panel);
  }

  function loadDuration(audio: HTMLElement, seconds: number): void {
    Object.defineProperty(audio, 'duration', { configurable: true, value: seconds });
    fireEvent.loadedMetadata(audio);
  }

  test('仅为已完成且有输出路径的语音作品显示操作', async () => {
    await openWorksWith([
      doneSpeechWork('speech-ready', 'G:\\output\\SMO-Speech\\ready.wav'),
      createWork({
        id: 'speech-running',
        avatarId: null,
        mode: 'speech',
        status: 'running',
        outputPath: 'G:\\output\\SMO-Speech\\running.wav',
      }),
      createWork({
        id: 'speech-failed',
        avatarId: null,
        mode: 'speech',
        status: 'failed',
        outputPath: 'G:\\output\\SMO-Speech\\failed.wav',
      }),
      createWork({
        id: 'speech-no-output',
        avatarId: null,
        mode: 'speech',
        status: 'done',
        outputPath: null,
      }),
      createWork({
        id: 'video-ready',
        mode: 'text',
        status: 'done',
        outputPath: 'G:\\output\\SMO-H3\\video.mp4',
      }),
    ]);

    expect(
      await screen.findByRole('button', { name: '用于音频数字人 speech-ready' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^用于音频数字人 / })).toHaveLength(1);
  });

  test.each(['wav', 'mp3', 'flac', 'm4a'])(
    '选择 %s 语音作品后进入视频音频数字人并直接读取预览和时长',
    async (extension) => {
      const id = `speech-${extension}`;
      const audioPath = `G:\\output\\SMO-Speech\\voice.${extension}`;
      await openWorksWith([doneSpeechWork(id, audioPath)]);

      const panel = await useSpeechWork(id);

      expect(studioModeButton('视频')).toHaveAttribute('aria-current', 'page');
      expect(studioModeButton('视频')).toHaveAttribute('aria-controls', 'video-main-panel');
      expect(studioModeButton('语音')).not.toHaveAttribute('aria-current');
      expect(screen.getByRole('tab', { name: '音频数字人', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(screen.getByRole('tab', { name: '音频数字人', exact: true })).toHaveAttribute(
        'tabindex',
        '0',
      );
      expect(screen.getByRole('tab', { name: '音频数字人', exact: true })).toHaveFocus();
      expect(screen.getByRole('tab', { name: '文字生视频' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      expect(panel.getByText(`voice.${extension}`)).toBeInTheDocument();
      const audio = await panel.findByLabelText('所选音频');
      expect(audio).toHaveAttribute(
        'src',
        `smo-media://media/${encodeURIComponent(audioPath)}`,
      );
      expect(smo.files.mediaUrl).toHaveBeenCalledWith(audioPath);
      expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
      expect(smo.files.selectAudio).not.toHaveBeenCalled();

      loadDuration(audio, 4.25 + ['wav', 'mp3', 'flac', 'm4a'].indexOf(extension));
      expect(panel.getByText(/音频时长：/)).toHaveTextContent(
        `音频时长：${(4.25 + ['wav', 'mp3', 'flac', 'm4a'].indexOf(extension)).toFixed(2)} 秒`,
      );
      expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(
        4.25 + ['wav', 'mp3', 'flac', 'm4a'].indexOf(extension),
      );
    },
  );

  test('选择语音作品后保留现有语音、文字视频和音频视频草稿及步数', async () => {
    const audioPath = 'G:\\output\\SMO-Speech\\drafts.wav';
    smo.works.list.mockResolvedValue([doneSpeechWork('speech-drafts', audioPath)]);
    await renderStudio();

    const textPanel = within(screen.getByRole('tabpanel', { name: '文字生视频' }));
    fireEvent.change(textPanel.getByLabelText('原始文字'), {
      target: { value: '保留文字视频草稿' },
    });
    fireEvent.change(textPanel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '13' },
    });

    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    let audioPanel = within(screen.getByRole('tabpanel', { name: '音频数字人' }));
    fireEvent.change(audioPanel.getByLabelText('动作/画面提示词'), {
      target: { value: '保留音频视频草稿' },
    });
    fireEvent.change(audioPanel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '17' },
    });
    fireEvent.change(audioPanel.getByLabelText('起始截取（秒）'), {
      target: { value: '2' },
    });
    fireEvent.change(audioPanel.getByLabelText('截取时长（秒）'), {
      target: { value: '3' },
    });

    fireEvent.click(studioModeButton('语音'));
    fireEvent.change(studioSpeechField('口播文字'), {
      target: { value: '保留语音作品草稿' },
    });
    fireEvent.change(studioSpeechField('情绪/语气'), {
      target: { value: '温和坚定' },
    });

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    audioPanel = await useSpeechWork('speech-drafts');

    expect(audioPanel.getByLabelText('动作/画面提示词')).toHaveValue('保留音频视频草稿');
    expect(audioPanel.getByRole('spinbutton', { name: '采样步数' })).toHaveValue(17);
    expect(audioPanel.getByLabelText('起始截取（秒）')).toHaveValue(0);
    expect(audioPanel.getByLabelText('截取时长（秒）')).toHaveValue(0);
    loadDuration(await audioPanel.findByLabelText('所选音频'), 8.5);
    expect(audioPanel.getByLabelText('截取时长（秒）')).toHaveValue(8.5);

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    expect(screen.getByLabelText('原始文字')).toHaveValue('保留文字视频草稿');
    expect(
      within(screen.getByRole('tabpanel', { name: '文字生视频' })).getByRole('spinbutton', {
        name: '采样步数',
      }),
    ).toHaveValue(13);

    fireEvent.click(studioModeButton('语音'));
    expect(studioSpeechField('口播文字')).toHaveValue('保留语音作品草稿');
    expect(studioSpeechField('情绪/语气')).toHaveValue('温和坚定');
  });

  test('返回作品页换选和重选同一路径时忽略旧 metadata 并重新读取', async () => {
    const firstPath = 'G:\\output\\SMO-Speech\\first.mp3';
    const secondPath = 'G:\\output\\SMO-Speech\\second.flac';
    await openWorksWith([
      doneSpeechWork('speech-first', firstPath),
      doneSpeechWork('speech-second', secondPath),
    ]);

    let panel = await useSpeechWork('speech-first');
    const firstAudio = await panel.findByLabelText('所选音频');
    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));

    panel = await useSpeechWork('speech-second');
    const secondAudio = await panel.findByLabelText('所选音频');
    expect(secondAudio).not.toBe(firstAudio);
    expect(panel.getByText('second.flac')).toBeInTheDocument();
    expect(panel.queryByText('first.mp3')).not.toBeInTheDocument();
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0);

    loadDuration(secondAudio, 6.5);
    loadDuration(firstAudio, 99);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(6.5);
    expect(panel.getByText('音频时长：6.50 秒')).toBeInTheDocument();
    expect(panel.queryByText('音频时长：99.00 秒')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    panel = await useSpeechWork('speech-second');
    const repeatedAudio = await panel.findByLabelText('所选音频');
    expect(repeatedAudio).not.toBe(secondAudio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0);
    expect(panel.queryByText('音频时长：6.50 秒')).not.toBeInTheDocument();

    loadDuration(secondAudio, 88);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0);
    loadDuration(repeatedAudio, 7.25);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(7.25);
    expect(panel.getByText('音频时长：7.25 秒')).toBeInTheDocument();
  });

  test('首次 mediaUrl 失败后同路径新 revision 会重新 IPC 并恢复预览', async () => {
    const audioPath = 'G:\\output\\SMO-Speech\\retry-media.wav';
    await openWorksWith([doneSpeechWork('speech-retry-media', audioPath)]);
    expect(
      await screen.findByLabelText('作品语音 speech-retry-media'),
    ).toBeInTheDocument();
    smo.files.mediaUrl.mockRejectedValueOnce(new Error('首次媒体读取失败'));

    let panel = await useSpeechWork('speech-retry-media');
    expect(await panel.findByRole('alert')).toHaveTextContent('首次媒体读取失败');
    expect(panel.queryByLabelText('所选音频')).not.toBeInTheDocument();
    const callsBeforeRetry = smo.files.mediaUrl.mock.calls.filter(
      ([path]) => path === audioPath,
    ).length;

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    panel = await useSpeechWork('speech-retry-media');

    const audio = await panel.findByLabelText('所选音频');
    expect(audio).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(audioPath)}`,
    );
    const callsAfterRetry = smo.files.mediaUrl.mock.calls.filter(
      ([path]) => path === audioPath,
    ).length;
    expect(callsAfterRetry).toBeGreaterThan(callsBeforeRetry);
    expect(panel.queryByRole('alert')).not.toBeInTheDocument();
    loadDuration(audio, 5.75);
    expect(panel.getByText('音频时长：5.75 秒')).toBeInTheDocument();
  });

  test('新语音作品使进行中的旧润色失效', async () => {
    const pending = deferred<PolishResult>();
    smo.llm.polish.mockImplementationOnce(() => pending.promise);
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\polish-original.wav');
    smo.works.list.mockResolvedValue([
      doneSpeechWork('speech-polish', 'G:\\output\\SMO-Speech\\polish-new.wav'),
    ]);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const originalAudio = await screen.findByLabelText('所选音频');
    loadDuration(originalAudio, 8);
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '旧音频润色草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'AI 润色' }));
    await waitFor(() => expect(smo.llm.polish).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    const panel = await useSpeechWork('speech-polish');
    expect(panel.getByText('polish-new.wav')).toBeInTheDocument();

    await act(async () => {
      pending.resolve({
        text: '过期润色结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
      await pending.promise;
    });

    expect(panel.getByText('polish-new.wav')).toBeInTheDocument();
    expect(panel.getByRole('tab', { name: '润色结果' })).toBeDisabled();
    expect(panel.queryByDisplayValue('过期润色结果')).not.toBeInTheDocument();
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test('生成提交中拒绝替换并提示，主进程不收到额外任务', async () => {
    const pending = deferred<{ id: string }>();
    smo.jobs.start.mockImplementationOnce(() => pending.promise);
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\busy-original.wav');
    smo.works.list.mockResolvedValue([
      doneSpeechWork('speech-busy', 'G:\\output\\SMO-Speech\\busy-new.mp3'),
    ]);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const originalAudio = await screen.findByLabelText('所选音频');
    loadDuration(originalAudio, 8);
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '正在提交的生成草稿' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: '我的作品' }));
    const panel = await useSpeechWork('speech-busy');

    expect(await panel.findByRole('alert')).toHaveTextContent(
      '生成任务进行中，完成后才能更换语音作品。',
    );
    expect(panel.getByText('busy-original.wav')).toBeInTheDocument();
    expect(panel.queryByText('busy-new.mp3')).not.toBeInTheDocument();
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);
    expect(smo.hardware.apply).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ id: 'existing-generation' });
      await pending.promise;
    });
    expect(panel.getByText('busy-original.wav')).toBeInTheDocument();
    expect(panel.queryByText('busy-new.mp3')).not.toBeInTheDocument();
    expect(smo.jobs.start).toHaveBeenCalledTimes(1);
  });
});

describe('录音', () => {
  class MockMediaRecorder {
    static instances: MockMediaRecorder[] = [];
    readonly stream: MediaStream;
    readonly mimeType = 'audio/webm';
    emitStopEvents = true;
    state: RecordingState = 'inactive';
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(stream: MediaStream) {
      this.stream = stream;
      MockMediaRecorder.instances.push(this);
    }

    start(): void {
      this.state = 'recording';
    }

    stop(): void {
      if (this.state === 'inactive') {
        return;
      }
      this.state = 'inactive';
      if (!this.emitStopEvents) {
        return;
      }
      this.ondataavailable?.({
        data: new Blob(['recorded audio'], { type: this.mimeType }),
      } as BlobEvent);
      this.onstop?.(new Event('stop'));
    }
  }

  const originalMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    'mediaDevices',
  );
  let getUserMedia: ReturnType<typeof vi.fn>;
  let tracks: Array<{ stop: ReturnType<typeof vi.fn> }>;

  beforeEach(() => {
    tracks = [];
    MockMediaRecorder.instances = [];
    getUserMedia = vi.fn(async () => {
      const track = { stop: vi.fn() };
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    vi.stubGlobal('MediaRecorder', MockMediaRecorder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalMediaDevices === undefined) {
      Reflect.deleteProperty(navigator, 'mediaDevices');
    } else {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    }
  });

  function renderRecorder() {
    const onRecorded = vi.fn();
    const onError = vi.fn();
    const view = render(
      <AudioRecorder onRecorded={onRecorded} onError={onError} />,
    );
    return { onError, onRecorded, view };
  }

  test('录音只在点击后申请麦克风，停止后保存字节并回调输出路径', async () => {
    const { onRecorded } = renderRecorder();

    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    const stop = await screen.findByRole('button', { name: '停止录音' });
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(MockMediaRecorder.instances[0]?.state).toBe('recording');

    fireEvent.click(stop);

    await waitFor(() =>
      expect(onRecorded).toHaveBeenCalledWith('G:\\data\\recordings\\recorded.wav'),
    );
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(smo.recordings.save).toHaveBeenCalledTimes(1);
    const blob = smo.recordings.save.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/webm');
    expect(await blob.text()).toBe('recorded audio');
  });

  test('录音计时使用固定的分秒显示', async () => {
    vi.useFakeTimers();
    const { view } = renderRecorder();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    });

    expect(screen.getByRole('timer', { name: '录音计时' })).toHaveTextContent(
      '00:00',
    );
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(screen.getByRole('timer', { name: '录音计时' })).toHaveTextContent(
      '00:02',
    );
    expect(screen.getByRole('timer', { name: '录音计时' })).toHaveClass(
      'audio-recorder-time',
    );
    view.unmount();
  });

  test('录音保存后可试听并通过重录更新同一音频状态', async () => {
    smo.recordings.save
      .mockResolvedValueOnce('G:\\data\\recordings\\one.wav')
      .mockResolvedValueOnce('G:\\data\\recordings\\two.wav');
    render(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
    const firstAudio = await screen.findByLabelText('所选音频');
    expect(screen.getByText('one.wav')).toBeInTheDocument();
    Object.defineProperty(firstAudio, 'duration', { configurable: true, value: 4.5 });
    fireEvent.loadedMetadata(firstAudio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(4.5);

    fireEvent.click(screen.getByRole('button', { name: '重录' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
    await screen.findByText('two.wav');
    const secondAudio = await screen.findByLabelText('所选音频');
    expect(secondAudio).not.toBe(firstAudio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(0);
    Object.defineProperty(secondAudio, 'duration', { configurable: true, value: 2.75 });
    fireEvent.loadedMetadata(secondAudio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(2.75);
    expect(smo.recordings.save).toHaveBeenCalledTimes(2);
  });

  test('视频子模式隐藏时录音保存中仍接受迟到路径并在返回面板后保留录音', async () => {
    let resolveSave!: (path: string) => void;
    smo.recordings.save.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSave = resolve;
        }),
    );
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
    await waitFor(() => expect(smo.recordings.save).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    await act(async () => {
      resolveSave('G:\\data\\recordings\\hidden-save.wav');
    });
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));

    expect(await screen.findByText('hidden-save.wav')).toBeInTheDocument();
    expect(await screen.findByLabelText('所选音频')).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\data\\recordings\\hidden-save.wav')}`,
    );
    expect(smo.recordings.discard).not.toHaveBeenCalled();
  });

  test('录音保存中 busy 仍更新同一音频状态', async () => {
    let resolveSave!: (path: string) => void;
    smo.recordings.save.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const form = (
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />
    );
    const view = render(form);
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
    await waitFor(() => expect(smo.recordings.save).toHaveBeenCalledTimes(1));

    view.rerender(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
        busy
      />,
    );
    await act(async () => {
      resolveSave('G:\\data\\recordings\\busy-save.wav');
    });

    expect(await screen.findByText('busy-save.wav')).toBeInTheDocument();
    expect(await screen.findByLabelText('所选音频')).toBeInTheDocument();
    expect(smo.recordings.discard).not.toHaveBeenCalled();
  });

  test('录音保存中卸载会 discard 迟到路径且不回调', async () => {
    let resolveSave!: (path: string) => void;
    smo.recordings.save.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const { onRecorded, view } = renderRecorder();
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));
    await waitFor(() => expect(smo.recordings.save).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      resolveSave('G:\\data\\recordings\\unmounted-save.wav');
    });

    await waitFor(() =>
      expect(smo.recordings.discard).toHaveBeenCalledWith(
        'G:\\data\\recordings\\unmounted-save.wav',
      ),
    );
    expect(onRecorded).not.toHaveBeenCalled();
  });

  test('录音 onerror 后到达的 dataavailable/stop 不保存也不替换已有音频', async () => {
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\original.mp3');
    render(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const originalAudio = await screen.findByLabelText('所选音频');
    Object.defineProperty(originalAudio, 'duration', {
      configurable: true,
      value: 8,
    });
    fireEvent.loadedMetadata(originalAudio);
    fireEvent.click(screen.getByRole('button', { name: '重录' }));
    const stopButton = await screen.findByRole('button', { name: '停止录音' });
    const recorder = MockMediaRecorder.instances[0]!;
    recorder.emitStopEvents = false;
    const queuedDataAvailable = recorder.ondataavailable;
    const queuedStop = recorder.onstop;
    fireEvent.click(stopButton);
    expect(smo.recordings.save).not.toHaveBeenCalled();

    await act(async () => {
      recorder.onerror?.(new Event('error'));
      await Promise.resolve();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('录音失败');

    await act(async () => {
      queuedDataAvailable?.({
        data: new Blob(['late audio'], { type: 'audio/webm' }),
      } as BlobEvent);
      queuedStop?.(new Event('stop'));
      await Promise.resolve();
    });

    expect(smo.recordings.save).not.toHaveBeenCalled();
    expect(screen.getByText('original.mp3')).toBeInTheDocument();
    expect(screen.getByLabelText('所选音频')).toBe(originalAudio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(8);
    expect(screen.queryByText('recorded.wav')).not.toBeInTheDocument();
  });

  test('录音权限拒绝时保留已有音频', async () => {
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\original.mp3');
    render(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 8 });
    fireEvent.loadedMetadata(audio);
    getUserMedia.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));

    fireEvent.click(screen.getByRole('button', { name: '重录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('麦克风权限被拒绝');
    expect(screen.getByText('original.mp3')).toBeInTheDocument();
    expect(screen.getByLabelText('所选音频')).toBe(audio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(8);
    expect(smo.recordings.save).not.toHaveBeenCalled();
  });

  test('录音转换失败时保留已有音频并显示中文错误', async () => {
    smo.files.selectAudio.mockResolvedValue('G:\\recordings\\original.mp3');
    smo.recordings.save.mockRejectedValue(new Error('FFmpeg failed'));
    render(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 8 });
    fireEvent.loadedMetadata(audio);

    fireEvent.click(screen.getByRole('button', { name: '重录' }));
    fireEvent.click(await screen.findByRole('button', { name: '停止录音' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('录音保存失败');
    expect(screen.getByText('original.mp3')).toBeInTheDocument();
    expect(screen.getByLabelText('所选音频')).toBe(audio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(8);
  });

  test('录音找不到麦克风时显示中文错误且不保存', async () => {
    const { onError, onRecorded } = renderRecorder();
    getUserMedia.mockRejectedValue(new DOMException('Missing', 'NotFoundError'));

    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('未检测到可用的麦克风'),
      ),
    );
    expect(onRecorded).not.toHaveBeenCalled();
    expect(smo.recordings.save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '开始录音' })).toBeEnabled();
  });

  test('录音没有媒体设备 API 时也报告无麦克风', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    });
    const { onError } = renderRecorder();

    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining('未检测到可用的麦克风'),
      ),
    );
    expect(smo.recordings.save).not.toHaveBeenCalled();
  });

  test('录音在隐藏和卸载时停止所有 track 且不保存', async () => {
    const { view } = renderRecorder();
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    await screen.findByRole('button', { name: '停止录音' });

    view.rerender(
      <AudioRecorder active={false} onRecorded={vi.fn()} onError={vi.fn()} />,
    );
    expect(tracks[0]?.stop).toHaveBeenCalledTimes(1);
    expect(smo.recordings.save).not.toHaveBeenCalled();

    view.rerender(<AudioRecorder active onRecorded={vi.fn()} onError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    await screen.findByRole('button', { name: '停止录音' });
    view.unmount();
    expect(tracks[1]?.stop).toHaveBeenCalledTimes(1);
    expect(smo.recordings.save).not.toHaveBeenCalled();
  });

  test('录音 busy 时禁止开始录音或替换音频', () => {
    render(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
        busy
      />,
    );

    expect(screen.getByRole('button', { name: '开始录音' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择音频' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  test('录音等待权限时进入 busy 会取消启动并关闭返回的 track', async () => {
    let resolveStream!: (stream: MediaStream) => void;
    const track = { stop: vi.fn() };
    tracks.push(track);
    getUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
    );
    const onRecorded = vi.fn();
    const onError = vi.fn();
    const view = render(
      <AudioRecorder onRecorded={onRecorded} onError={onError} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '开始录音' }));

    view.rerender(
      <AudioRecorder disabled onRecorded={onRecorded} onError={onError} />,
    );
    await act(async () => {
      resolveStream({ getTracks: () => [track] } as unknown as MediaStream);
    });

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(MockMediaRecorder.instances).toHaveLength(0);
    expect(onRecorded).not.toHaveBeenCalled();
    expect(smo.recordings.save).not.toHaveBeenCalled();
  });
});

describe('audio digital human studio', () => {
  function audioPanel(): HTMLElement {
    return screen.getByRole('tabpanel', { name: '音频数字人' });
  }

  async function renderLoadedAudio(audioPath: string, seconds: number): Promise<void> {
    smo.files.selectAudio.mockResolvedValue(audioPath);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: seconds });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(seconds);
  }

  test('audio drop authorizes one file, previews it, and keeps it after switching panels', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    const panel = within(audioPanel());
    const dropzone = panel.getByRole('group', { name: '音频拖放区' });
    const file = new File(['audio'], 'dropped.mp3', { type: 'audio/mpeg' });

    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    expect(smo.files.authorizeDroppedAudio).toHaveBeenCalledWith(file);
    expect(smo.files.selectAudio).not.toHaveBeenCalled();
    const audio = await panel.findByLabelText('所选音频');
    expect(audio).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent('G:\\dropped\\dropped.mp3')}`,
    );
    expect(panel.getByText('dropped.mp3')).toBeInTheDocument();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 7.25 });
    fireEvent.loadedMetadata(audio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(7.25);

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    expect(panel.getByText('dropped.mp3')).toBeInTheDocument();
    expect(panel.getByLabelText('所选音频')).toBe(audio);
  });

  test('audio drop 拖入多个文件时拒绝授权并显示错误', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    const panel = within(audioPanel());

    fireEvent.drop(panel.getByRole('group', { name: '音频拖放区' }), {
      dataTransfer: {
        files: [new File(['a'], 'a.mp3'), new File(['b'], 'b.wav')],
      },
    });

    expect(await panel.findByRole('alert')).toHaveTextContent('一次只能拖入一个音频文件');
    expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
    expect(panel.queryByLabelText('所选音频')).not.toBeInTheDocument();
  });

  test.each(['notes.txt', 'photo.png'])(
    'audio drop 拖入非音频 %s 时拒绝授权',
    async (name) => {
      await renderStudio();
      fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
      const panel = within(audioPanel());

      fireEvent.drop(panel.getByRole('group', { name: '音频拖放区' }), {
        dataTransfer: { files: [new File(['x'], name)] },
      });

      expect(await panel.findByRole('alert')).toHaveTextContent(
        '仅支持 WAV、MP3、FLAC、OGG 或 M4A 音频',
      );
      expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
    },
  );

  test('audio drop 拖入子元素触发 dragleave 时保留高亮', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    const panel = within(audioPanel());
    const dropzone = panel.getByRole('group', { name: '音频拖放区' });
    const child = panel.getByText('尚未选择音频');

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');
    const enterChild = new MouseEvent('dragleave', { bubbles: true });
    Object.defineProperty(enterChild, 'relatedTarget', { value: child });
    fireEvent(dropzone, enterChild);
    expect(dropzone).toHaveAttribute('data-drop-active', 'true');

    const leaveZone = new MouseEvent('dragleave', { bubbles: true });
    Object.defineProperty(leaveZone, 'relatedTarget', { value: document.body });
    fireEvent(dropzone, leaveZone);
    expect(dropzone).not.toHaveAttribute('data-drop-active');

    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['x'], 'reset.mp3')] },
    });
    expect(dropzone).not.toHaveAttribute('data-drop-active');
  });

  test('audio drop 过期对话框授权不能覆盖较新的拖入选择', async () => {
    let resolveSelect!: (path: string | null) => void;
    smo.files.selectAudio.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => { resolveSelect = resolve; }),
    );
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    const panel = within(audioPanel());

    fireEvent.click(panel.getByRole('button', { name: '选择音频' }));
    fireEvent.drop(panel.getByRole('group', { name: '音频拖放区' }), {
      dataTransfer: { files: [new File(['audio'], 'new-drop.wav')] },
    });
    expect(await panel.findByText('new-drop.wav')).toBeInTheDocument();

    await act(async () => {
      resolveSelect('G:\\recordings\\stale-dialog.mp3');
    });
    expect(panel.getByText('new-drop.wav')).toBeInTheDocument();
    expect(panel.queryByText('stale-dialog.mp3')).not.toBeInTheDocument();
  });

  test('audio drop 慢授权不能覆盖移除，并正确释放 selecting 状态', async () => {
    let resolveDrop!: (path: string) => void;
    smo.files.authorizeDroppedAudio.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveDrop = resolve; }),
    );
    await renderLoadedAudio('G:\\recordings\\original.mp3', 8);
    const panel = within(audioPanel());
    const dropzone = panel.getByRole('group', { name: '音频拖放区' });

    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['audio'], 'slow.mp3')] },
    });
    expect(dropzone).toHaveAttribute('aria-busy', 'true');
    expect(panel.getByRole('button', { name: '正在选择…' })).toBeDisabled();
    fireEvent.click(panel.getByRole('button', { name: '移除音频' }));
    expect(panel.queryByLabelText('所选音频')).not.toBeInTheDocument();

    await act(async () => {
      resolveDrop('G:\\dropped\\slow.mp3');
    });
    expect(panel.queryByText('slow.mp3')).not.toBeInTheDocument();
    expect(panel.queryByLabelText('所选音频')).not.toBeInTheDocument();
    expect(dropzone).toHaveAttribute('aria-busy', 'false');
    expect(panel.getByRole('button', { name: '选择音频' })).toBeEnabled();
  });

  test('audio drop 生成中禁止替换当前音频', async () => {
    let resolveStart!: (value: { id: string }) => void;
    smo.jobs.start.mockImplementationOnce(
      () => new Promise<{ id: string }>((resolve) => { resolveStart = resolve; }),
    );
    await renderLoadedAudio('G:\\recordings\\generating.mp3', 8);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '生成期间保持当前音频' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));
    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));

    const dropzone = panel.getByRole('group', { name: '音频拖放区' });
    expect(dropzone).toHaveAttribute('aria-disabled', 'true');
    expect(panel.getByRole('button', { name: '选择音频' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '移除音频' })).toBeDisabled();
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['audio'], 'replacement.mp3')] },
    });
    expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
    expect(panel.getByText('generating.mp3')).toBeInTheDocument();
    expect(panel.queryByText('replacement.mp3')).not.toBeInTheDocument();

    await act(async () => {
      resolveStart({ id: 'audio-drop-generation' });
    });
  });

  test('audio drop 全局 busy 禁止替换当前音频', async () => {
    const audioPath = 'G:\\recordings\\busy-original.mp3';
    smo.files.selectAudio.mockResolvedValue(audioPath);
    const form = (
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
      />
    );
    const view = render(form);
    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 8 });
    fireEvent.loadedMetadata(audio);

    view.rerender(
      <AudioDigitalHumanForm
        avatarId={avatar.id}
        modelDirectory={DEFAULT_MODEL_DIRECTORY}
        busy
      />,
    );
    const dropzone = screen.getByRole('group', { name: '音频拖放区' });
    expect(dropzone).toHaveAttribute('aria-disabled', 'true');
    fireEvent.dragOver(dropzone, { dataTransfer: { files: [] } });
    expect(dropzone).not.toHaveAttribute('data-drop-active');
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(['audio'], 'busy-replacement.mp3')] },
    });

    expect(smo.files.authorizeDroppedAudio).not.toHaveBeenCalled();
    expect(screen.getByText('busy-original.mp3')).toBeInTheDocument();
    expect(screen.queryByText('busy-replacement.mp3')).not.toBeInTheDocument();
  });

  test('重复选择同一音频会重新读取时长、忽略旧 metadata 并可润色', async () => {
    const audioPath = 'G:\\recordings\\repeat-select.mp3';
    smo.llm.polish.mockResolvedValue({
      text: '重复选择后的润色结果',
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    await renderLoadedAudio(audioPath, 12.5);
    const panel = within(audioPanel());
    const firstAudio = panel.getByLabelText('所选音频');
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '重复选择后仍能润色' },
    });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '1' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '5' } });

    fireEvent.click(panel.getByRole('button', { name: '选择音频' }));
    await waitFor(() => expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0));
    expect(panel.getByLabelText('起始截取（秒）')).toHaveValue(0);
    expect(panel.queryByText('音频时长：12.50 秒')).not.toBeInTheDocument();
    const secondAudio = await panel.findByLabelText('所选音频');
    expect(secondAudio).not.toBe(firstAudio);

    Object.defineProperty(firstAudio, 'duration', { configurable: true, value: 99 });
    fireEvent.loadedMetadata(firstAudio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0);
    expect(panel.queryByText('音频时长：99.00 秒')).not.toBeInTheDocument();

    Object.defineProperty(secondAudio, 'duration', { configurable: true, value: 6.25 });
    fireEvent.loadedMetadata(secondAudio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(6.25);
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));

    expect(await panel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '重复选择后的润色结果',
    );
    expect(smo.llm.polish).toHaveBeenCalledWith(
      expect.objectContaining({ text: '重复选择后仍能润色', duration: 6.25 }),
    );
  });

  test('重复拖入同一音频会重新读取时长、忽略旧 metadata 并可生成', async () => {
    const audioPath = 'G:\\recordings\\repeat-drop.mp3';
    await renderLoadedAudio(audioPath, 9);
    const panel = within(audioPanel());
    const firstAudio = panel.getByLabelText('所选音频');
    smo.files.authorizeDroppedAudio.mockResolvedValue(audioPath);

    fireEvent.drop(panel.getByRole('group', { name: '音频拖放区' }), {
      dataTransfer: {
        files: [new File(['audio'], 'repeat-drop.mp3', { type: 'audio/mpeg' })],
      },
    });
    await waitFor(() => expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0));
    const secondAudio = await panel.findByLabelText('所选音频');
    expect(secondAudio).not.toBe(firstAudio);

    Object.defineProperty(firstAudio, 'duration', { configurable: true, value: 88 });
    fireEvent.loadedMetadata(firstAudio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(0);
    expect(panel.queryByText('音频时长：88.00 秒')).not.toBeInTheDocument();

    Object.defineProperty(secondAudio, 'duration', { configurable: true, value: 5.5 });
    fireEvent.loadedMetadata(secondAudio);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(5.5);
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '重复拖入后仍能生成' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));
    expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'audio',
        audioPath,
        prompt: '重复拖入后仍能生成',
        trimStart: 0,
        duration: 5.5,
      }),
    );
  });

  test('polishes the actual clip without media payloads and generates the edited result once', async () => {
    const audioPath = 'G:\\recordings\\polish.mp3';
    smo.llm.polish.mockResolvedValue({
      text: '润色后的音频数字人镜头',
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    await renderLoadedAudio(audioPath, 12.5);
    const panel = within(audioPanel());

    expect(panel.getByLabelText('视频风格（Skill）')).toHaveValue('h3-prompt-writing');
    expect(panel.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(panel.getByRole('tab', { name: '润色结果' })).toBeDisabled();
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '自然说话，轻微点头' },
    });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '1.25' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '6' } });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));

    expect(await panel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '润色后的音频数字人镜头',
    );
    expect(smo.llm.polish).toHaveBeenCalledWith({
      text: '自然说话，轻微点头',
      duration: 6,
      imageCount: 1,
      mode: 'ref2va',
      referenceLabels: ['<Picture 1>', '<Audio 1>'],
      skill: 'h3-prompt-writing',
    });
    const polishRequest = smo.llm.polish.mock.calls[0][0];
    expect(polishRequest).not.toHaveProperty('audioPath');
    expect(JSON.stringify(polishRequest)).not.toContain(audioPath);
    expect(smo.jobs.start).not.toHaveBeenCalled();

    fireEvent.change(panel.getByRole('textbox', { name: '润色结果' }), {
      target: { value: '用户确认的音频数字人镜头' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));
    expect(smo.jobs.start).toHaveBeenCalledWith({
      mode: 'audio',
      avatarId: avatar.id,
      prompt: '用户确认的音频数字人镜头',
      audioPath,
      trimStart: 1.25,
      duration: 6,
      seed: 42,
      steps: 6,
    });
    expect(smo.hardware.apply).toHaveBeenCalledTimes(1);
  });

  test('keeps the original audio draft and options after a polish failure', async () => {
    const audioPath = 'G:\\recordings\\polish-failure.mp3';
    smo.llm.polish.mockRejectedValue(new Error('LLM 暂时不可用'));
    await renderLoadedAudio(audioPath, 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '失败后保留的原文' },
    });
    fireEvent.change(panel.getByLabelText('视频风格（Skill）'), {
      target: { value: 'auto' },
    });
    fireEvent.change(panel.getByLabelText('H3 模型'), { target: { value: 'bf16' } });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '1.25' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '6' } });
    fireEvent.change(panel.getByRole('spinbutton', { name: '随机种子' }), {
      target: { value: '7' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));

    expect(await panel.findByRole('alert')).toHaveTextContent('LLM 暂时不可用');
    expect(panel.getByLabelText('动作/画面提示词')).toHaveValue('失败后保留的原文');
    expect(panel.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(panel.getByText('polish-failure.mp3')).toBeInTheDocument();
    expect(panel.getByLabelText('所选音频')).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(audioPath)}`,
    );
    expect(panel.getByLabelText('视频风格（Skill）')).toHaveValue('auto');
    expect(panel.getByLabelText('H3 模型')).toHaveValue('bf16');
    expect(panel.getByLabelText('起始截取（秒）')).toHaveValue(1.25);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(6);
    expect(panel.getByRole('spinbutton', { name: '随机种子' })).toHaveValue(7);

    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));
    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: '失败后保留的原文', mode: 'audio' }),
      ),
    );
  });

  test('keeps audio prompt drafts and the selected clip when switching modules', async () => {
    smo.llm.polish.mockResolvedValue({
      text: '跨模块保留的润色草稿',
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    await renderLoadedAudio('G:\\recordings\\draft.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '跨模块保留的原文' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    expect(await panel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '跨模块保留的润色草稿',
    );

    fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    expect(panel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
      '跨模块保留的润色草稿',
    );

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(studioModeButton('视频'));
      expect(panel.getByRole('textbox', { name: '润色结果' })).toHaveValue(
        '跨模块保留的润色草稿',
      );
      expect(panel.getByText('draft.mp3')).toBeInTheDocument();
    }

    fireEvent.click(panel.getByRole('tab', { name: '原文' }));
    expect(panel.getByLabelText('动作/画面提示词')).toHaveValue('跨模块保留的原文');
  });

  test('rejects an invalid actual audio trim before polishing', async () => {
    await renderLoadedAudio('G:\\recordings\\invalid-polish-trim.mp3', 5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '不能绕过时长校验' },
    });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '4' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '2' } });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));

    expect(await panel.findByRole('alert')).toHaveTextContent(
      '截取范围不能超出实际音频时长',
    );
    expect(smo.llm.polish).not.toHaveBeenCalled();
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test.each([
    { label: '动作/画面提示词', value: 'pending 后修改的原文' },
    { label: '起始截取（秒）', value: '2' },
    { label: '截取时长（秒）', value: '5' },
  ])('discards a stale polish response after changing $label', async ({ label, value }) => {
    let resolvePolish: ((value: PolishResult) => void) | undefined;
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvePolish = resolve;
        }),
    );
    await renderLoadedAudio('G:\\recordings\\stale-context.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '发起润色时的原文' },
    });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '1' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '6' } });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    fireEvent.change(panel.getByLabelText(label), { target: { value } });

    await act(async () => {
      resolvePolish?.({
        text: '不应覆盖新草稿的旧润色结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });

    expect(panel.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(panel.getByRole('tab', { name: '润色结果' })).toBeDisabled();
    expect(panel.queryByRole('textbox', { name: '润色结果' })).not.toBeInTheDocument();
    expect(panel.getByLabelText(label)).toHaveValue(
      label === '动作/画面提示词' ? value : Number(value),
    );
  });

  test('discards a stale polish response after changing Skill', async () => {
    let resolvePolish: ((value: PolishResult) => void) | undefined;
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvePolish = resolve;
        }),
    );
    await renderLoadedAudio('G:\\recordings\\stale-skill.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: 'Skill 竞态原文' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    expect(smo.llm.polish).toHaveBeenCalledWith(
      expect.objectContaining({ skill: 'h3-prompt-writing' }),
    );
    fireEvent.change(panel.getByLabelText('视频风格（Skill）'), {
      target: { value: 'auto' },
    });

    await act(async () => {
      resolvePolish?.({
        text: '不应被接受的旧 Skill 结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });

    expect(panel.getByLabelText('视频风格（Skill）')).toHaveValue('auto');
    expect(panel.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(panel.getByRole('tab', { name: '润色结果' })).toBeDisabled();
    expect(panel.queryByRole('textbox', { name: '润色结果' })).not.toBeInTheDocument();
    expect(panel.getByLabelText('动作/画面提示词')).toHaveValue('Skill 竞态原文');
  });

  test('invalidates an old request when audio changes and only applies the newest polish', async () => {
    const resolvers: Array<(value: PolishResult) => void> = [];
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await renderLoadedAudio('G:\\recordings\\first-pending.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '连续润色的原文' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    expect(smo.llm.polish).toHaveBeenCalledTimes(1);

    smo.files.selectAudio.mockResolvedValueOnce('G:\\recordings\\second-pending.mp3');
    fireEvent.click(panel.getByRole('button', { name: '选择音频' }));
    expect(await panel.findByText('second-pending.mp3')).toBeInTheDocument();
    const secondAudio = await panel.findByLabelText('所选音频');
    Object.defineProperty(secondAudio, 'duration', { configurable: true, value: 8 });
    fireEvent.loadedMetadata(secondAudio);
    expect(panel.getByRole('button', { name: 'AI 润色' })).toBeEnabled();
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    expect(smo.llm.polish).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolvers[0]({
        text: '第一个音频的过期结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });
    expect(panel.getByRole('tab', { name: '原文' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(panel.getByRole('tab', { name: '润色结果' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '正在润色…' })).toBeDisabled();

    await act(async () => {
      resolvers[1]({
        text: '第二个音频的最新结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });
    expect(await panel.findByRole('textbox', { name: '润色结果' })).toHaveValue(
      '第二个音频的最新结果',
    );
  });

  test('blocks generation entry while a polish request is pending', async () => {
    let resolvePolish: ((value: PolishResult) => void) | undefined;
    smo.llm.polish.mockImplementation(
      () =>
        new Promise<PolishResult>((resolve) => {
          resolvePolish = resolve;
        }),
    );
    await renderLoadedAudio('G:\\recordings\\polish-exclusive.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '润色期间不能生成' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));

    const generateButton = panel.getByRole('button', { name: '生成视频' });
    expect(generateButton).toBeDisabled();
    fireEvent.submit(generateButton.closest('form') as HTMLFormElement);
    expect(smo.hardware.apply).not.toHaveBeenCalled();
    expect(smo.jobs.start).not.toHaveBeenCalled();

    await act(async () => {
      resolvePolish?.({
        text: '互斥测试润色结果',
        skill: 'h3-prompt-writing',
        mode: 'ref2va',
        attempts: 1,
      });
    });
    expect(await panel.findByRole('textbox', { name: '润色结果' })).toBeInTheDocument();
  });

  test('blocks polish entry while generation is pending', async () => {
    let resolveStart: ((value: { id: string }) => void) | undefined;
    smo.jobs.start.mockImplementation(
      () =>
        new Promise<{ id: string }>((resolve) => {
          resolveStart = resolve;
        }),
    );
    await renderLoadedAudio('G:\\recordings\\generation-exclusive.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '生成期间不能润色' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));
    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));

    const polishButton = panel.getByRole('button', { name: 'AI 润色' });
    expect(polishButton).toBeDisabled();
    fireEvent.click(polishButton);
    expect(smo.llm.polish).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart?.({ id: 'exclusive-job' });
    });
    expect(panel.getByRole('button', { name: 'AI 润色' })).toBeEnabled();
  });

  test('supports keyboard tabs and returns to original when polished text is cleared', async () => {
    smo.llm.polish.mockResolvedValue({
      text: '可键盘切换的润色结果',
      skill: 'h3-prompt-writing',
      mode: 'ref2va',
      attempts: 1,
    });
    await renderLoadedAudio('G:\\recordings\\keyboard-tabs.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '键盘 tabs 原文' },
    });
    fireEvent.click(panel.getByRole('button', { name: 'AI 润色' }));
    expect(await panel.findByRole('textbox', { name: '润色结果' })).toBeInTheDocument();
    const originalTab = panel.getByRole('tab', { name: '原文' });
    const polishedTab = panel.getByRole('tab', { name: '润色结果' });

    fireEvent.click(originalTab);
    expect(originalTab).toHaveAttribute('tabindex', '0');
    expect(polishedTab).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(originalTab, { key: 'ArrowRight' });
    expect(polishedTab).toHaveFocus();
    expect(polishedTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(polishedTab, { key: 'ArrowRight' });
    expect(originalTab).toHaveFocus();
    fireEvent.keyDown(originalTab, { key: 'ArrowLeft' });
    expect(polishedTab).toHaveFocus();
    fireEvent.keyDown(polishedTab, { key: 'Home' });
    expect(originalTab).toHaveFocus();
    fireEvent.keyDown(originalTab, { key: 'End' });
    expect(polishedTab).toHaveFocus();
    expect(polishedTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.change(panel.getByRole('textbox', { name: '润色结果' }), {
      target: { value: '' },
    });
    expect(originalTab).toHaveAttribute('aria-selected', 'true');
    expect(originalTab).toHaveAttribute('tabindex', '0');
    expect(originalTab).toHaveFocus();
    expect(polishedTab).toBeDisabled();
    expect(polishedTab).toHaveAttribute('tabindex', '-1');
    expect(panel.getByLabelText('动作/画面提示词')).toHaveValue('键盘 tabs 原文');
  });

  test('starts only one job for repeated generation clicks', async () => {
    await renderLoadedAudio('G:\\recordings\\duplicate-generation.mp3', 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '重复点击只生成一次' },
    });
    const generateButton = panel.getByRole('button', { name: '生成视频' });

    act(() => {
      fireEvent.click(generateButton);
      fireEvent.click(generateButton);
    });

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));
    expect(smo.hardware.apply).toHaveBeenCalledTimes(1);
  });

  test('keeps audio, original text, and options when generation fails', async () => {
    const audioPath = 'G:\\recordings\\generation-failure.mp3';
    smo.jobs.start.mockRejectedValue(new Error('生成服务不可用'));
    await renderLoadedAudio(audioPath, 12.5);
    const panel = within(audioPanel());
    fireEvent.change(panel.getByLabelText('动作/画面提示词'), {
      target: { value: '生成失败后保留原文' },
    });
    fireEvent.change(panel.getByLabelText('视频风格（Skill）'), {
      target: { value: 'auto' },
    });
    fireEvent.change(panel.getByLabelText('H3 模型'), { target: { value: 'bf16' } });
    fireEvent.change(panel.getByLabelText('起始截取（秒）'), { target: { value: '1.25' } });
    fireEvent.change(panel.getByLabelText('截取时长（秒）'), { target: { value: '6' } });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    expect(await panel.findByRole('alert')).toHaveTextContent('生成服务不可用');
    expect(panel.getByLabelText('动作/画面提示词')).toHaveValue('生成失败后保留原文');
    expect(panel.getByText('generation-failure.mp3')).toBeInTheDocument();
    expect(panel.getByLabelText('所选音频')).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(audioPath)}`,
    );
    expect(panel.getByLabelText('视频风格（Skill）')).toHaveValue('auto');
    expect(panel.getByLabelText('H3 模型')).toHaveValue('bf16');
    expect(panel.getByLabelText('起始截取（秒）')).toHaveValue(1.25);
    expect(panel.getByLabelText('截取时长（秒）')).toHaveValue(6);
    expect(panel.getByRole('button', { name: '生成视频' })).toBeEnabled();
  });

  test.each([
    { scenario: 'blank', trimStart: '' },
    { scenario: 'out-of-range', trimStart: '13' },
  ])('shows generic automatic duration feedback when trim start is $scenario', async ({ trimStart }) => {
    await renderLoadedAudio('G:\\recordings\\invalid-trim.mp3', 12.5);
    const trimInput = screen.getByLabelText('起始截取（秒）');
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), { target: { value: '' } });
    fireEvent.change(trimInput, { target: { value: trimStart } });

    expect(screen.getByText('留空自动：使用剩余音频时长')).toHaveAttribute(
      'id',
      'audio-duration-hint',
    );
    expect(screen.queryByText(/留空自动：使用剩余 .* 秒/)).not.toBeInTheDocument();

    fireEvent.change(trimInput, { target: { value: '1.25' } });

    expect(screen.getByText('留空自动：使用剩余 11.25 秒')).toBeInTheDocument();
    expect(screen.queryByText('留空自动：使用剩余音频时长')).not.toBeInTheDocument();
  });

  test.each([
    {
      scenario: 'a range slightly beyond epsilon',
      seconds: 12.4989,
      trimStart: '1.25',
      clipDuration: '11.25',
    },
    {
      scenario: 'a trim start equal to the audio duration',
      seconds: 12.5,
      trimStart: '12.5',
      clipDuration: '12.5',
    },
    {
      scenario: 'a trim start beyond the audio duration',
      seconds: 12.5,
      trimStart: '12.51',
      clipDuration: '12.5',
    },
  ])('rejects $scenario', async ({ seconds, trimStart, clipDuration }) => {
    await renderLoadedAudio('G:\\recordings\\rejected-trim.mp3', seconds);
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '自然说话，轻微点头' },
    });
    fireEvent.change(screen.getByLabelText('起始截取（秒）'), { target: { value: trimStart } });
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), {
      target: { value: clipDuration },
    });
    expect(screen.getByLabelText('起始截取（秒）')).toHaveValue(Number(trimStart));
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(Number(clipDuration));
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('截取范围不能超出实际音频时长');
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test.each([
    { scenario: 'duration 0.001', trimStart: '0', clipDuration: '0.001' },
    { scenario: 'duration 0.011 off step', trimStart: '0', clipDuration: '0.011' },
    { scenario: 'trimStart 0.001', trimStart: '0.001', clipDuration: '6' },
  ])('rejects $scenario without submitting', async ({ trimStart, clipDuration }) => {
    await renderLoadedAudio('G:\\recordings\\step-precision.mp3', 12.5);
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '保留音频百分秒步进约束' },
    });
    fireEvent.change(screen.getByLabelText('起始截取（秒）'), {
      target: { value: trimStart },
    });
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), {
      target: { value: clipDuration },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    });

    expect(smo.jobs.start).not.toHaveBeenCalled();
    expect(smo.hardware.apply).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/截取|时长/);
  });

  test('accepts hundredth-aligned audio values with floating-point epsilon', async () => {
    await renderLoadedAudio('G:\\recordings\\floating-step.mp3', 12.5);
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '合法百分秒浮点值' },
    });
    fireEvent.change(screen.getByLabelText('起始截取（秒）'), {
      target: { value: '0.07' },
    });
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), {
      target: { value: '0.29' },
    });

    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ trimStart: 0.07, duration: 0.29 }),
      ),
    );
  });

  test('uses the remaining audio seconds when the clip duration is blank', async () => {
    const audioPath = 'G:\\recordings\\remaining.mp3';
    smo.files.selectAudio.mockResolvedValue(audioPath);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));

    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    expect(await screen.findByText('remaining.mp3')).toBeInTheDocument();
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 12.5 });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(12.5);

    fireEvent.change(screen.getByLabelText('起始截取（秒）'), { target: { value: '1.25' } });
    const durationInput = screen.getByLabelText('截取时长（秒）');
    fireEvent.change(durationInput, { target: { value: '' } });

    expect(durationInput).toHaveAttribute('aria-describedby', 'audio-duration-hint');
    expect(screen.getByText('留空自动：使用剩余 11.25 秒')).toHaveAttribute(
      'id',
      'audio-duration-hint',
    );

    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '自然说话，轻微点头' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({
          audioPath,
          trimStart: 1.25,
          duration: 11.25,
        }),
      ),
    );
  });

  test('allows automatic remaining duration within the floating-point epsilon', async () => {
    const audioPath = 'G:\\recordings\\floating-point.mp3';
    smo.files.selectAudio.mockResolvedValue(audioPath);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));

    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 10.01 });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(10.01);

    fireEvent.change(screen.getByLabelText('起始截取（秒）'), { target: { value: '0.71' } });
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '自然说话，轻微点头' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({
          audioPath,
          trimStart: 0.71,
          duration: 9.3,
        }),
      ),
    );
  });

  test('reads audio metadata, starts with the selected clip seconds, and cancels by job id', async () => {
    const audioPath = 'G:\\recordings\\voice.mp3';
    smo.files.selectAudio.mockResolvedValue(audioPath);
    smo.jobs.start.mockResolvedValue({ id: 'audio-job' });
    smo.works.list.mockResolvedValue([
      createWork({ id: 'audio-job', mode: 'audio', status: 'running' }),
    ]);
    await renderStudio();
    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));

    fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
    expect(await screen.findByText('voice.mp3')).toBeInTheDocument();
    const audio = await screen.findByLabelText('所选音频');
    Object.defineProperty(audio, 'duration', { configurable: true, value: 12.5 });
    fireEvent.loadedMetadata(audio);
    expect(screen.getByText('音频时长：12.50 秒')).toBeInTheDocument();
    expect(screen.getByLabelText('截取时长（秒）')).toHaveValue(12.5);

    fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
      target: { value: '自然说话，轻微点头' },
    });
    fireEvent.change(screen.getByLabelText('起始截取（秒）'), { target: { value: '1.25' } });
    fireEvent.change(screen.getByLabelText('截取时长（秒）'), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '随机种子' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));

    expect(smo.files.mediaUrl).toHaveBeenCalledWith(audioPath);
    await waitFor(() =>
      expect(smo.jobs.start).toHaveBeenCalledWith({
        mode: 'audio',
        avatarId: avatar.id,
        prompt: '自然说话，轻微点头',
        audioPath,
        trimStart: 1.25,
        duration: 6,
        seed: 7,
        steps: 6,
      }),
    );
    await waitFor(() =>
      expect(smo.hardware.apply).toHaveBeenCalledWith({
        mode: 'audio',
        profile: {
          preset: 'balanced-16gb',
          modelPolicy: 'int8',
          megapixels: 0.7,
          aspectRatio: '16:9 (Widescreen)',
          lowvram: true,
          tiling: 'auto',
          requiresConfirmation: true,
        },
        confirmed: true,
        modelDirectory: DEFAULT_MODEL_DIRECTORY,
      }),
    );
    const [applyOrder] = smo.hardware.apply.mock.invocationCallOrder;
    const [startOrder] = smo.jobs.start.mock.invocationCallOrder;
    expect(applyOrder).toBeLessThan(startOrder);
    expect(await screen.findByText('运行中（running）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消当前任务' }));
    expect(smo.jobs.cancel).toHaveBeenCalledWith('audio-job');
    expect(smo.jobs.cancel).not.toHaveBeenCalledWith();
  });

  test('pauses the audio preview when leaving the studio page', async () => {
    await renderLoadedAudio('G:\\recordings\\nav-pause.mp3', 12.5);
    const audio = screen.getByLabelText('所选音频');
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    try {
      expect(pauseSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: '我的作品' }));

      expect(pauseSpy).toHaveBeenCalled();
      // Studio stays mounted (kept alive) while hidden, so the audio element persists.
      expect(screen.getByLabelText('所选音频')).toBe(audio);
      expect(pauseSpy.mock.instances).toContain(audio);
    } finally {
      pauseSpy.mockRestore();
    }
  });

  test('pauses the audio preview when opening the settings page', async () => {
    await renderLoadedAudio('G:\\recordings\\settings-pause.mp3', 12.5);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    try {
      fireEvent.click(screen.getByRole('button', { name: '设置' }));

      expect(pauseSpy).toHaveBeenCalled();
    } finally {
      pauseSpy.mockRestore();
    }
  });

  test('pauses the audio preview when switching back to text mode', async () => {
    await renderLoadedAudio('G:\\recordings\\mode-pause.mp3', 12.5);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, 'pause');
    try {
      expect(pauseSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('tab', { name: '文字生视频' }));

      expect(pauseSpy).toHaveBeenCalled();
    } finally {
      pauseSpy.mockRestore();
    }
  });
});

describe('采样步数与 busy', () => {
  type Mode = 'text' | 'audio';

  function panelFor(mode: Mode): HTMLElement {
    return screen.getByRole('tabpanel', {
      name: mode === 'text' ? '文字生视频' : '音频数字人',
    });
  }

  async function prepareGeneration(mode: Mode) {
    if (mode === 'audio') {
      smo.files.selectAudio.mockResolvedValue('G:\\recordings\\steps.mp3');
      await renderStudio();
      fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
      fireEvent.click(screen.getByRole('button', { name: '选择音频' }));
      const audio = await screen.findByLabelText('所选音频');
      Object.defineProperty(audio, 'duration', { configurable: true, value: 12 });
      fireEvent.loadedMetadata(audio);
      fireEvent.change(screen.getByLabelText('动作/画面提示词'), {
        target: { value: '自然说话并轻微点头' },
      });
    } else {
      await renderStudio();
      fireEvent.change(screen.getByLabelText('原始文字'), {
        target: { value: '主播转身并挥手' },
      });
    }
    return within(panelFor(mode));
  }

  test.each([
    { mode: 'text' as const, defaultSteps: 8 },
    { mode: 'audio' as const, defaultSteps: 6 },
  ])('$mode 表单步数支持从默认值逐次增加和减少', async ({ mode, defaultSteps }) => {
    const panel = await prepareGeneration(mode);
    const input = panel.getByRole('spinbutton', { name: '采样步数' });

    expect(input).toHaveValue(defaultSteps);
    fireEvent.click(panel.getByRole('button', { name: '增加步数' }));
    expect(input).toHaveValue(defaultSteps + 1);
    expect(panel.getByText('高于推荐值会增加耗时')).toBeInTheDocument();

    fireEvent.click(panel.getByRole('button', { name: '减少步数' }));
    expect(input).toHaveValue(defaultSteps);
    expect(panel.queryByText('高于推荐值会增加耗时')).not.toBeInTheDocument();
    fireEvent.click(panel.getByRole('button', { name: '减少步数' }));
    expect(input).toHaveValue(defaultSteps - 1);
  });

  test('步数清空为 NaN 时禁用加减按钮', async () => {
    const panel = await prepareGeneration('text');
    fireEvent.change(panel.getByRole('spinbutton', { name: '采样步数' }), {
      target: { value: '' },
    });

    expect(panel.getByRole('button', { name: '减少步数' })).toBeDisabled();
    expect(panel.getByRole('button', { name: '增加步数' })).toBeDisabled();
  });

  test('步数推荐和耗时提示使用 aria-live polite', async () => {
    const panel = await prepareGeneration('text');
    const hint = document.getElementById('text-steps-hint');
    expect(hint).toHaveAttribute('aria-live', 'polite');

    fireEvent.click(panel.getByRole('button', { name: '增加步数' }));
    expect(hint).toHaveTextContent('高于推荐值会增加耗时');
  });

  test.each(['text', 'audio'] as const)(
    '%s 表单提交直接输入的 12 步',
    async (mode) => {
      const panel = await prepareGeneration(mode);
      fireEvent.change(panel.getByRole('spinbutton', { name: '采样步数' }), {
        target: { value: '12' },
      });
      fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

      await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));
      expect(smo.jobs.start).toHaveBeenCalledWith(
        expect.objectContaining({ mode, steps: 12 }),
      );
    },
  );

  test.each(['text', 'audio'] as const)(
    '%s 表单步数为 0、101 或小数时显示中文错误且不提交',
    async (mode) => {
      const panel = await prepareGeneration(mode);
      const input = panel.getByRole('spinbutton', { name: '采样步数' });

      for (const value of [0, 101, 1.5]) {
        fireEvent.change(input, { target: { value: String(value) } });
        fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

        expect(await panel.findByRole('alert')).toHaveTextContent(
          /采样步数.*1.*100.*整数/,
        );
        expect(smo.hardware.apply).not.toHaveBeenCalled();
        expect(smo.jobs.start).not.toHaveBeenCalled();
      }
    },
  );

  test.each(['text', 'audio'] as const)(
    '%s 表单生成中不能修改步数',
    async (mode) => {
      let resolveStart: ((value: { id: string }) => void) | undefined;
      smo.jobs.start.mockImplementation(
        () =>
          new Promise<{ id: string }>((resolve) => {
            resolveStart = resolve;
          }),
      );
      const panel = await prepareGeneration(mode);
      fireEvent.click(panel.getByRole('button', { name: '生成视频' }));
      await waitFor(() => expect(smo.jobs.start).toHaveBeenCalledTimes(1));

      expect(panel.getByRole('spinbutton', { name: '采样步数' })).toBeDisabled();
      expect(panel.getByRole('button', { name: '减少步数' })).toBeDisabled();
      expect(panel.getByRole('button', { name: '增加步数' })).toBeDisabled();

      await act(async () => {
        resolveStart?.({ id: `${mode}-steps-job` });
      });
    },
  );

  test.each(['text', 'audio'] as const)(
    '%s 表单在 jobs:start 成功后立即刷新 busy',
    async (mode) => {
      smo.jobs.getState
        .mockResolvedValueOnce({ activeId: null })
        .mockResolvedValue({ activeId: 'job-1' });
      const panel = await prepareGeneration(mode);
      await waitFor(() => expect(smo.jobs.getState).toHaveBeenCalledTimes(1));
      vi.useFakeTimers();
      const generateButton = panel.getByRole('button', { name: '生成视频' });

      await act(async () => {
        fireEvent.click(generateButton);
      });

      expect(smo.jobs.start).toHaveBeenCalledTimes(1);
      expect(smo.jobs.getState).toHaveBeenCalledTimes(2);
      expect(generateButton).toBeDisabled();
    },
  );

  test('全局 busy 禁用两个表单的生成和操作按钮，但保留纯文本草稿输入', async () => {
    smo.jobs.getState.mockResolvedValue({ activeId: 'existing-job' });
    await renderStudio();
    const textPanel = within(panelFor('text'));

    await waitFor(() =>
      expect(textPanel.getByRole('button', { name: '生成视频' })).toBeDisabled(),
    );
    expect(textPanel.getByRole('button', { name: 'AI 润色' })).toBeDisabled();
    expect(textPanel.getByRole('spinbutton', { name: '采样步数' })).toBeDisabled();
    fireEvent.change(textPanel.getByLabelText('原始文字'), {
      target: { value: 'busy 时仍能编辑文字草稿' },
    });
    expect(textPanel.getByLabelText('原始文字')).toHaveValue('busy 时仍能编辑文字草稿');

    fireEvent.click(screen.getByRole('tab', { name: '音频数字人' }));
    const audioPanel = within(panelFor('audio'));
    expect(audioPanel.getByRole('button', { name: '生成视频' })).toBeDisabled();
    expect(audioPanel.getByRole('button', { name: 'AI 润色' })).toBeDisabled();
    expect(audioPanel.getByRole('button', { name: '选择音频' })).toBeDisabled();
    expect(audioPanel.getByRole('spinbutton', { name: '采样步数' })).toBeDisabled();
    fireEvent.change(audioPanel.getByLabelText('动作/画面提示词'), {
      target: { value: 'busy 时仍能编辑音频草稿' },
    });
    expect(audioPanel.getByLabelText('动作/画面提示词')).toHaveValue(
      'busy 时仍能编辑音频草稿',
    );
  });
});

describe('generation options and hardware apply', () => {
  function textPanel(): HTMLElement {
    return screen.getByRole('tabpanel', { name: '文字生视频' });
  }

  test('defaults to general video writing while keeping auto selection available', async () => {
    await renderStudio();
    const panel = within(textPanel());
    const select = panel.getByLabelText('视频风格（Skill）');

    const options = within(select).getAllByRole('option');
    expect(options[0]).toHaveValue('auto');
    expect(options[0]).toHaveTextContent('自动选择（推荐）');
    for (const option of options.slice(1)) {
      expect(option.textContent).not.toMatch(/[a-z]+-[a-z]+/);
    }
    expect(options).toHaveLength(SKILL_NAMES.length + 1);

    expect(select).toHaveValue('h3-prompt-writing');
    expect(
      panel.getByText(SKILL_OPTIONS['h3-prompt-writing'].description),
    ).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'auto' } });
    expect(select).toHaveValue('auto');
    expect(panel.getByText(AUTO_SKILL_OPTION.description)).toBeInTheDocument();
  });

  test('renders H3 model, aspect ratio, and resolution controls without subtitles', async () => {
    await renderStudio();
    const panel = within(textPanel());

    expect(panel.getByLabelText('H3 模型')).toHaveValue('int8');
    expect(panel.getByText('BF16 大显存候选，未实测')).toBeInTheDocument();
    expect(panel.getByLabelText('视频比例')).toHaveValue('16:9 (Widescreen)');
    const resolution = panel.getByLabelText('分辨率');
    expect(resolution).toHaveValue('0.7');
    expect(
      within(resolution).getByRole('option', { name: '1152 × 640 px' }),
    ).toBeInTheDocument();
    expect(panel.queryByText(/0\.\dMP/)).not.toBeInTheDocument();
    expect(panel.queryByLabelText('生成画面内字幕')).not.toBeInTheDocument();
    expect(panel.queryByText('在画面安全区内显示字幕')).not.toBeInTheDocument();
  });

  test('updates the resolution pixel labels when the aspect ratio changes', async () => {
    await renderStudio();
    const panel = within(textPanel());
    const resolution = panel.getByLabelText('分辨率');

    expect(
      within(resolution).getByRole('option', { name: '1152 × 640 px' }),
    ).toBeInTheDocument();

    fireEvent.change(panel.getByLabelText('视频比例'), {
      target: { value: '9:16 (Portrait Widescreen)' },
    });

    expect(
      within(resolution).getByRole('option', { name: '640 × 1152 px' }),
    ).toBeInTheDocument();
    expect(
      within(resolution).queryByRole('option', { name: '1152 × 640 px' }),
    ).not.toBeInTheDocument();
  });

  test('applies the default INT8 profile before starting the text job', async () => {
    await renderStudio();
    const panel = within(textPanel());
    fireEvent.change(panel.getByLabelText('原始文字'), {
      target: { value: '默认选项直接生成' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalled());
    expect(smo.hardware.apply).toHaveBeenCalledTimes(1);
    expect(smo.hardware.apply).toHaveBeenCalledWith({
      mode: 'text',
      profile: {
        preset: 'balanced-16gb',
        modelPolicy: 'int8',
        megapixels: 0.7,
        aspectRatio: '16:9 (Widescreen)',
        lowvram: true,
        tiling: 'auto',
        requiresConfirmation: true,
      },
      confirmed: true,
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
    });
    const [applyOrder] = smo.hardware.apply.mock.invocationCallOrder;
    const [startOrder] = smo.jobs.start.mock.invocationCallOrder;
    expect(applyOrder).toBeLessThan(startOrder);
    expect(smo.jobs.start).toHaveBeenCalledWith({
      mode: 'text',
      avatarId: avatar.id,
      prompt: '默认选项直接生成',
      duration: 8,
      seed: 42,
      steps: 8,
    });
  });

  test('maps BF16, aspect ratio, and resolution choices onto the hardware profile', async () => {
    await renderStudio();
    const panel = within(textPanel());
    fireEvent.change(panel.getByLabelText('原始文字'), {
      target: { value: '调整选项后再生成' },
    });
    fireEvent.change(panel.getByLabelText('H3 模型'), { target: { value: 'bf16' } });
    fireEvent.change(panel.getByLabelText('视频比例'), {
      target: { value: '9:16 (Portrait Widescreen)' },
    });
    fireEvent.change(panel.getByLabelText('分辨率'), { target: { value: '1' } });

    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalled());
    expect(smo.hardware.apply).toHaveBeenCalledWith({
      mode: 'text',
      profile: {
        preset: 'high-memory-candidate',
        modelPolicy: 'bf16-if-present',
        megapixels: 1,
        aspectRatio: '9:16 (Portrait Widescreen)',
        lowvram: false,
        tiling: 'auto',
        requiresConfirmation: true,
      },
      confirmed: true,
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
    });
  });

  test('shows the apply error and skips jobs.start when hardware apply fails', async () => {
    smo.hardware.apply.mockRejectedValue(new Error('模型目录不存在'));
    await renderStudio();
    const panel = within(textPanel());
    fireEvent.change(panel.getByLabelText('原始文字'), {
      target: { value: '应用失败的场景' },
    });

    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型目录不存在');
    expect(smo.jobs.start).not.toHaveBeenCalled();
  });

  test('shares the settings model directory with studio generation', async () => {
    await renderStudio();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(await screen.findByRole('button', { name: '检测硬件' }));
    expect(await screen.findByText('NVIDIA GeForce RTX 5080')).toBeInTheDocument();
    expect(await screen.findByText('均衡模式')).toBeInTheDocument();
    const directoryInput = await screen.findByLabelText('模型目录');
    fireEvent.change(directoryInput, { target: { value: 'D:\\自定义模型目录' } });

    fireEvent.click(studioModeButton('视频'));
    const panel = within(screen.getByRole('tabpanel', { name: '文字生视频' }));
    fireEvent.change(panel.getByLabelText('原始文字'), {
      target: { value: '共享目录后的生成' },
    });
    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalled());
    expect(smo.hardware.apply).toHaveBeenCalledWith(
      expect.objectContaining({ modelDirectory: 'D:\\自定义模型目录' }),
    );
  });
});

describe('works and settings', () => {
  test('renders speech, image, and video 作品 with accessible media elements', async () => {
    const speechPath = 'G:\\output\\speech.wav';
    const imagePath = 'G:\\output\\image.webp';
    const videoPath = 'G:\\output\\video.mp4';
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'speech-work',
        avatarId: null,
        mode: 'speech',
        status: 'done',
        outputPath: speechPath,
      }),
      createWork({
        id: 'image-work',
        avatarId: null,
        mode: 'image',
        status: 'done',
        outputPath: imagePath,
      }),
      createWork({ id: 'video-work', status: 'done', outputPath: videoPath }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    const audio = await screen.findByLabelText('作品语音 speech-work');
    const image = await screen.findByRole('img', { name: '作品图像 image-work' });
    const video = await screen.findByLabelText('作品视频 video-work');
    expect(audio.tagName).toBe('AUDIO');
    expect(audio).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(speechPath)}`,
    );
    expect(image).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(imagePath)}`,
    );
    expect(video.tagName).toBe('VIDEO');
    expect(video).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(videoPath)}`,
    );
  });

  test('uses speech and image 作品 fallback titles without an unknown avatar', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'speech-work', avatarId: null, mode: 'speech' }),
      createWork({ id: 'image-work', avatarId: null, mode: 'image' }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    expect(await screen.findByRole('heading', { name: '语音作品' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '图像作品' })).toBeInTheDocument();
    expect(screen.queryByText('未知模特')).not.toBeInTheDocument();
  });

  test('lists real works, plays completed output through controlled media, and shows errors', async () => {
    const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
      createWork({
        id: 'failed-work',
        status: 'failed',
        error: 'ComfyUI 执行失败',
      }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    expect(await screen.findByText('已完成（done）')).toBeInTheDocument();
    expect(screen.getByText('失败（failed）')).toBeInTheDocument();
    expect(screen.getByText('ComfyUI 执行失败')).toBeInTheDocument();
    expect(smo.files.mediaUrl).toHaveBeenCalledWith(outputPath);
    expect(await screen.findByLabelText('作品视频 done-work')).toHaveAttribute(
      'src',
      `smo-media://media/${encodeURIComponent(outputPath)}`,
    );
  });

  test('shows real frame progress for a running work', async () => {
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'running-work',
        status: 'running',
        metadata: { progress: { value: 12, max: 24 } },
      }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    const bar = await screen.findByRole('progressbar', { name: '生成进度 running-work' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  test('shows real execution stages, queue position and elapsed time for active works', async () => {
    const now = Date.now();
    const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'queued-work',
        status: 'pending',
        createdAt: iso(now - 65_000),
        metadata: {
          execution: {
            stage: 'backend-queued',
            updatedAt: iso(now),
            lastProgressAt: iso(now),
            queuePosition: 1,
          },
        },
      }),
      createWork({
        id: 'sampling-work',
        status: 'running',
        createdAt: iso(now - 30_000),
        metadata: {
          progress: { value: 12, max: 24 },
          execution: {
            stage: 'sampling',
            updatedAt: iso(now),
            lastProgressAt: iso(now),
          },
        },
      }),
      createWork({
        id: 'finalizing-work',
        status: 'running',
        createdAt: iso(now - 90_000),
        metadata: {
          execution: {
            stage: 'finalizing',
            updatedAt: iso(now),
            lastProgressAt: iso(now),
          },
        },
      }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    expect(await screen.findByText('等待 ComfyUI')).toBeInTheDocument();
    expect(screen.getByText(/前方 1 个任务/)).toBeInTheDocument();
    expect(screen.getByText(/正在采样生成/)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('正在读取输出并收尾')).toBeInTheDocument();
    expect(screen.getAllByText(/已用时间/)).toHaveLength(3);
    const queuedBar = screen.getByRole('progressbar', { name: '生成进度 queued-work' });
    expect(queuedBar).not.toHaveAttribute('aria-valuenow');
    expect(queuedBar).toHaveAttribute('aria-description', expect.stringContaining('等待 ComfyUI'));
  });

  test('warns about long silence and keeps the legacy display for missing execution', async () => {
    const now = Date.now();
    const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'stale-work',
        status: 'running',
        createdAt: iso(now - 20 * 60 * 1000),
        metadata: {
          execution: {
            stage: 'executing',
            updatedAt: iso(now - 16 * 60 * 1000),
            lastProgressAt: iso(now - 16 * 60 * 1000),
          },
        },
      }),
      createWork({
        id: 'legacy-work',
        status: 'running',
        createdAt: iso(now - 5_000),
      }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    expect(await screen.findByText('正在加载模型并执行节点')).toBeInTheDocument();
    expect(screen.getByText(/长时间没有新进展，可继续等待或取消/)).toBeInTheDocument();
    expect(screen.getByText('正在生成…')).toBeInTheDocument();
  });

  test('shows real ComfyUI health and the configured LLM without exposing credentials', async () => {
    smo.comfy.health.mockResolvedValue({
      system: { os: 'Windows 11' },
      devices: [{ name: 'NVIDIA GeForce RTX 5090 Laptop GPU with a long model name' }],
    });
    smo.llm.getProfile.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local/h3-prompt-model-with-a-long-name',
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByText('ComfyUI 连接正常')).toBeInTheDocument();
    expect(screen.getByText('Windows 11')).toBeInTheDocument();
    expect(screen.getByText('已配置 LLM')).toBeInTheDocument();
    expect(
      screen.getByDisplayValue('local/h3-prompt-model-with-a-long-name'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('http://127.0.0.1:11434/v1')).toBeInTheDocument();
  });

  test('shows understandable health errors and an unconfigured LLM state', async () => {
    smo.comfy.health.mockRejectedValue(new Error('连接被拒绝'));
    smo.llm.getProfile.mockResolvedValue(null);
    smo.llm.saveProfile.mockResolvedValue(undefined);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(await screen.findByText('ComfyUI 不可用')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('连接被拒绝');
    expect(screen.getByText('未配置 LLM')).toBeInTheDocument();
  });
});

describe('settings page app version', () => {
  test('shows the Electron package version in the settings footer', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(
      await screen.findByText('SMO.H3 Studio · 版本 0.3.15-test'),
    ).toBeInTheDocument();
  });

  test('shows an unknown version without disabling the rest of settings', async () => {
    smo.app.getVersion.mockRejectedValue(new Error('version unavailable'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));

    expect(
      await screen.findByText('SMO.H3 Studio · 版本未知'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新检测' })).toBeEnabled();
  });
});

describe('settings page ComfyUI startup', () => {
  async function renderOfflineSettings() {
    smo.comfy.health.mockRejectedValueOnce(new Error('连接被拒绝'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    return screen.findByRole('button', { name: '启动 ComfyUI' });
  }

  test('offers to start ComfyUI when the health check fails', async () => {
    await renderOfflineSettings();

    expect(screen.getByText('ComfyUI 不可用')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('连接被拒绝');
    expect(screen.queryByRole('button', { name: '打开 ComfyUI' })).not.toBeInTheDocument();
  });

  test('starts ComfyUI and shows the healthy state with fresh stats', async () => {
    smo.comfy.start.mockResolvedValue({
      system: { os: 'Windows 11' },
      devices: [{ name: 'NVIDIA GeForce RTX 5090 Laptop GPU' }],
    });
    const startButton = await renderOfflineSettings();

    fireEvent.click(startButton);

    const startingButton = screen.getByRole('button', { name: '正在启动…' });
    expect(startingButton).toBeDisabled();
    expect(await screen.findByText('ComfyUI 连接正常')).toBeInTheDocument();
    expect(screen.getByText('Windows 11')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA GeForce RTX 5090 Laptop GPU')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开 ComfyUI' })).toBeInTheDocument();
    expect(smo.comfy.start).toHaveBeenCalledTimes(1);
  });

  test('shows the startup error and stays offline when ComfyUI fails to start', async () => {
    smo.comfy.start.mockRejectedValue(new Error('ComfyUI 启动超时'));
    await renderOfflineSettings();

    fireEvent.click(screen.getByRole('button', { name: '启动 ComfyUI' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('ComfyUI 启动超时');
    expect(screen.getByText('ComfyUI 不可用')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '启动 ComfyUI' })).toBeEnabled();
  });

  test('does not start ComfyUI twice while startup is in flight', async () => {
    let resolveStart:
      | ((value: { system: Record<string, unknown>; devices: Record<string, unknown>[] }) => void)
      | undefined;
    smo.comfy.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
    );
    await renderOfflineSettings();

    fireEvent.click(screen.getByRole('button', { name: '启动 ComfyUI' }));
    fireEvent.click(screen.getByRole('button', { name: '正在启动…' }));

    expect(smo.comfy.start).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveStart?.({ system: {}, devices: [] });
    });
    expect(screen.getByText('ComfyUI 连接正常')).toBeInTheDocument();
  });
});

describe('settings page LLM configuration', () => {
  test('saves the LLM profile and refreshes displayed values', async () => {
    smo.llm.getProfile.mockResolvedValue(null);
    smo.llm.saveProfile.mockResolvedValue(undefined);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByText('未配置 LLM');

    fireEvent.change(screen.getByLabelText('服务地址'), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4o' } });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    await waitFor(() =>
      expect(smo.llm.saveProfile).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-new',
      }),
    );
  });

  test('fetches and selects a model from the service', async () => {
    smo.llm.getProfile.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });
    smo.llm.listModels.mockResolvedValue(['gpt-4o', 'gpt-4o-mini']);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByDisplayValue('gpt-4o');

    fireEvent.click(screen.getByRole('button', { name: '获取模型' }));
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'gpt-4o-mini' }));

    expect(screen.getByDisplayValue('gpt-4o-mini')).toBeInTheDocument();
    expect(smo.llm.listModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      apiKey: '',
    });
  });

  test('enables model discovery before a model is chosen', async () => {
    smo.llm.getProfile.mockResolvedValue(null);
    smo.llm.listModels.mockResolvedValue(['model-a', 'model-b']);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByText('未配置 LLM');

    expect(screen.getByRole('button', { name: '获取模型' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '测试模型' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('服务地址'), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-live' } });

    expect(screen.getByRole('button', { name: '获取模型' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '测试模型' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '获取模型' }));

    expect(await screen.findByRole('listbox')).toBeInTheDocument();
    expect(smo.llm.listModels).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-live',
    });

    fireEvent.click(screen.getByRole('button', { name: 'model-b' }));
    expect(screen.getByDisplayValue('model-b')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '测试模型' })).toBeEnabled();
  });

  test('tests the model and shows latency plus summary', async () => {
    smo.llm.getProfile.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });
    smo.llm.testModel.mockResolvedValue({ ok: true, latencyMs: 120, summary: 'OK' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByDisplayValue('gpt-4o');

    fireEvent.click(screen.getByRole('button', { name: '测试模型' }));

    expect(await screen.findByText(/测试通过/)).toHaveTextContent('120');
    expect(smo.llm.testModel).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      apiKey: '',
    });
  });

  test('shows an LLM save error without exposing the key', async () => {
    smo.llm.getProfile.mockResolvedValue(null);
    smo.llm.saveProfile.mockRejectedValue(new Error('首次配置必须提供 API key'));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByText('未配置 LLM');

    fireEvent.change(screen.getByLabelText('服务地址'), {
      target: { value: 'https://api.example.com/v1' },
    });
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4o' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('首次配置必须提供 API key');
  });

  test('requires re-entering the API key when the saved one cannot be decrypted', async () => {
    smo.llm.getProfile.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      keyStatus: 'reenter-required',
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByDisplayValue('gpt-4o');

    expect(screen.getByText(/需要重新输入密钥/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存设置' })).toBeDisabled();
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-fresh' } });
    expect(screen.getByRole('button', { name: '保存设置' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() =>
      expect(smo.llm.saveProfile).toHaveBeenCalledWith({
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-fresh',
      }),
    );
    expect(screen.queryByText(/需要重新输入密钥/)).not.toBeInTheDocument();
    expect(await screen.findByText('已保存')).toBeInTheDocument();
  });

  test('shows the saved state and flags unsaved modifications', async () => {
    smo.llm.getProfile.mockResolvedValue({
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
      keyStatus: 'valid',
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '设置' }));
    await screen.findByDisplayValue('gpt-4o');

    expect(screen.getByText('已保存')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4o-mini' } });
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();
    expect(screen.getByText('有未保存修改')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'gpt-4o' } });
    expect(screen.queryByText('有未保存修改')).not.toBeInTheDocument();
    expect(screen.getByText('已保存')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('API 密钥'), { target: { value: 'sk-rotated' } });
    expect(screen.getByText('有未保存修改')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    await waitFor(() => expect(smo.llm.saveProfile).toHaveBeenCalled());
    expect(await screen.findByText('已保存')).toBeInTheDocument();
    expect(screen.queryByText('有未保存修改')).not.toBeInTheDocument();
  });
});

describe('works page actions', () => {
  test('导入数字模特只出现在已完成的图像作品，并使用作品标题创建和选中', async () => {
    const outputPath = 'G:\\SMO-H3-Data\\output\\SMO-Image\\poster.png';
    const imported: Avatar = {
      ...avatar,
      id: 'avatar-imported',
      name: '产品海报',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\imported.png',
    };
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'image-done',
        avatarId: null,
        mode: 'image',
        status: 'done',
        outputPath,
        title: '产品海报',
      }),
      createWork({ id: 'image-running', avatarId: null, mode: 'image', status: 'running' }),
      createWork({
        id: 'image-failed',
        avatarId: null,
        mode: 'image',
        status: 'failed',
        outputPath,
      }),
      createWork({ id: 'text-done', mode: 'text', status: 'done', outputPath: 'G:\\video.mp4' }),
    ]);
    smo.avatars.list.mockResolvedValueOnce([avatar]).mockResolvedValueOnce([avatar, imported]);
    smo.avatars.create.mockResolvedValue(imported);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));

    const doneCard = (await screen.findByText('image-done')).closest('article') as HTMLElement;
    expect(within(doneCard).getByRole('button', { name: '导入数字模特' })).toBeInTheDocument();
    for (const id of ['image-running', 'image-failed', 'text-done']) {
      const card = screen.getByText(id).closest('article') as HTMLElement;
      expect(within(card).queryByRole('button', { name: '导入数字模特' })).not.toBeInTheDocument();
    }

    fireEvent.click(within(doneCard).getByRole('button', { name: '导入数字模特' }));

    expect(smo.avatars.create).toHaveBeenCalledWith({ name: '产品海报', photoPath: outputPath });
    expect(await screen.findByRole('heading', { name: '数字模特' })).toBeInTheDocument();
    const avatarList = screen.getByRole('region', { name: '模特列表' });
    const importedCard = within(avatarList).getByRole('heading', { name: '产品海报' }).closest('article') as HTMLElement;
    expect(within(importedCard).getByRole('button', { name: '当前模特' })).toBeDisabled();
  });

  test('导入无标题图像作品时使用短 ID 命名', async () => {
    const id = '12345678-abcd-4000-8000-123456789abc';
    const outputPath = 'G:\\SMO-H3-Data\\output\\SMO-Image\\untitled.png';
    const imported: Avatar = {
      ...avatar,
      id: 'avatar-untitled',
      name: '12345678',
      photoPath: 'G:\\SMO-H3-Data\\avatars\\untitled.png',
    };
    smo.works.list.mockResolvedValue([
      createWork({ id, avatarId: null, mode: 'image', status: 'done', outputPath, title: null }),
    ]);
    smo.avatars.list.mockResolvedValueOnce([avatar]).mockResolvedValueOnce([avatar, imported]);
    smo.avatars.create.mockResolvedValue(imported);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    const card = (await screen.findByText(id)).closest('article') as HTMLElement;

    fireEvent.click(within(card).getByRole('button', { name: '导入数字模特' }));

    expect(smo.avatars.create).toHaveBeenCalledWith({ name: '12345678', photoPath: outputPath });
    expect(await screen.findByRole('heading', { name: '12345678' })).toBeInTheDocument();
  });

  test('筛选按作品类型、视频子类型和状态组合，并同步 aria-pressed', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'text-done', mode: 'text', status: 'done' }),
      createWork({ id: 'audio-failed', mode: 'audio', status: 'failed' }),
      createWork({ id: 'speech-running', avatarId: null, mode: 'speech', status: 'running' }),
      createWork({ id: 'image-done', avatarId: null, mode: 'image', status: 'done' }),
      createWork({ id: 'text-pending', mode: 'text', status: 'pending' }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('text-done');

    const workTypeFilters = screen.getByRole('group', { name: '作品类型' });
    const statusFilters = screen.getByRole('group', { name: '作品状态' });
    expect(within(workTypeFilters).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '全部',
      '语音',
      '图像',
      '视频',
    ]);
    expect(within(statusFilters).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '全部状态',
      '运行中',
      '已完成',
      '失败',
    ]);
    expect(screen.queryByRole('group', { name: '视频类型' })).not.toBeInTheDocument();
    expect(within(statusFilters).queryByRole('button', { name: '等待中' })).not.toBeInTheDocument();

    const expectPressedFilter = (group: HTMLElement, label: string) => {
      for (const button of within(group).getAllByRole('button')) {
        expect(button).toHaveAttribute(
          'aria-pressed',
          button.textContent === label ? 'true' : 'false',
        );
      }
    };
    expectPressedFilter(workTypeFilters, '全部');
    expectPressedFilter(statusFilters, '全部状态');

    const expectWorkIds = (ids: string[]) => {
      const actual = screen.queryAllByRole('article').map(
        (card) => card.querySelector('.work-id')?.textContent,
      );
      expect(actual.sort()).toEqual([...ids].sort());
    };
    expectWorkIds(['text-done', 'audio-failed', 'speech-running', 'image-done', 'text-pending']);

    fireEvent.click(within(workTypeFilters).getByRole('button', { name: '视频' }));
    const videoTypeFilters = screen.getByRole('group', { name: '视频类型' });
    expect(within(videoTypeFilters).getAllByRole('button').map((button) => button.textContent)).toEqual([
      '全部视频',
      '文字生视频',
      '音频数字人',
    ]);
    expectPressedFilter(workTypeFilters, '视频');
    expectPressedFilter(videoTypeFilters, '全部视频');
    expectWorkIds(['text-done', 'audio-failed', 'text-pending']);

    fireEvent.click(within(videoTypeFilters).getByRole('button', { name: '文字生视频' }));
    expectPressedFilter(videoTypeFilters, '文字生视频');
    expectWorkIds(['text-done', 'text-pending']);

    fireEvent.click(within(statusFilters).getByRole('button', { name: '已完成' }));
    expectPressedFilter(statusFilters, '已完成');
    expectWorkIds(['text-done']);

    fireEvent.click(within(statusFilters).getByRole('button', { name: '失败' }));
    expectWorkIds([]);

    fireEvent.click(within(videoTypeFilters).getByRole('button', { name: '音频数字人' }));
    expectPressedFilter(videoTypeFilters, '音频数字人');
    expectWorkIds(['audio-failed']);

    fireEvent.click(within(workTypeFilters).getByRole('button', { name: '语音' }));
    expectPressedFilter(workTypeFilters, '语音');
    expect(screen.queryByRole('group', { name: '视频类型' })).not.toBeInTheDocument();
    expectWorkIds([]);

    fireEvent.click(within(statusFilters).getByRole('button', { name: '运行中' }));
    expectPressedFilter(statusFilters, '运行中');
    expectWorkIds(['speech-running']);

    fireEvent.click(within(workTypeFilters).getByRole('button', { name: '图像' }));
    expectWorkIds([]);
    fireEvent.click(within(statusFilters).getByRole('button', { name: '已完成' }));
    expectWorkIds(['image-done']);

    fireEvent.click(within(workTypeFilters).getByRole('button', { name: '全部' }));
    expectWorkIds(['text-done', 'image-done']);
    fireEvent.click(within(statusFilters).getByRole('button', { name: '全部状态' }));
    expectPressedFilter(workTypeFilters, '全部');
    expectPressedFilter(statusFilters, '全部状态');
    expectWorkIds(['text-done', 'audio-failed', 'speech-running', 'image-done', 'text-pending']);
  });

  test('retries a failed work and refreshes the list', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'failed-work', status: 'failed', error: 'ComfyUI 执行失败' }),
    ]);
    smo.jobs.retry.mockResolvedValue({ id: 'retry-work' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('失败（failed）');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() => expect(smo.jobs.retry).toHaveBeenCalledWith('failed-work'));
  });

  test('opens the output directory for a completed work', async () => {
    const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';
    smo.works.list.mockResolvedValue([createWork({ id: 'done-work', status: 'done', outputPath })]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('已完成（done）');
    fireEvent.click(screen.getByRole('button', { name: '打开目录' }));

    await waitFor(() =>
      expect(smo.files.openFolder).toHaveBeenCalledWith(
        'G:\\H3Selflift整合包\\ComfyUI\\output',
      ),
    );
  });

  test('opens ComfyUI from the works page', async () => {
    const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';
    smo.works.list.mockResolvedValue([createWork({ id: 'done-work', status: 'done', outputPath })]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('已完成（done）');
    fireEvent.click(screen.getByRole('button', { name: '打开 ComfyUI' }));

    expect(smo.comfy.open).toHaveBeenCalled();
  });

  test('does not refresh or update state after unmounting during a retry', async () => {
    let resolveRetry: ((value: { id: string }) => void) | undefined;
    smo.jobs.retry.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    smo.works.list.mockResolvedValue([
      createWork({ id: 'failed-work', status: 'failed', error: 'ComfyUI 执行失败' }),
    ]);
    const view = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('失败（failed）');
    const listCallsBeforeRetry = smo.works.list.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(smo.jobs.retry).toHaveBeenCalledWith('failed-work'));
    view.unmount();
    await act(async () => {
      resolveRetry?.({ id: 'retry-work' });
    });

    expect(smo.works.list.mock.calls.length).toBe(listCallsBeforeRetry);
  });
});

describe('works deletion', () => {
  const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';

  async function openWorksPage() {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByRole('heading', { name: '我的作品' });
  }

  test('asks for confirmation with model and file names and cancels without deleting', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    await openWorksPage();
    await screen.findByText('已完成（done）');

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));

    const dialog = screen.getByRole('dialog', { name: '删除作品' });
    expect(dialog).toHaveTextContent('薄荷主播');
    expect(dialog).toHaveTextContent('finished.mp4');
    expect(dialog).toHaveTextContent('作品记录和视频文件将一起删除，此操作不可撤销');
    expect(smo.works.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(smo.works.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('已完成（done）')).toBeInTheDocument();
  });

  test('deletes a completed work after confirmation, closes the dialog, and refreshes', async () => {
    smo.works.list
      .mockResolvedValueOnce([createWork({ id: 'done-work', status: 'done', outputPath })])
      .mockResolvedValue([]);
    smo.works.delete.mockResolvedValue(undefined);
    await openWorksPage();
    await screen.findByText('已完成（done）');

    const pageContainer = screen.getByText('已完成（done）').closest('.standard-page');
    expect(pageContainer).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(smo.works.delete).toHaveBeenCalledWith('done-work'));
    expect(await screen.findByText('还没有作品')).toBeInTheDocument();
    expect(screen.queryByText('已完成（done）')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(pageContainer).toHaveFocus();
  });

  test('shows the deletion error, keeps the dialog and work, and allows confirming again', async () => {
    smo.works.list
      .mockResolvedValueOnce([createWork({ id: 'done-work', status: 'done', outputPath })])
      .mockResolvedValue([]);
    smo.works.delete
      .mockRejectedValueOnce(new Error('文件被占用'))
      .mockResolvedValueOnce(undefined);
    await openWorksPage();
    await screen.findByText('已完成（done）');

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('文件被占用');
    expect(screen.getByRole('dialog', { name: '删除作品' })).toBeInTheDocument();
    expect(screen.getByText('已完成（done）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(smo.works.delete).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('还没有作品')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('only offers deletion for finished or failed works and describes failed records', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'pending-work', status: 'pending' }),
      createWork({
        id: 'running-work',
        status: 'running',
        metadata: { progress: { value: 1, max: 10 } },
      }),
      createWork({ id: 'failed-work', status: 'failed', error: 'ComfyUI 执行失败' }),
    ]);
    await openWorksPage();
    await screen.findByText('失败（failed）');

    const pendingCard = screen.getByText('pending-work').closest('article');
    const runningCard = screen.getByText('running-work').closest('article');
    expect(pendingCard).not.toBeNull();
    expect(runningCard).not.toBeNull();
    expect(
      within(pendingCard as HTMLElement).queryByRole('button', { name: /删除/ }),
    ).not.toBeInTheDocument();
    expect(
      within(runningCard as HTMLElement).queryByRole('button', { name: /删除/ }),
    ).not.toBeInTheDocument();

    const failedCard = screen.getByText('failed-work').closest('article') as HTMLElement;
    fireEvent.click(within(failedCard).getByRole('button', { name: '删除作品 failed-work' }));

    const dialog = screen.getByRole('dialog', { name: '删除作品' });
    expect(dialog).toHaveTextContent('这条失败记录将被删除，此操作不可撤销');
    expect(dialog).not.toHaveTextContent('视频文件');

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(smo.works.delete).not.toHaveBeenCalled();
  });

  test('describes a finished work without an output file as a neutral record', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-no-file', status: 'done', outputPath: null }),
    ]);
    await openWorksPage();
    await screen.findByText('已完成（done）');

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-no-file' }));

    const dialog = screen.getByRole('dialog', { name: '删除作品' });
    expect(dialog).toHaveTextContent('这条作品记录将被删除，此操作不可撤销');
    expect(dialog).not.toHaveTextContent('失败记录');
    expect(dialog).not.toHaveTextContent('视频文件');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
  });

  test('disables the confirmation button while deleting', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    let resolveDelete: (() => void) | undefined;
    smo.works.delete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    await openWorksPage();
    await screen.findByText('已完成（done）');

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled();
    const cancelButton = screen.getByRole('button', { name: '取消' });
    expect(cancelButton).toBeDisabled();
    fireEvent.click(cancelButton);
    fireEvent.keyDown(screen.getByRole('dialog', { name: '删除作品' }), { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '删除作品' })).toBeInTheDocument();
    expect(smo.works.delete).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDelete?.();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('focuses cancel on open, traps Tab inside the dialog, and restores focus on close', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    await openWorksPage();
    await screen.findByText('已完成（done）');

    const trigger = screen.getByRole('button', { name: '删除作品 done-work' });
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '删除作品' });
    const cancelButton = screen.getByRole('button', { name: '取消' });
    const confirmButton = screen.getByRole('button', { name: '确认删除' });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(cancelButton).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(smo.works.delete).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  test('prevents Tab when every dialog button is disabled during deletion', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    let resolveDelete: (() => void) | undefined;
    smo.works.delete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    await openWorksPage();
    await screen.findByText('已完成（done）');

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    const dialog = screen.getByRole('dialog', { name: '删除作品' });
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false);
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);

    await act(async () => {
      resolveDelete?.();
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('does not refresh or update state after unmounting during a deletion', async () => {
    let resolveDelete: (() => void) | undefined;
    smo.works.delete.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve;
        }),
    );
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    const view = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('已完成（done）');
    const listCallsBeforeDelete = smo.works.list.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: '删除作品 done-work' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(smo.works.delete).toHaveBeenCalledWith('done-work'));
    view.unmount();
    await act(async () => {
      resolveDelete?.();
    });

    expect(smo.works.list.mock.calls.length).toBe(listCallsBeforeDelete);
  });
});

describe('works title and completion time', () => {
  const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';

  async function openWorksPage() {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByRole('heading', { name: '我的作品' });
  }

  test('shows the custom title and falls back to the avatar name without one', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'titled-work', status: 'done', outputPath, title: '新品发布会' }),
      createWork({ id: 'untitled-work', status: 'done', outputPath, title: null }),
    ]);

    await openWorksPage();

    expect(await screen.findByRole('heading', { name: '新品发布会' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '薄荷主播' })).toBeInTheDocument();
  });

  test('shows the completion time and elapsed duration for a done work', async () => {
    const completedAt = '2026-10-26T08:03:05.000Z';
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'done-work',
        status: 'done',
        outputPath,
        createdAt: '2026-10-26T08:00:00.000Z',
        completedAt,
      }),
    ]);

    await openWorksPage();

    const header = await screen.findByText(/耗时/);
    expect(header).toHaveTextContent(
      `完成于 ${new Date(completedAt).toLocaleString('zh-CN')}`,
    );
    expect(header).toHaveTextContent('耗时 3 分 5 秒');
  });

  test('shows a seconds-only duration for quick generations', async () => {
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'done-work',
        status: 'done',
        outputPath,
        createdAt: '2026-10-26T08:00:00.000Z',
        completedAt: '2026-10-26T08:00:30.000Z',
      }),
    ]);

    await openWorksPage();

    expect(await screen.findByText(/耗时 30 秒/)).toBeInTheDocument();
  });

  test('falls back to the last execution update for legacy done works', async () => {
    const updatedAt = '2026-10-26T08:00:45.000Z';
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'legacy-done',
        status: 'done',
        outputPath,
        createdAt: '2026-10-26T08:00:00.000Z',
        completedAt: null,
        metadata: {
          execution: { stage: 'finalizing', updatedAt, lastProgressAt: updatedAt },
        },
      }),
    ]);

    await openWorksPage();

    const header = await screen.findByText(/耗时/);
    expect(header).toHaveTextContent(
      `完成于 ${new Date(updatedAt).toLocaleString('zh-CN')}`,
    );
    expect(header).toHaveTextContent('耗时 45 秒');
  });

  test('hides the completion time for legacy works without any timestamp', async () => {
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'timeless-done',
        status: 'done',
        outputPath,
        completedAt: null,
        metadata: null,
      }),
    ]);

    await openWorksPage();
    await screen.findByText('已完成（done）');

    expect(screen.queryByText(/完成于/)).not.toBeInTheDocument();
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument();
  });

  test('never shows a completion duration for failed works', async () => {
    const updatedAt = '2026-10-26T08:00:45.000Z';
    smo.works.list.mockResolvedValue([
      createWork({
        id: 'failed-work',
        status: 'failed',
        error: 'ComfyUI offline',
        completedAt: null,
        metadata: {
          execution: { stage: 'executing', updatedAt, lastProgressAt: updatedAt },
        },
      }),
    ]);

    await openWorksPage();
    await screen.findByText('ComfyUI offline');

    expect(screen.queryByText(/完成于/)).not.toBeInTheDocument();
    expect(screen.queryByText(/耗时/)).not.toBeInTheDocument();
  });
});

describe('works rename', () => {
  const outputPath = 'G:\\H3Selflift整合包\\ComfyUI\\output\\finished.mp4';

  async function openWorksPage() {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByRole('heading', { name: '我的作品' });
  }

  test('renames a work through the modal and refreshes the list', async () => {
    smo.works.list
      .mockResolvedValueOnce([
        createWork({ id: 'done-work', status: 'done', outputPath }),
      ])
      .mockResolvedValue([
        createWork({ id: 'done-work', status: 'done', outputPath, title: '新品发布会' }),
      ]);
    smo.works.rename.mockResolvedValue(
      createWork({ id: 'done-work', status: 'done', outputPath, title: '新品发布会' }),
    );

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));

    const dialog = screen.getByRole('dialog', { name: '重命名作品' });
    const input = within(dialog).getByLabelText('作品标题');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: '  新品发布会  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存标题' }));

    await waitFor(() =>
      expect(smo.works.rename).toHaveBeenCalledWith({
        id: 'done-work',
        title: '  新品发布会  ',
      }),
    );
    expect(await screen.findByRole('heading', { name: '新品发布会' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('prefills the current title in the rename modal', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath, title: '旧标题' }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '旧标题' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));

    expect(screen.getByLabelText('作品标题')).toHaveValue('旧标题');
  });

  test('rejects an empty title locally without calling the API', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));
    const dialog = screen.getByRole('dialog', { name: '重命名作品' });
    fireEvent.change(within(dialog).getByLabelText('作品标题'), {
      target: { value: '   ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存标题' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/不能为空/);
    expect(smo.works.rename).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '重命名作品' })).toBeInTheDocument();
  });

  test('shows the rename error and keeps the modal open', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);
    smo.works.rename.mockRejectedValue(new Error('数据库繁忙'));

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));
    const dialog = screen.getByRole('dialog', { name: '重命名作品' });
    fireEvent.change(within(dialog).getByLabelText('作品标题'), {
      target: { value: '新标题' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存标题' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('数据库繁忙');
    expect(screen.getByRole('dialog', { name: '重命名作品' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '薄荷主播' })).toBeInTheDocument();
  });

  test('closes the rename modal without saving on cancel', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    const trigger = screen.getByRole('button', { name: '重命名作品 done-work' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(smo.works.rename).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  test('focuses the title input on open and wraps Tab between input and buttons', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));

    const dialog = screen.getByRole('dialog', { name: '重命名作品' });
    const input = within(dialog).getByLabelText('作品标题');
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const save = within(dialog).getByRole('button', { name: '保存标题' });
    expect(input).toHaveFocus();

    // Shift+Tab on the first control wraps to the last button.
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(save).toHaveFocus();
    // Tab on the last button wraps back to the input.
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false);
    expect(input).toHaveFocus();
    // Tab in the middle of the order is left to the browser default.
    cancel.focus();
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(true);
  });

  test('closes the rename modal with Escape when idle and restores focus', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    const trigger = screen.getByRole('button', { name: '重命名作品 done-work' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '重命名作品' });

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(smo.works.rename).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  test('blocks Tab and Escape while a rename is saving', async () => {
    let resolveRename: ((work: Work) => void) | undefined;
    smo.works.rename.mockImplementation(
      () =>
        new Promise<Work>((resolve) => {
          resolveRename = resolve;
        }),
    );
    smo.works.list.mockResolvedValue([
      createWork({ id: 'done-work', status: 'done', outputPath }),
    ]);

    await openWorksPage();
    await screen.findByRole('heading', { name: '薄荷主播' });

    fireEvent.click(screen.getByRole('button', { name: '重命名作品 done-work' }));
    const dialog = screen.getByRole('dialog', { name: '重命名作品' });
    const input = within(dialog).getByLabelText('作品标题');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存标题' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: '正在保存…' })).toBeDisabled(),
    );
    expect(input).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();

    // Every control is disabled, so Tab must not escape into the background.
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false);
    expect(fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })).toBe(false);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '重命名作品' })).toBeInTheDocument();

    await act(async () => {
      resolveRename?.(createWork({ id: 'done-work', status: 'done', outputPath, title: '新标题' }));
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
