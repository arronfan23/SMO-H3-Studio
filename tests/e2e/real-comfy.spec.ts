import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeReadyEnvironment } from '../fixtures/ready-environment';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REAL_RUN_ENABLED = process.env.SMO_REAL_H3 === '1';
// SMO_REAL_H3_BASE_URL is an escape hatch for validating the start path on a
// free port; the acceptance run uses the default 8188.
const COMFY_BASE_URL = process.env.SMO_REAL_H3_BASE_URL ?? 'http://127.0.0.1:8188';
const COMFY_ROOT =
  process.env.SMO_COMFYUI_ROOT ??
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130';
const STARTUP_TIMEOUT_MS = 240_000;

const REQUIRED_NODE_TYPES = [
  'SelfLiftH3Sampler',
  'SelfLiftAvatarH3Sampler',
  'VedaSparseAttention',
  'QwenH3PromptLocal',
  'MiniMaxH3ReferenceToVideo',
];

interface ComfySystemStatsShape {
  system: Record<string, unknown>;
  devices: Array<Record<string, unknown>>;
}

interface SmoComfyGlobal {
  smo: {
    comfy: {
      health(): Promise<ComfySystemStatsShape>;
    };
  };
}

async function fetchJson(path: string): Promise<unknown> {
  const response = await fetch(new URL(path, COMFY_BASE_URL), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`ComfyUI ${path} returned HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

async function comfySystemStats(): Promise<ComfySystemStatsShape | null> {
  try {
    const value = await fetchJson('system_stats');
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as ComfySystemStatsShape).system !== 'object' ||
      !Array.isArray((value as ComfySystemStatsShape).devices)
    ) {
      return null;
    }
    return value as ComfySystemStatsShape;
  } catch {
    return null;
  }
}

test.describe('real SelfLift ComfyUI backend', () => {
  test.skip(!REAL_RUN_ENABLED, 'Set SMO_REAL_H3=1 to run the real-hardware suite.');

  test('starts or reuses the SelfLift backend and exposes the H3 node set', async () => {
    const appPath = join(__dirname, '../../dist/main/index.js');
    const root = await mkdtemp(join(tmpdir(), 'smo-real-e2e-'));
    const dataDirectory = join(root, 'data');
    const outputDirectory = join(root, 'output');
    const userDataDir = join(root, 'user');
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
    ]);
    await writeReadyEnvironment({
      dataDirectory,
      installRoot: dirname(COMFY_ROOT),
      runtimeRoot: COMFY_ROOT,
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
      outputDirectory,
    });
    const logPath = join(dataDirectory, 'logs', 'comfyui-backend.log');

    // A healthy backend before we launch means the test reuses the user's
    // instance instead of starting a new one.
    const preExistingStats = await comfySystemStats();
    const reusedExistingInstance = preExistingStats !== null;
    console.log(
      reusedExistingInstance
        ? '[real-comfy] direct reuse: ComfyUI already healthy before app launch'
        : '[real-comfy] no healthy ComfyUI found; will recover through environment retry',
    );

    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({
        args: [
          appPath,
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
          SMO_COMFYUI_BASE_URL: COMFY_BASE_URL,
          SMO_COMFYUI_ROOT: COMFY_ROOT,
        },
      });

      const window = await app.firstWindow();
      await expect(window).toHaveTitle('SMO.H3 Studio');
      await expect(window.locator('nav[aria-label="主导航"]')).toBeVisible({
        timeout: STARTUP_TIMEOUT_MS,
      });
      await window.click('nav[aria-label="主导航"] button:has-text("设置")');

      const healthyHeading = window.locator('h3:has-text("ComfyUI 连接正常")');
      await expect(healthyHeading).toBeVisible({ timeout: 30_000 });
      console.log(
        reusedExistingInstance
          ? '[real-comfy] reused pre-existing healthy ComfyUI instance'
          : '[real-comfy] ComfyUI started through environment recovery',
      );

      // Verify through the app's own IPC surface.
      const health = await window.evaluate(() =>
        (window as unknown as SmoComfyGlobal).smo.comfy.health(),
      );
      expect(typeof health.system).toBe('object');
      expect(Array.isArray(health.devices)).toBe(true);
      const deviceNames = health.devices
        .map((device) => device.name)
        .filter((name): name is string => typeof name === 'string');
      expect(
        deviceNames.some((name) => name.includes('RTX 5080')),
        `expected an RTX 5080 device in ${JSON.stringify(deviceNames)}`,
      ).toBe(true);
      console.log(`[real-comfy] devices: ${deviceNames.join(', ')}`);
      // The app must close cleanly even after it started the detached
      // ComfyUI child (the detached process tree must not hold the test
      // runner's handles open).
      const closeOutcome = await Promise.race([
        app.close().then(() => 'resolved' as const),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 60_000)),
      ]);
      expect(closeOutcome).toBe('resolved');
      app = undefined;
      console.log('[real-comfy] app.close() resolved');
    } catch (error) {
      console.log(`[real-comfy] FAILED — ComfyUI logs kept at ${logPath}`);
      throw error;
    } finally {
      await app?.close();
      app = undefined;
    }

    // The app must not take the backend down with it.
    const postCloseStats = await comfySystemStats();
    expect(
      postCloseStats,
      'ComfyUI must stay healthy after the app closes',
    ).not.toBeNull();
    console.log(
      `[real-comfy] system_stats after app.close: ok (os: ${String(postCloseStats!.system.os)})`,
    );

    // Verify the SelfLift H3 node set straight from the backend HTTP API.
    const objectInfo = (await fetchJson('object_info')) as Record<string, unknown>;
    const missing = REQUIRED_NODE_TYPES.filter((type) => !(type in objectInfo));
    expect(missing, `missing node types: ${missing.join(', ')}`).toEqual([]);
    console.log(`[real-comfy] object_info contains all ${REQUIRED_NODE_TYPES.length} H3 node types`);

    if (reusedExistingInstance) {
      await rm(root, { recursive: true, force: true });
    } else {
      // This run started the detached ComfyUI child, which still holds the log
      // file descriptor on Windows. Keep the data/log directory for the user
      // instead of forcing a delete; the throwaway user-data dir is safe to drop.
      await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      console.log(`[real-comfy] backend left running for the user; logs kept at ${logPath}`);
    }
  });
});
