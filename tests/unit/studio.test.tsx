import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { SKILL_NAMES } from '../../src/shared/skills';
import {
  AUTO_SKILL_OPTION,
  SKILL_OPTIONS,
} from '../../src/renderer/skill-options';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';
import type { PolishResult, SmoApi } from '../../src/shared/ipc';
import type { Avatar, Work } from '../../src/shared/types';

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
    promptId: null,
    metadata: null,
    error: null,
    ...overrides,
  };
}

function createSmoMock() {
  return {
    avatars: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    jobs: { start: vi.fn(), retry: vi.fn(), cancel: vi.fn() },
    files: {
      selectImage: vi.fn(),
      selectAudio: vi.fn(),
      mediaUrl: vi.fn(),
      openFolder: vi.fn(),
    },
    llm: {
      saveProfile: vi.fn(),
      getProfile: vi.fn(),
      listModels: vi.fn(),
      testModel: vi.fn(),
      polish: vi.fn(),
    },
    comfy: { health: vi.fn(), open: vi.fn(), start: vi.fn() },
    hardware: { detect: vi.fn(), recommend: vi.fn(), apply: vi.fn() },
    works: { list: vi.fn(), delete: vi.fn() },
  };
}

const smo = createSmoMock();

async function renderStudio() {
  render(<App />);
  await screen.findByRole('heading', { name: avatar.name });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  smo.avatars.list.mockResolvedValue([avatar]);
  smo.avatars.create.mockRejectedValue(new Error('Unexpected avatar creation'));
  smo.avatars.update.mockRejectedValue(new Error('Unexpected avatar rename'));
  smo.avatars.delete.mockRejectedValue(new Error('Unexpected avatar deletion'));
  smo.files.selectImage.mockResolvedValue(null);
  smo.files.selectAudio.mockResolvedValue(null);
  smo.files.mediaUrl.mockImplementation(async (path: string) =>
    `smo-media://media/${encodeURIComponent(path)}`,
  );
  smo.works.list.mockResolvedValue([]);
  smo.jobs.start.mockResolvedValue({ id: 'job-1' });
  smo.jobs.retry.mockRejectedValue(new Error('Unexpected retry'));
  smo.jobs.cancel.mockResolvedValue(undefined);
  smo.llm.getProfile.mockResolvedValue(null);
  smo.llm.saveProfile.mockResolvedValue(undefined);
  smo.llm.polish.mockRejectedValue(new Error('Unexpected polish'));
  smo.comfy.health.mockResolvedValue({ system: {}, devices: [] });
  smo.comfy.start.mockResolvedValue({ system: {}, devices: [] });
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

  test('keeps the unsubmitted text draft when switching modules', async () => {
    await renderStudio();
    fireEvent.change(screen.getByLabelText('原始文字'), {
      target: { value: '切换模块后保留这段草稿' },
    });

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name: moduleName }));
      fireEvent.click(screen.getByRole('button', { name: '制作台' }));
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
    fireEvent.click(screen.getByRole('button', { name: '制作台' }));
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
    fireEvent.change(screen.getByLabelText('视频风格（Skill）'), {
      target: { value: 'h3-prompt-writing' },
    });
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
        subtitles: false,
      }),
    );
    expect(await screen.findByText('job-1')).toBeInTheDocument();
    expect(screen.getByText('等待中（pending）')).toBeInTheDocument();
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

describe('audio digital human studio', () => {
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
        subtitles: false,
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
});

describe('generation options and hardware apply', () => {
  function textPanel(): HTMLElement {
    return screen.getByRole('tabpanel', { name: '文字生视频' });
  }

  test('shows Chinese skill titles without raw English ids and explains the selection', async () => {
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

    expect(panel.getByText(AUTO_SKILL_OPTION.description)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'h3-prompt-writing' } });
    expect(
      panel.getByText(SKILL_OPTIONS['h3-prompt-writing'].description),
    ).toBeInTheDocument();
  });

  test('renders H3 model, aspect ratio, resolution, and subtitle controls with INT8 defaults', async () => {
    await renderStudio();
    const panel = within(textPanel());

    expect(panel.getByLabelText('H3 模型')).toHaveValue('int8');
    expect(panel.getByText('BF16 大显存候选，未实测')).toBeInTheDocument();
    expect(panel.getByLabelText('视频比例')).toHaveValue('16:9 (Widescreen)');
    expect(panel.getByLabelText('分辨率')).toHaveValue('0.7');
    expect(panel.getByLabelText('生成画面内字幕')).not.toBeChecked();
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
    expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '默认选项直接生成', subtitles: false }),
    );
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

  test('sends subtitles: true when the subtitle option is enabled', async () => {
    await renderStudio();
    const panel = within(textPanel());
    fireEvent.change(panel.getByLabelText('原始文字'), {
      target: { value: '需要同步字幕' },
    });
    fireEvent.click(panel.getByLabelText('生成画面内字幕'));
    expect(panel.getByLabelText('生成画面内字幕')).toBeChecked();

    fireEvent.click(panel.getByRole('button', { name: '生成视频' }));

    await waitFor(() => expect(smo.jobs.start).toHaveBeenCalled());
    expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '需要同步字幕', subtitles: true }),
    );
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
    fireEvent.click(await screen.findByRole('button', { name: '获取推荐' }));
    const directoryInput = await screen.findByLabelText('模型目录');
    fireEvent.change(directoryInput, { target: { value: 'D:\\自定义模型目录' } });

    fireEvent.click(screen.getByRole('button', { name: '制作台' }));
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
  test('filters works by mode and status', async () => {
    smo.works.list.mockResolvedValue([
      createWork({ id: 'text-done', mode: 'text', status: 'done' }),
      createWork({ id: 'audio-failed', mode: 'audio', status: 'failed' }),
    ]);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '我的作品' }));
    await screen.findByText('已完成（done）');

    expect(screen.getByText('已完成（done）')).toBeInTheDocument();
    expect(screen.getByText('失败（failed）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '文字生视频' }));
    expect(screen.queryByText('失败（failed）')).not.toBeInTheDocument();
    expect(screen.getByText('已完成（done）')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '失败' }));
    expect(screen.queryByText('已完成（done）')).not.toBeInTheDocument();
    expect(screen.getByText('失败（failed）')).toBeInTheDocument();
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
