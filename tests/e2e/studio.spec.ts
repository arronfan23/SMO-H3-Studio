import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startComfyMock } from '../fixtures/mock-comfy';
import { startLlmMock } from '../fixtures/mock-llm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const TEST_LLM_API_KEY = 'smo-e2e-test-key';

const FFMPEG_PATH =
  process.env.SMO_FFMPEG_PATH ??
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\tools\\ffmpeg\\ffmpeg.exe';

async function createTestMedia(directory: string): Promise<{
  imagePath: string;
  audioPath: string;
}> {
  const imagePath = join(directory, 'avatar.png');
  const audioPath = join(directory, 'voice.mp3');
  await execFileAsync(FFMPEG_PATH, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=512x512:rate=1',
    '-vframes',
    '1',
    imagePath,
  ]);
  await execFileAsync(FFMPEG_PATH, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=2',
    audioPath,
  ]);
  return { imagePath, audioPath };
}

interface LaunchAppOptions {
  dataDirectory: string;
  outputDirectory: string;
  userDataDir: string;
  comfyBaseUrl: string;
  fileDialogPaths: string[];
}

async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  const appPath = join(__dirname, '../../dist/main/index.js');
  return electron.launch({
    args: [
      appPath,
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--user-data-dir',
      options.userDataDir,
    ],
    env: {
      ...process.env,
      SMO_DATA_DIRECTORY: options.dataDirectory,
      SMO_OUTPUT_DIRECTORY: options.outputDirectory,
      SMO_COMFYUI_BASE_URL: options.comfyBaseUrl,
      SMO_TEST_FILE_DIALOG: JSON.stringify(options.fileDialogPaths),
      SMO_FFMPEG_PATH: FFMPEG_PATH,
    },
  });
}

function collectDiagnostics(
  app: ElectronApplication,
  window: Page,
  pageErrors: Error[],
  consoleErrors: string[],
  rendererLogs: string[],
  mainProcessLogs: string[],
): void {
  window.on('pageerror', (error) => {
    pageErrors.push(error);
  });
  window.on('console', (message) => {
    const text = message.text();
    rendererLogs.push(text);
    if (message.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  const process = app.process();
  const appendMainLogs = (data: Buffer) => {
    const lines = data.toString().split(/\r?\n/);
    for (const line of lines) {
      if (line.length > 0) {
        mainProcessLogs.push(line);
      }
    }
  };
  process.stdout?.on('data', appendMainLogs);
  process.stderr?.on('data', appendMainLogs);
}

async function waitForStableStatus(
  window: Page,
  jobId: string,
  status: 'done' | 'failed',
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        return window.evaluate((id) => {
          const code = Array.from(document.querySelectorAll('code')).find(
            (candidate) => candidate.textContent === id,
          );
          const container = code?.closest('section[aria-label="任务状态"], article.work-item');
          return container?.querySelector('.status-badge')?.textContent ?? null;
        }, jobId);
      },
      { timeout: timeoutMs },
    )
    .toContain(status === 'done' ? '已完成' : '失败');
}

async function setViewport(
  app: ElectronApplication,
  window: Page,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(width, height);
    }
  }, { width, height });

  await window.evaluate(() => new Promise<void>((resolve) => {
    let lastWidth = window.innerWidth;
    let lastHeight = window.innerHeight;
    let stableCount = 0;
    const check = () => {
      const currentWidth = window.innerWidth;
      const currentHeight = window.innerHeight;
      if (currentWidth === lastWidth && currentHeight === lastHeight) {
        stableCount++;
        if (stableCount >= 3) {
          resolve();
          return;
        }
      } else {
        stableCount = 0;
        lastWidth = currentWidth;
        lastHeight = currentHeight;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }));
}

async function assertViewLayout(
  window: Page,
  viewName: string,
  selectors: string[],
): Promise<void> {
  const violations = await window.evaluate(
    ({ view, selectors }) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const results: Array<{
        view: string;
        type: string;
        selector?: string;
        message: string;
        rect?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
      }> = [];
      if (document.documentElement.scrollWidth > viewport.width) {
        results.push({
          view,
          type: 'document-overflow',
          message: `scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${viewport.width}`,
        });
      }
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (!element) {
          results.push({ view, type: 'missing', selector, message: 'element not found' });
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.left < 0 || rect.right > viewport.width || rect.top < 0 || rect.bottom > viewport.height) {
          results.push({
            view,
            type: 'out-of-viewport',
            selector,
            message: `element overflows viewport ${JSON.stringify(viewport)}`,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
          });
        }
      }
      return results;
    },
    { view: viewName, selectors },
  );
  expect(violations).toEqual([]);
}

