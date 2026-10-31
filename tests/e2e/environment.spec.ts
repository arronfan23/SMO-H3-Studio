import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startComfyMock } from '../fixtures/mock-comfy';
import { writeReadyEnvironment } from '../fixtures/ready-environment';
import type { EnvironmentState } from '../../src/shared/environment';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(__dirname, '../../dist/main/index.js');
const HARDWARE_MOCK_PATH = join(__dirname, '../fixtures/mock-hardware.cjs');
const GIB = 1024 ** 3;

async function launchApp(
  userDataDir: string,
  dataDirectory: string,
  outputDirectory: string,
  comfyBaseUrl?: string,
) {
  return electron.launch({
    args: [
      '--require',
      HARDWARE_MOCK_PATH,
      APP_PATH,
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--user-data-dir',
      userDataDir,
    ],
    env: {
      ...process.env,
      SMO_DATA_DIRECTORY: dataDirectory,
      SMO_OUTPUT_DIRECTORY: outputDirectory,
      ...(comfyBaseUrl ? { SMO_COMFYUI_BASE_URL: comfyBaseUrl } : {}),
    },
  });
}

test('first launch configures through the wizard without downloads or GPU dependence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smo-environment-e2e-'));
  const dataDirectory = join(root, 'data');
  const outputDirectory = join(root, 'output');
  const userDataDir = join(root, 'user');
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ]);
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(userDataDir, dataDirectory, outputDirectory);
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const installRoot = 'D:\\SMO-E2E-Environment';
      let state: EnvironmentState = {
        config: null,
        hardware: null,
        selection: null,
        installRoot,
        stage: 'detect',
        progress: { downloadedBytes: 0, totalBytes: 0 },
        error: null,
        active: false,
        healthy: false,
      };
      const snapshot = () => structuredClone(state);
      let rejectStart: ((reason: Error) => void) | undefined;
      for (const channel of ['getState', 'start', 'retry', 'cancel']) {
        ipcMain.removeHandler(`environment:${channel}`);
      }
      ipcMain.handle('environment:getState', snapshot);
      ipcMain.handle('environment:start', (_event, input: { installRoot: string }) => {
        const gib = 1024 ** 3;
        state = {
          ...state,
          installRoot: input.installRoot,
          stage: 'download-runtime',
          progress: { downloadedBytes: gib, totalBytes: 4 * gib, currentFile: 'runtime.zip' },
          active: true,
        };
        return new Promise<EnvironmentState>((_, reject) => {
          rejectStart = reject;
        });
      });
      ipcMain.handle('environment:retry', snapshot);
      ipcMain.handle('environment:cancel', () => {
        state = {
          ...state,
          stage: 'select',
          active: false,
          error: 'Environment setup cancellation requested',
        };
        rejectStart?.(new Error('Environment setup cancelled'));
        return snapshot();
      });
    });

    await expect(page.getByRole('heading', { name: '首次环境配置' })).toBeVisible();
    await expect(page.getByText('NVIDIA GeForce RTX 5080')).toBeVisible();
    await expect(page.getByLabel('性能档位')).toHaveValue('conservative');
    await page.getByLabel('安装目录').fill('E:\\SMO-E2E-Custom');
    await page.getByRole('button', { name: '开始安装' }).click();
    await expect(page.getByRole('progressbar', { name: '安装进度' })).toHaveAttribute(
      'value',
      String(GIB),
    );
    await expect(page.getByText('当前文件：runtime.zip')).toBeVisible();
    await expect(page.getByLabel('安装目录')).toBeDisabled();
    await page.getByRole('button', { name: '取消安装' }).click();
    await expect(page.getByLabel('安装目录')).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/Environment setup cancell/)).toHaveCount(0);

    const [actualWidth] = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(320, 600);
      win.setContentSize(800, 700);
      const [roundedWidth] = win.getContentSize();
      if (roundedWidth !== 800) {
        win.setContentSize(800 - (roundedWidth - 800), 700);
      }
      return win.getContentSize();
    });
    expect(actualWidth).toBe(800);
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(800);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a healthy ready environment reopens the original studio on restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smo-environment-ready-e2e-'));
  const dataDirectory = join(root, 'data');
  const outputDirectory = join(root, 'output');
  const userDataDir = join(root, 'user');
  const installRoot = join(root, 'environment');
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ]);
  await writeReadyEnvironment({ dataDirectory, installRoot, outputDirectory });
  const comfy = await startComfyMock({ outputDirectory });
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(userDataDir, dataDirectory, outputDirectory, comfy.baseUrl);
    const page = await app.firstWindow();
    await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '首次环境配置' })).toHaveCount(0);
  } finally {
    await app?.close();
    await comfy.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a ready environment whose backend lost required nodes cannot enter the studio', async () => {
  const root = await mkdtemp(join(tmpdir(), 'smo-environment-nodes-e2e-'));
  const dataDirectory = join(root, 'data');
  const outputDirectory = join(root, 'output');
  const userDataDir = join(root, 'user');
  const installRoot = join(root, 'environment');
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ]);
  await writeReadyEnvironment({ dataDirectory, installRoot, outputDirectory });
  const comfy = await startComfyMock({
    outputDirectory,
    omitObjectInfoNodes: ['MiniMaxH3ReferenceToVideo'],
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchApp(userDataDir, dataDirectory, outputDirectory, comfy.baseUrl);
    const page = await app.firstWindow();

    // Health alone is not enough: the missing custom node must keep the
    // studio locked behind the wizard, and recovery fails visibly because
    // the fixture runtime has no verifiable files.
    await expect(page.getByRole('heading', { name: '首次环境配置' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
  } finally {
    await app?.close();
    await comfy.close();
    await rm(root, { recursive: true, force: true });
  }
});
