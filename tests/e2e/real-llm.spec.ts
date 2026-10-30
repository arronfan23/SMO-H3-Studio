import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { seedAvatar } from '../fixtures/seed-avatar';
import { startComfyMock } from '../fixtures/mock-comfy';
import { writeReadyEnvironment } from '../fixtures/ready-environment';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REAL_RUN_ENABLED = process.env.SMO_REAL_LLM === '1';
const REAL_CONFIG_SOURCE =
  process.env.SMO_REAL_LLM_CONFIG ?? 'G:\\SMO-H3-Data\\llm-config.json';
const REAL_AVATARS_DIRECTORY =
  process.env.SMO_REAL_AVATARS_DIRECTORY ?? 'G:\\SMO-H3-Data\\avatars';
// Windows safeStorage ciphertext is tied to the packaged app's encryption
// context. Point real acceptance at the same packaged build the user runs.
const REAL_ELECTRON_EXECUTABLE = process.env.SMO_REAL_ELECTRON_EXECUTABLE;
// Auto routing, generation, and one repair each have a 120s budget inside the
// app. Allow the complete flow plus 10s of UI slack, but surface errors early.
const POLISHED_TAB_TIMEOUT_MS = 370_000;

const AVATAR_NAME = 'REAL Test Avatar';
const ORIGINAL_TEXT = 'A woman waves and says hello.';

interface SmoLlmGlobal {
  smo: {
    llm: {
      getProfile(): Promise<{
        baseUrl: string;
        model: string;
        keyStatus: 'valid' | 'reenter-required';
      } | null>;
      listModels(input: { baseUrl: string }): Promise<string[]>;
      testModel(input: { baseUrl: string; model: string }): Promise<{
        ok: true;
        latencyMs: number;
        summary: string;
      }>;
    };
  };
}

async function pickRealAvatarPhoto(directory: string): Promise<string> {
  const entries = await readdir(directory);
  const image = entries.find((entry) => /\.(png|jpe?g)$/i.test(entry));
  if (image === undefined) {
    throw new Error(`no real avatar photo found in ${directory}`);
  }
  return join(directory, image);
}

function attachMainProcessLogs(
  app: ElectronApplication,
  mainProcessRaw: (Buffer | string)[],
): void {
  const proc = app.process();
  const push = (data: Buffer | string) => mainProcessRaw.push(data);
  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
}

function attachRendererLogs(
  page: Page,
  pageErrors: Error[],
  consoleErrors: string[],
  rendererLogs: string[],
): void {
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('console', (message) => {
    const text = message.text();
    rendererLogs.push(text);
    if (message.type() === 'error') {
      consoleErrors.push(text);
    }
  });
}