async function createAvatar(window: Page, name: string): Promise<void> {
  await window.click('nav[aria-label="主导航"] button:has-text("数字模特")');
  await expect(window.locator('#avatar-name')).toBeVisible();
  await window.fill('#avatar-name', name);
  await window.click('button:has-text("选择照片")');
  await expect(window.locator('.selected-file')).toHaveText('avatar.png');
  await window.click('button:has-text("保存模特")');

  const avatar = window.locator('.avatar-list article').filter({ hasText: name });
  await expect(avatar).toBeVisible();
  await expect(avatar.getByRole('button', { name: '当前模特' })).toBeDisabled();
}

async function saveLlmProfile(window: Page, baseUrl: string): Promise<void> {
  await window.click('nav[aria-label="主导航"] button:has-text("设置")');
  await expect(window.locator('#llm-base-url')).toBeVisible();
  await window.fill('#llm-base-url', `${baseUrl}/v1`);
  await window.fill('#llm-model', 'model-a');
  await window.fill('#llm-api-key', TEST_LLM_API_KEY);
  await window.click('button:has-text("保存设置")');
  await expect(window.locator('h3:has-text("已配置 LLM")')).toBeVisible();
  await expect(window.locator('#llm-api-key')).toHaveValue('');
}

async function openStudio(window: Page, avatarName: string): Promise<void> {
  await window.click('nav[aria-label="主导航"] button:has-text("制作台")');
  await expect(
    window.locator(`.person-preview h2:has-text("${avatarName}")`),
  ).toBeVisible();
}

async function readVisibleTextJobId(window: Page): Promise<string> {
  const jobId = window.locator(
    '#text-mode-panel section[aria-label="任务状态"]:visible code',
  );
  await expect(jobId).toHaveText(/^[0-9a-f-]{36}$/);
  return (await jobId.textContent())!;
}

