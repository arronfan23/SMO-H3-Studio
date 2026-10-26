import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type { SmoApi } from '../../src/shared/ipc';
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
    comfy: { health: vi.fn(), open: vi.fn() },
    hardware: { detect: vi.fn(), apply: vi.fn() },
    works: { list: vi.fn() },
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
    fireEvent.change(screen.getByLabelText('Skill'), {
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

    expect(smo.jobs.start).toHaveBeenCalledWith({
      mode: 'text',
      avatarId: avatar.id,
      prompt: '用户最终确认的镜头文本',
      duration: 9,
      seed: 42,
    });
    expect(await screen.findByText('job-1')).toBeInTheDocument();
    expect(screen.getByText('等待中（pending）')).toBeInTheDocument();
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
    expect(smo.jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '保留这段原文', mode: 'text' }),
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
    expect(smo.jobs.start).toHaveBeenCalledWith({
      mode: 'audio',
      avatarId: avatar.id,
      prompt: '自然说话，轻微点头',
      audioPath,
      trimStart: 1.25,
      duration: 6,
      seed: 7,
    });
    expect(await screen.findByText('运行中（running）')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消当前任务' }));
    expect(smo.jobs.cancel).toHaveBeenCalledWith('audio-job');
    expect(smo.jobs.cancel).not.toHaveBeenCalledWith();
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

    await waitFor(() => expect(smo.files.openFolder).toHaveBeenCalledWith(outputPath));
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
});