test.describe('real LLM acceptance', () => {
  test.skip(!REAL_RUN_ENABLED, 'Set SMO_REAL_LLM=1 to run the real LLM suite.');

  test('validates the saved profile, exercises /models and chat, and polishes real text', async () => {
    const appPath = join(__dirname, '../../dist/main/index.js');
    const root = await mkdtemp(join(tmpdir(), 'smo-real-llm-e2e-'));
    const dataDirectory = join(root, 'data');
    const outputDirectory = join(root, 'output');
    // The real config is copied read-only into the sandbox; the source file
    // and the user's real data directory are never touched.
    const mediaDirectory = join(root, 'media');
    const userDataDir = join(outputDirectory, 'user');
    await Promise.all([
      mkdir(dataDirectory, { recursive: true }),
      mkdir(mediaDirectory, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
    ]);

    const sourceConfigRaw = await readFile(REAL_CONFIG_SOURCE, 'utf8');
    const sourceConfig = JSON.parse(sourceConfigRaw) as { encryptedApiKey?: string };
    const ciphertext = sourceConfig.encryptedApiKey ?? '';
    await copyFile(REAL_CONFIG_SOURCE, join(dataDirectory, 'llm-config.json'));

    const realPhotoPath = await pickRealAvatarPhoto(REAL_AVATARS_DIRECTORY);
    const sandboxPhotoPath = join(mediaDirectory, 'real-avatar.png');
    await copyFile(realPhotoPath, sandboxPhotoPath);
    await seedAvatar({
      dataDirectory,
      outputDirectory,
      name: AVATAR_NAME,
      photoPath: sandboxPhotoPath,
    });
    await writeReadyEnvironment({
      dataDirectory,
      installRoot: join(root, 'environment'),
      outputDirectory,
    });
    // Only the local health endpoint is used; this acceptance never submits
    // a generation workflow to ComfyUI.
    const comfyMock = await startComfyMock({ outputDirectory });

    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];
    const rendererLogs: string[] = [];
    const mainProcessRaw: (Buffer | string)[] = [];

    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({
        ...(REAL_ELECTRON_EXECUTABLE
          ? { executablePath: REAL_ELECTRON_EXECUTABLE }
          : {}),
        args: [
          ...(REAL_ELECTRON_EXECUTABLE ? [] : [appPath]),
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
          SMO_COMFYUI_BASE_URL: comfyMock.baseUrl,
        },
      });
      attachMainProcessLogs(app, mainProcessRaw);
      app.on('window', (windowPage) =>
        attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
      );
      const page = await app.firstWindow();
      await expect(page).toHaveTitle('SMO.H3 Studio');

      // 1. The copied profile must still decrypt on this machine.
      const profile = await page.evaluate(() =>
        (window as unknown as SmoLlmGlobal).smo.llm.getProfile(),
      );
      expect(profile, 'LLM profile missing in sandbox data directory').not.toBeNull();
      if (profile!.keyStatus !== 'valid') {
        throw new Error(
          'LLM keyStatus is reenter-required — 请在设置页重新输入 API Key 后再运行真实验收。',
        );
      }
      console.log(
        `[real-llm] profile ok: baseUrl=${profile!.baseUrl} model=${profile!.model} keyStatus=valid`,
      );

      // 2. /models against the real upstream.
      const models = await page.evaluate(
        (baseUrl) => (window as unknown as SmoLlmGlobal).smo.llm.listModels({ baseUrl }),
        profile!.baseUrl,
      );
      expect(Array.isArray(models)).toBe(true);
      expect(models.length, 'real /models returned no models').toBeGreaterThan(0);
      expect(models).toContain(profile!.model);
      console.log(
        `[real-llm] /models returned ${models.length} models, including ${profile!.model}`,
      );

      // 3. Small chat round-trip against the real upstream.
      const testResult = await page.evaluate(
        (input) => (window as unknown as SmoLlmGlobal).smo.llm.testModel(input),
        { baseUrl: profile!.baseUrl, model: profile!.model },
      );
      expect(testResult.ok).toBe(true);
      console.log(`[real-llm] testModel ok in ${Math.round(testResult.latencyMs)}ms`);

      // 4. Full polish path from the studio workbench (no video generation).
      await page.click('nav[aria-label="主导航"] button:has-text("制作台")');
      await expect(
        page.locator(`.person-preview h2:has-text("${AVATAR_NAME}")`),
      ).toBeVisible();
      await page.fill('#original-text', ORIGINAL_TEXT);
      await page.click('button:has-text("AI 润色")');
      const polishError = page.locator('#text-mode-panel .form-error');
      await expect(
        page.locator('#polished-tab:not([disabled]), #text-mode-panel .form-error').first(),
      ).toBeVisible({
        timeout: POLISHED_TAB_TIMEOUT_MS,
      });
      if (await polishError.isVisible()) {
        throw new Error(`Real polish failed: ${await polishError.textContent()}`);
      }
      await expect(page.locator('#polished-tab')).toBeEnabled();
      await expect(page.locator('#polished-tab')).toHaveAttribute('aria-selected', 'true');
      const polishedText = await page.inputValue('#polished-text');
      expect(polishedText).toContain('subject_definitions:');
      await expect(page.locator('#text-mode-panel .form-error')).toHaveCount(0);
      console.log(
        `[real-llm] polish ok (${polishedText.length} chars, subject_definitions present)`,
      );

      expect.soft(pageErrors).toHaveLength(0);
      expect.soft(consoleErrors).toHaveLength(0);

      // Nothing in the captured diagnostics may contain key material: neither
      // the stored ciphertext nor the decrypted secret.
      const diagnosticLog = [
        ...pageErrors.map((error) => error.message),
        ...rendererLogs,
        ...mainProcessRaw.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString())),
      ].join('\n');
      expect(diagnosticLog).not.toContain(ciphertext);
      expect(diagnosticLog).not.toMatch(/"encryptedApiKey"\s*:\s*"/);
    } finally {
      await app?.close();
      app = undefined;
      await comfyMock.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