test.describe('SMO.H3 Studio end-to-end', () => {
  let app: ElectronApplication | undefined;
  let window: Page | undefined;
  let tempDirectory: string | undefined;
  let launchOptions: LaunchAppOptions;
  let llmMock: Awaited<ReturnType<typeof startLlmMock>>;
  let comfyMock: Awaited<ReturnType<typeof startComfyMock>>;
  let pageErrors: Error[] = [];
  let consoleErrors: string[] = [];
  let rendererLogs: string[] = [];
  let mainProcessLogs: string[] = [];

  let dataDirectory: string;
  let outputDirectory: string;
  let userDataDir: string;

  test.beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'smo-studio-e2e-'));
    const root = tempDirectory;
    const mediaDirectory = join(root, 'media');
    dataDirectory = join(root, 'data');
    outputDirectory = join(root, 'output');
    userDataDir = join(root, 'user');
    await Promise.all([
      mkdir(mediaDirectory, { recursive: true }),
      mkdir(dataDirectory, { recursive: true }),
      mkdir(outputDirectory, { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
    ]);
    const media = await createTestMedia(mediaDirectory);

    llmMock = await startLlmMock();
    comfyMock = await startComfyMock({
      outputDirectory,
      ffmpegPath: existsSync(FFMPEG_PATH) ? FFMPEG_PATH : undefined,
    });

    launchOptions = {
      dataDirectory,
      outputDirectory,
      userDataDir,
      comfyBaseUrl: comfyMock.baseUrl,
      fileDialogPaths: [media.imagePath, media.audioPath],
    };
    app = await launchApp(launchOptions);
    window = await app.firstWindow();
    await expect(window).toHaveTitle('SMO.H3 Studio');

    pageErrors = [];
    consoleErrors = [];
    rendererLogs = [];
    mainProcessLogs = [];
    collectDiagnostics(app!, window!, pageErrors, consoleErrors, rendererLogs, mainProcessLogs);
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      window = undefined;
      await llmMock?.close();
      await comfyMock?.close();
      if (tempDirectory) {
        await rm(tempDirectory, { recursive: true, force: true });
        tempDirectory = undefined;
      }
    }

    expect.soft(pageErrors).toHaveLength(0);
    expect.soft(consoleErrors).toHaveLength(0);
    const diagnosticLog = [
      ...pageErrors.map((error) => error.message),
      ...rendererLogs,
      ...mainProcessLogs,
    ].join('\n');
    expect.soft(diagnosticLog).not.toContain(TEST_LLM_API_KEY);
  });

  test('creates and selects an avatar', async () => {
    await createAvatar(window!, 'E2E Avatar Create');
    await expect(window!.locator('.avatar-list article')).toHaveCount(1);
  });

  test('configures LLM profile and tests the model', async () => {
    await saveLlmProfile(window!, llmMock.baseUrl);
    await window!.click('button:has-text("获取模型")');
    await expect(window!.locator('.model-options')).toContainText('model-a', {
      timeout: 15_000,
    });
    await expect(window!.locator('.model-options')).toContainText('model-b');
    await window!.click('button:has-text("测试模型")');
    await expect(window!.locator('text=测试通过')).toBeVisible({ timeout: 15_000 });
  });

  test('text-to-video with polish', async () => {
    const avatarName = 'E2E Text Avatar';
    const originalText = 'A woman waves and says hello.';
    await createAvatar(window!, avatarName);
    await saveLlmProfile(window!, llmMock.baseUrl);
    await openStudio(window!, avatarName);

    await window!.fill('#original-text', originalText);
    await window!.click('button:has-text("AI 润色")');
    await expect(window!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await expect(window!.locator('#polished-tab')).toHaveAttribute('aria-selected', 'true');
    const polishedText = await window!.inputValue('#polished-text');
    expect(polishedText).toContain('subject_definitions:');

    await window!.click('#original-tab');
    await expect(window!.locator('#original-text')).toHaveValue(originalText);
    await window!.click('#polished-tab');
    await expect(window!.locator('#polished-text')).toHaveValue(polishedText);
    await window!.fill('#polished-text', 'Polished: a woman waves and says hello.');

    const previousCount = comfyMock.submittedPromptIds.length;
    await window!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(window!);
    await waitForStableStatus(window!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);

    await window!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = window!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work.locator('video')).toBeVisible();
  });

  test('audio digital human', async () => {
    const avatarName = 'E2E Audio Avatar';
    await createAvatar(window!, avatarName);
    await openStudio(window!, avatarName);
    await window!.click('#audio-mode-tab');
    await window!.click('button:has-text("选择音频")');
    await expect(window!.locator('.audio-file')).toContainText('voice.mp3');
    await expect(window!.locator('audio[src^="smo-media://"]')).toBeVisible();
    await window!.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return audio !== null && Number.isFinite(audio.duration) && audio.duration > 0;
    });

    await window!.fill('#audio-prompt', 'She speaks with a calm expression.');
    const previousCount = comfyMock.submittedPromptIds.length;
    await window!.click('#audio-mode-panel button:has-text("生成视频")');
    const jobLocator = window!.locator(
      '#audio-mode-panel section[aria-label="任务状态"]:visible code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(window!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);
  });

  test('works list shows completed work and filters by status and mode', async () => {
    const avatarName = 'E2E Works Avatar';
    await createAvatar(window!, avatarName);
    await saveLlmProfile(window!, llmMock.baseUrl);
    await openStudio(window!, avatarName);

    await window!.fill('#original-text', 'Works list test.');
    await window!.click('button:has-text("AI 润色")');
    await expect(window!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await window!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(window!);
    await waitForStableStatus(window!, jobId, 'done');

    await window!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = window!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work).toContainText('文字生视频');

    await window!.click('.works-filters button:has-text("音频数字人")');
    await expect(window!.locator('.works-list article')).toHaveCount(0);
    await window!.click('.works-filters button:has-text("文字生视频")');
    await expect(work).toBeVisible();

    await window!.click('.works-filters button:has-text("失败")');
    await expect(window!.locator('.works-list article')).toHaveCount(0);
    await window!.click('.works-filters button:has-text("已完成")');
    await expect(work).toBeVisible();
  });

  test('failed generation is retried successfully', async () => {
    const avatarName = 'E2E Retry Avatar';
    await createAvatar(window!, avatarName);
    await saveLlmProfile(window!, llmMock.baseUrl);
    await openStudio(window!, avatarName);

    await window!.fill('#original-text', 'Failure scenario test.');
    await window!.click('button:has-text("AI 润色")');
    await expect(window!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });

    comfyMock.failNext();
    const previousCount = comfyMock.submittedPromptIds.length;
    await window!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(window!);
    await waitForStableStatus(window!, jobId, 'failed');
    expect(comfyMock.submittedPromptIds.length).toBe(previousCount + 1);

    await window!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const failedWork = window!.locator('.works-list article').filter({ hasText: jobId });
    await expect(failedWork).toBeVisible();
    const worksBefore = await window!.locator('.works-list article').count();

    await window!.click('button:has-text("重试")');

    await expect
      .poll(
        async () => window!.locator('.works-list article').count(),
        { timeout: 30_000 },
      )
      .toBe(worksBefore + 1);

    let retryWork: { id: string; status: string; metadata?: { retryOf?: string } } | undefined;
    await expect
      .poll(
        async () => {
          const works = await window!.evaluate(() => window.smo.works.list());
          retryWork = (works as Array<{ id: string; status: string; metadata?: { retryOf?: string } }>).find(
            (w) => w.metadata?.retryOf === jobId && w.status === 'done',
          );
          return retryWork;
        },
        { timeout: 60_000 },
      )
      .toBeDefined();

    expect(retryWork!.id).not.toBe(jobId);
    expect(retryWork!.metadata!.retryOf).toBe(jobId);
    expect(retryWork!.status).toBe('done');
    await waitForStableStatus(window!, retryWork!.id, 'done');
    expect(comfyMock.submittedPromptIds.length).toBe(previousCount + 2);
  });

  test('restart preserves avatar, works and LLM config', async () => {
    const avatarName = 'E2E Restart Avatar';
    await createAvatar(window!, avatarName);
    await saveLlmProfile(window!, llmMock.baseUrl);
    await openStudio(window!, avatarName);

    await window!.fill('#original-text', 'Restart persistence test.');
    await window!.click('button:has-text("AI 润色")');
    await expect(window!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await window!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(window!);
    await waitForStableStatus(window!, jobId, 'done');

    await app!.close();
    app = undefined;
    window = undefined;

    app = await launchApp({
      dataDirectory,
      outputDirectory,
      userDataDir,
      comfyBaseUrl: comfyMock.baseUrl,
      fileDialogPaths: [],
    });
    window = await app.firstWindow();
    await expect(window).toHaveTitle('SMO.H3 Studio');

    collectDiagnostics(app, window, pageErrors, consoleErrors, rendererLogs, mainProcessLogs);

    await window.click('nav[aria-label="主导航"] button:has-text("数字模特")');
    await expect(window.locator('.avatar-list')).toContainText(avatarName);

    await window.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = window.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');

    await window.click('nav[aria-label="主导航"] button:has-text("设置")');
    await expect(window.locator('#llm-base-url')).toHaveValue(`${llmMock.baseUrl}/v1`);
    await expect(window.locator('#llm-model')).toHaveValue('model-a');
    await expect(window.locator('#llm-api-key')).toHaveValue('');

    const requestsBefore = llmMock.requests.length;
    await window.click('button:has-text("测试模型")');
    await expect(window.locator('text=测试通过')).toBeVisible({ timeout: 15_000 });

    const testRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(testRequest).toBeDefined();
    expect(testRequest!.authorization).toBe(`Bearer ${TEST_LLM_API_KEY}`);
  });

  test('no layout regressions on main views', async () => {
    await expect(window!.locator('.app-shell')).toBeVisible();
    await createAvatar(window!, 'E2E Layout Avatar');

    const viewports = [
      { width: 1280, height: 820 },
      { width: 960, height: 640 },
    ];

    for (const viewport of viewports) {
      await setViewport(app!, window!, viewport.width, viewport.height);

      await window!.click('nav[aria-label="主导航"] button:has-text("制作台")');
      await expect(window!.locator('#text-mode-panel')).toBeVisible();
      await assertViewLayout(window!, 'studio-text', [
        '#original-text',
        '#polished-tab',
        '#text-mode-panel .button-generate',
      ]);

      await window!.click('#audio-mode-tab');
      await expect(window!.locator('#audio-mode-panel')).toBeVisible();
      await assertViewLayout(window!, 'studio-audio', [
        '#audio-mode-tab',
        '#audio-mode-panel .button-generate',
      ]);

      await window!.click('nav[aria-label="主导航"] button:has-text("数字模特")');
      await expect(window!.locator('.avatar-list')).toBeVisible();
      await assertViewLayout(window!, 'avatars', [
        '#avatar-name',
        '.avatar-form .button-primary',
        '.avatar-list',
      ]);

      await window!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
      await expect(window!.locator('.works-filters')).toBeVisible();
      await assertViewLayout(window!, 'works', [
        '.works-filters',
        '.page-header .button-secondary',
      ]);

      await window!.click('nav[aria-label="主导航"] button:has-text("设置")');
      await expect(window!.locator('#llm-base-url')).toBeVisible();
      await assertViewLayout(window!, 'settings', [
        '#llm-base-url',
        '#llm-model',
        '.settings-actions .button-primary',
      ]);
    }
  });
});
