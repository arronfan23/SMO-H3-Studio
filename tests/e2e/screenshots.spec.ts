import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startComfyMock } from '../fixtures/mock-comfy';
import { writeReadyEnvironment } from '../fixtures/ready-environment';
import { seedAvatar } from '../fixtures/seed-avatar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(__dirname, '../../dist/main/index.js');
const HARDWARE_MOCK_PATH = join(__dirname, '../fixtures/mock-hardware.cjs');
const SCREENSHOT_DIR = join(__dirname, '../../docs/screenshots');
const FFMPEG_PATH =
  process.env.SMO_FFMPEG_PATH ??
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\tools\\ffmpeg\\ffmpeg.exe';
const CAPTURE_ENABLED = process.env.SMO_CAPTURE_SCREENSHOTS === '1';

test.skip(!CAPTURE_ENABLED, 'Set SMO_CAPTURE_SCREENSHOTS=1 to refresh README screenshots.');

test.describe.configure({ mode: 'serial' });

interface CaptureContext {
  app: ElectronApplication;
  page: Page;
  root: string;
  cleanup: () => Promise<void>;
}

async function launchForCapture(options: {
  readyEnvironment: boolean;
  avatarName?: string;
  avatarPhotoPath?: string;
}): Promise<CaptureContext> {
  const root = await mkdtemp(join(tmpdir(), 'smo-screenshot-'));
  const dataDirectory = join(root, 'data');
  const outputDirectory = join(root, 'output');
  const userDataDir = join(root, 'user');
  const installRoot = join(root, 'environment');
  await Promise.all([
    mkdir(dataDirectory, { recursive: true }),
    mkdir(outputDirectory, { recursive: true }),
    mkdir(userDataDir, { recursive: true }),
  ]);

  let comfy: Awaited<ReturnType<typeof startComfyMock>> | undefined;
  if (options.readyEnvironment) {
    await writeReadyEnvironment({ dataDirectory, installRoot, outputDirectory });
    comfy = await startComfyMock({ outputDirectory });
    if (options.avatarName && options.avatarPhotoPath) {
      await seedAvatar({
        dataDirectory,
        outputDirectory,
        name: options.avatarName,
        photoPath: options.avatarPhotoPath,
      });
    }
  }

  const app = await electron.launch({
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
      ...(comfy ? { SMO_COMFYUI_BASE_URL: comfy.baseUrl } : {}),
    },
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(320, 600);
    window.setContentSize(1440, 900);
  });
  return {
    app,
    page,
    root,
    cleanup: async () => {
      await app.close();
      await comfy?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function capture(page: Page, name: string): Promise<void> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOT_DIR, name) });
}

test('captures README screenshots', async () => {
  test.setTimeout(120_000);

  // 1. First-launch wizard (no environment config, mocked hardware).
  const wizard = await launchForCapture({ readyEnvironment: false });
  try {
    await expect(wizard.page.getByRole('heading', { name: '首次环境配置' })).toBeVisible();
    await expect(wizard.page.getByText('NVIDIA GeForce RTX 5080')).toBeVisible();
    await wizard.page.getByLabel('安装目录').fill('D:\\SMO-H3');
    await capture(wizard.page, '01-first-launch-wizard.png');
  } finally {
    await wizard.cleanup();
  }

  // 2-5. Ready environment with a seeded avatar and one generated work.
  const studio = await launchForCapture({
    readyEnvironment: true,
    avatarName: 'SMO 数字模特',
    avatarPhotoPath: join(__dirname, '../../resources/brand/icon.png'),
  });
  try {
    await expect(
      studio.page.getByRole('navigation', { name: '主导航' }),
    ).toBeVisible();
    await expect(
      studio.page.getByRole('heading', { name: 'SMO 数字模特' }),
    ).toBeVisible();

    await studio.page.getByLabel('原始文字').fill(
      '主播在明亮演播室里面对镜头，缓慢转身并自然挥手，镜头平稳推进。',
    );
    await capture(studio.page, '02-studio-text.png');

    await studio.page.getByRole('button', { name: '数字模特' }).click();
    await expect(
      studio.page.getByRole('heading', { name: '数字模特', exact: true }),
    ).toBeVisible();
    await capture(studio.page, '03-avatars.png');

    await studio.page.getByRole('button', { name: '设置' }).click();
    await expect(studio.page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(studio.page.getByLabel('服务地址')).toBeVisible();
    await capture(studio.page, '04-settings.png');
  } finally {
    await studio.cleanup();
  }
});
