import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import type {
  EnvironmentConfig,
  EnvironmentProfile,
  EnvironmentState,
} from '../../src/shared/environment';
import type { SmoApi } from '../../src/shared/ipc';
import type { HardwareInfo } from '../../src/shared/types';

const GIB = 1024 ** 3;
const INSTALL_ROOT = 'D:\\SMO-H3-Test';

const hardware: HardwareInfo = {
  gpu: 'NVIDIA GeForce RTX 5080',
  vramGiB: 16,
  ramGiB: 64,
  windowsVersion: 'Microsoft Windows 11 Pro',
  driverVersion: '576.88',
  cudaComputeCapability: '12.0',
  freeDiskGiB: 512,
};

const readyConfig: EnvironmentConfig = {
  schemaVersion: 1,
  runtimeId: 'sm120',
  runtimeRoot: `${INSTALL_ROOT}\\runtime\\sm120`,
  modelDirectory: `${INSTALL_ROOT}\\models\\diffusion_models`,
  outputDirectory: `${INSTALL_ROOT}\\output`,
  profile: 'balanced-16gb',
  hardwareFingerprint: {
    gpu: hardware.gpu,
    vramGiB: hardware.vramGiB,
    ramGiB: hardware.ramGiB,
    cudaComputeCapability: hardware.cudaComputeCapability,
  },
  manifestVersion: '1',
  status: 'ready',
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
};

function environmentState(overrides: Partial<EnvironmentState> = {}): EnvironmentState {
  return {
    config: null,
    hardware,
    selection: {
      runtime: {
        id: 'sm120',
        displayName: 'SM120（NVIDIA RTX 50 系）',
        archiveParts: [
          {
            url: 'https://example.invalid/runtime.zip',
            path: 'runtime.zip',
            size: GIB,
            sha256: 'a'.repeat(64),
          },
        ],
        archiveSize: GIB,
        archiveSha256: 'b'.repeat(64),
        estimatedExtractedBytes: 2 * GIB,
        pythonPath: 'runtime/python.exe',
        launchScript: 'runtime/launch.py',
        ffprobePath: 'runtime/ffprobe.exe',
      },
      profile: 'balanced-16gb',
      modelFiles: [],
      requiredBytes: 64 * GIB,
    },
    installRoot: INSTALL_ROOT,
    stage: 'select',
    progress: { downloadedBytes: 0, totalBytes: 0 },
    error: null,
    active: false,
    healthy: false,
    ...overrides,
  };
}

function readyState(healthy = true): EnvironmentState {
  return environmentState({
    config: readyConfig,
    hardware: null,
    selection: null,
    stage: 'ready',
    healthy,
  });
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
    environment: {
      getState: vi.fn(),
      detect: vi.fn(),
      start: vi.fn(),
      retry: vi.fn(),
      cancel: vi.fn(),
    },
    hardware: { detect: vi.fn(), recommend: vi.fn(), reset: vi.fn(), apply: vi.fn() },
    works: { list: vi.fn(), delete: vi.fn() },
    window: {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(),
      beginResize: vi.fn(),
      resize: vi.fn(),
      endResize: vi.fn(),
    },
  };
}

const smo = createSmoMock();

async function renderDetectedWizard(
  initial: EnvironmentState = environmentState({ hardware: null, selection: null }),
  detected: EnvironmentState = environmentState(),
): Promise<void> {
  smo.environment.getState.mockResolvedValue(initial);
  smo.environment.detect.mockResolvedValue(detected);
  render(<App />);
  await screen.findByRole('heading', { name: '首次环境配置' });
  await screen.findByText(detected.hardware?.gpu ?? hardware.gpu);
}

async function expectStudio(): Promise<void> {
  expect(await screen.findByRole('button', { name: '新建数字模特' })).toBeInTheDocument();
  expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  smo.avatars.list.mockResolvedValue([]);
  smo.works.list.mockResolvedValue([]);
  smo.llm.getProfile.mockResolvedValue(null);
  smo.files.mediaUrl.mockImplementation(async (path: string) =>
    `smo-media://media/${encodeURIComponent(path)}`,
  );
  smo.comfy.health.mockResolvedValue({ system: {}, devices: [] });
  smo.window.isMaximized.mockResolvedValue(false);
  smo.window.toggleMaximize.mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('first-launch environment wizard', () => {
  test('loads state and automatically detects hardware when no config exists', async () => {
    await renderDetectedWizard();

    expect(smo.environment.getState).toHaveBeenCalledTimes(1);
    expect(smo.environment.detect).toHaveBeenCalledWith(INSTALL_ROOT);
    expect(screen.getByRole('heading', { name: 'SMO.H3 Studio' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'SMO.H3 Studio 标志' })).toHaveAttribute(
      'src',
      './brand/icon.png',
    );
  });

  test.each(['failed', 'installing'] as const)(
    'automatically detects the saved install root for a %s config',
    async (status) => {
      const config = { ...readyConfig, status };
      await renderDetectedWizard(
        environmentState({ config, hardware: null, selection: null }),
        environmentState({ config }),
      );

      expect(smo.environment.detect).toHaveBeenCalledWith(INSTALL_ROOT);
    },
  );

  test('shows hardware, compatibility limits, runtime size, and all eight Chinese stages', async () => {
    await renderDetectedWizard();

    const summary = screen.getByRole('region', { name: '硬件摘要' });
    expect(summary).toHaveTextContent(hardware.gpu);
    expect(summary).toHaveTextContent('16 GiB');
    expect(summary).toHaveTextContent('64 GiB');
    expect(summary).toHaveTextContent('12.0');
    expect(summary).toHaveTextContent('512 GiB');
    expect(screen.getByText(/最低兼容候选：RTX 30 系、8 GB 显存、32 GB 内存/)).toBeInTheDocument();
    expect(screen.getByText(/RTX 30\/40 系使用 SM89/)).toBeInTheDocument();
    expect(screen.getByText(/RTX 50 系使用 SM120/)).toBeInTheDocument();
    expect(screen.getByText(/RTX 30 系与 8 GB 显存仅为兼容候选/)).toBeInTheDocument();
    expect(screen.getByText('SM120（NVIDIA RTX 50 系）')).toBeInTheDocument();
    expect(screen.getByText('预计需要 64.0 GiB')).toBeInTheDocument();

    const stages = screen.getByRole('list', { name: '安装阶段' });
    const items = within(stages).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items.map((item) => item.textContent)).toEqual([
      '检测硬件',
      '选择配置',
      '下载运行时',
      '解压运行时',
      '下载模型',
      '校验文件',
      '启动 ComfyUI',
      '环境就绪',
    ]);
  });

  test('uses the recommended profile and disables choices that exceed VRAM', async () => {
    await renderDetectedWizard();

    const profile = screen.getByLabelText('性能档位');
    expect(profile).toHaveValue('balanced-16gb');
    expect(within(profile).getByRole('option', { name: /保守/ })).toBeEnabled();
    expect(within(profile).getByRole('option', { name: /均衡/ })).toBeEnabled();
    expect(within(profile).getByRole('option', { name: /高显存候选/ })).toBeDisabled();
    expect(within(profile).getByRole('option', { name: /高显存候选/ })).toHaveTextContent('未实测');
  });

  test('treats 8 GiB as only a conservative compatibility candidate', async () => {
    await renderDetectedWizard(undefined, environmentState({
      hardware: { ...hardware, gpu: 'NVIDIA GeForce RTX 3060', vramGiB: 8, ramGiB: 32 },
      selection: null,
    }));

    const profile = screen.getByLabelText('性能档位');
    expect(profile).toHaveValue('conservative');
    expect(within(profile).getByRole('option', { name: /均衡/ })).toBeDisabled();
    expect(within(profile).getByRole('option', { name: /高显存候选/ })).toBeDisabled();
  });

  test('edits the install directory, selects a profile, and starts only once', async () => {
    await renderDetectedWizard();
    let resolveStart: ((state: EnvironmentState) => void) | undefined;
    smo.environment.start.mockImplementation(
      () => new Promise<EnvironmentState>((resolve) => { resolveStart = resolve; }),
    );

    fireEvent.change(screen.getByLabelText('安装目录'), {
      target: { value: 'E:\\Custom H3' },
    });
    fireEvent.change(screen.getByLabelText('性能档位'), {
      target: { value: 'conservative' },
    });
    const start = screen.getByRole('button', { name: '开始安装' });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(smo.environment.start).toHaveBeenCalledTimes(1);
    expect(smo.environment.start).toHaveBeenCalledWith({
      profileId: 'conservative',
      installRoot: 'E:\\Custom H3',
    });
    expect(screen.getByLabelText('安装目录')).toBeDisabled();
    expect(start).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消安装' })).toBeEnabled();

    await act(async () => { resolveStart?.(readyState()); });
    await expectStudio();
  });

  test('retries a failed installation and displays a rejection', async () => {
    const failedConfig = { ...readyConfig, status: 'failed' as const };
    await renderDetectedWizard(
      environmentState({ config: failedConfig, hardware: null, selection: null }),
      environmentState({ config: failedConfig }),
    );
    smo.environment.retry.mockRejectedValue(new Error('模型校验失败'));

    fireEvent.click(screen.getByRole('button', { name: '重试安装' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('模型校验失败');
    expect(smo.environment.retry).toHaveBeenCalledWith({
      profileId: 'balanced-16gb',
      installRoot: INSTALL_ROOT,
    });
    expect(smo.environment.start).not.toHaveBeenCalled();
  });

  test('cancels an active installation and synchronizes the returned state', async () => {
    smo.environment.getState.mockResolvedValue(environmentState({
      active: true,
      stage: 'download-runtime',
    }));
    smo.environment.cancel.mockResolvedValue(environmentState({ active: false }));
    render(<App />);
    const cancel = await screen.findByRole('button', { name: '取消安装' });

    expect(screen.getByLabelText('安装目录')).toBeDisabled();
    expect(screen.getByRole('button', { name: '开始安装' })).toBeDisabled();
    fireEvent.click(cancel);

    await waitFor(() => expect(smo.environment.cancel).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByLabelText('安装目录')).toBeEnabled());
  });

  test('runs detection on demand and shows detection errors', async () => {
    await renderDetectedWizard();
    smo.environment.detect.mockRejectedValueOnce(new Error('无法读取 GPU'));
    fireEvent.change(screen.getByLabelText('安装目录'), {
      target: { value: 'E:\\Detect Here' },
    });

    fireEvent.click(screen.getByRole('button', { name: '重新检测' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取 GPU');
    expect(smo.environment.detect).toHaveBeenLastCalledWith('E:\\Detect Here');
  });

  test('shows real byte progress, percentage, and only the current file basename', async () => {
    smo.environment.getState.mockResolvedValue(environmentState({
      active: true,
      stage: 'download-models',
      progress: {
        downloadedBytes: 5 * GIB,
        totalBytes: 10 * GIB,
        currentFile: 'diffusion_models\\h3-int8.safetensors',
      },
    }));
    render(<App />);

    const progress = await screen.findByRole('progressbar', { name: '安装进度' });
    expect(progress).toHaveAttribute('max', String(10 * GIB));
    expect(progress).toHaveAttribute('value', String(5 * GIB));
    expect(screen.getByText('5.0 / 10.0 GiB')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('当前文件：h3-int8.safetensors')).toBeInTheDocument();
    expect(screen.queryByText(/diffusion_models\\h3/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('下载模型');
  });

  test('uses an indeterminate progress bar while total bytes are zero', async () => {
    smo.environment.getState.mockResolvedValue(environmentState({
      active: true,
      stage: 'detect',
      progress: { downloadedBytes: 0, totalBytes: 0 },
    }));
    render(<App />);

    const progress = await screen.findByRole('progressbar', { name: '安装进度' });
    expect(progress).not.toHaveAttribute('value');
    expect(progress).toHaveClass('environment-progress-indeterminate');
  });

  test('polls active state every 750 ms and stops when installation becomes inactive', async () => {
    vi.useFakeTimers();
    const active = environmentState({ active: true, stage: 'verify' });
    smo.environment.getState
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce(environmentState({ active: false, stage: 'verify' }));
    render(<App />);
    await act(async () => { await Promise.resolve(); });
    expect(smo.environment.getState).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(smo.environment.getState).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(smo.environment.getState).toHaveBeenCalledTimes(3);

    await act(async () => { await vi.advanceTimersByTimeAsync(2250); });
    expect(smo.environment.getState).toHaveBeenCalledTimes(3);
  });

  test('cleans up polling and ignores an initial response that arrives after unmount', async () => {
    vi.useFakeTimers();
    let resolveState: ((state: EnvironmentState) => void) | undefined;
    smo.environment.getState.mockImplementation(
      () => new Promise<EnvironmentState>((resolve) => { resolveState = resolve; }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<App />);
    view.unmount();

    await act(async () => {
      resolveState?.(environmentState({ active: true }));
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(smo.environment.getState).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('ready environment entry', () => {
  test('enters the original app directly when config is ready and healthy', async () => {
    smo.environment.getState.mockResolvedValue(readyState(true));
    render(<App />);

    await expectStudio();
    expect(smo.comfy.health).not.toHaveBeenCalled();
    expect(smo.environment.detect).not.toHaveBeenCalled();
    expect(smo.environment.retry).not.toHaveBeenCalled();
  });

  test('checks ComfyUI health on restart and enters without reinstalling', async () => {
    smo.environment.getState.mockResolvedValue(readyState(false));
    render(<App />);

    await expectStudio();
    expect(smo.comfy.health).toHaveBeenCalledTimes(1);
    expect(smo.environment.retry).not.toHaveBeenCalled();
    expect(smo.environment.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    smo.hardware.detect.mockResolvedValue(hardware);
    smo.hardware.recommend.mockResolvedValue({
      preset: 'balanced-16gb',
      modelPolicy: 'int8',
      megapixels: 0.7,
      lowvram: true,
      tiling: 'auto',
      requiresConfirmation: true,
    });
    fireEvent.click(await screen.findByRole('button', { name: '检测硬件' }));
    fireEvent.click(await screen.findByRole('button', { name: '获取推荐' }));
    expect(await screen.findByLabelText('模型目录')).toHaveValue(readyConfig.modelDirectory);
  });

  test('uses full environment retry with the saved profile when the health check fails', async () => {
    smo.environment.getState.mockResolvedValue(readyState(false));
    smo.comfy.health.mockRejectedValue(new Error('ComfyUI offline'));
    smo.environment.retry.mockResolvedValue(readyState(true));
    render(<App />);

    await expectStudio();
    expect(smo.environment.retry).toHaveBeenCalledWith({
      profileId: readyConfig.profile,
      installRoot: INSTALL_ROOT,
    });
    expect(smo.environment.start).not.toHaveBeenCalled();
  });

  test('keeps the wizard visible with an error when health recovery fails', async () => {
    smo.environment.getState.mockResolvedValue(readyState(false));
    smo.comfy.health.mockRejectedValue(new Error('ComfyUI offline'));
    smo.environment.retry.mockRejectedValue(new Error('运行时校验失败'));
    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('运行时校验失败');
    expect(screen.getByRole('heading', { name: '首次环境配置' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeInTheDocument();
  });

  test('keeps the original studio draft across navigation after a healthy restart', async () => {
    smo.environment.getState.mockResolvedValue(readyState(true));
    smo.avatars.list.mockResolvedValue([
      {
        id: 'avatar-1',
        name: '草稿模特',
        photoPath: `${INSTALL_ROOT}\\avatar.png`,
        createdAt: '2026-10-30T08:00:00.000Z',
      },
    ]);
    render(<App />);
    const input = await screen.findByLabelText('原始文字');
    fireEvent.change(input, { target: { value: '环境检查后仍保留草稿' } });

    for (const name of ['数字模特', '我的作品', '设置']) {
      fireEvent.click(screen.getByRole('button', { name }));
      fireEvent.click(screen.getByRole('button', { name: '制作台' }));
      expect(screen.getByLabelText('原始文字')).toHaveValue('环境检查后仍保留草稿');
    }
  });
});
