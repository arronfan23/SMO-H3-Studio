import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startComfyMock } from '../fixtures/mock-comfy';
import { startLlmMock } from '../fixtures/mock-llm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const TEST_LLM_API_KEY = 'smo-e2e-test-key';

interface SmoGlobal {
  smo: {
    works: {
      list: () => Promise<Array<{ id: string; status: string; metadata?: { retryOf?: string } }>>;
    };
  };
}

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


async function waitForStableStatus(
  page: Page,
  jobId: string,
  status: 'done' | 'failed',
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        return page.evaluate((id) => {
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
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const [actualWidth, actualHeight] = await app.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      throw new Error('No BrowserWindow found');
    }
    win.webContents.setZoomFactor(1);
    win.setContentSize(width, height);
    return win.getContentSize();
  }, { width, height });

  // Windows fractional-DPI rounding: observed diff is 0-2 px on a 1.75 scale display.
  expect(Math.abs(actualWidth - width)).toBeLessThanOrEqual(2);
  expect(Math.abs(actualHeight - height)).toBeLessThanOrEqual(2);

  await expect
    .poll(
      async () => page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })),
      { timeout: 5_000 },
    )
    .toEqual({ w: actualWidth, h: actualHeight });
}

async function setZoomedViewport(
  app: ElectronApplication,
  page: Page,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  const [actualWidth, actualHeight] = await app.evaluate(({ BrowserWindow }, { cssWidth, cssHeight }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      throw new Error('No BrowserWindow found');
    }
    win.webContents.setZoomFactor(2);
    win.setContentSize(cssWidth * 2, cssHeight * 2);
    return win.getContentSize();
  }, { cssWidth, cssHeight });

  // Renderer CSS pixels are content pixels divided by zoom factor.
  // BrowserWindow minWidth/minHeight may enlarge the content area; keep that real value.
  const expectedWidth = actualWidth / 2;
  const expectedHeight = actualHeight / 2;
  await expect
    .poll(
      async () => {
        const size = await page.evaluate(() => ({
          w: window.innerWidth,
          h: window.innerHeight,
        }));
        return {
          size,
          withinTolerance:
            Math.abs(size.w - expectedWidth) <= 2 &&
            Math.abs(size.h - expectedHeight) <= 2,
        };
      },
      { timeout: 5_000 },
    )
    .toEqual({ size: expect.any(Object), withinTolerance: true });

  // Confirm the effective CSS viewport is still narrow (< 800 px matches the max-width breakpoint).
  const innerWidth = await page.evaluate(() => window.innerWidth);
  expect(innerWidth).toBeLessThanOrEqual(800);
}

async function waitForVideoReadyByJobId(page: Page, jobId: string): Promise<void> {
  const selector = `video[aria-label="作品视频 ${jobId}"]`;
  await page.waitForFunction(
    (sel) => {
      const video = document.querySelector(sel) as HTMLVideoElement | null;
      return (
        video !== null &&
        video.readyState >= 1 &&
        Number.isFinite(video.duration) &&
        video.duration > 0
      );
    },
    selector,
    { timeout: 15_000 },
  );
}

async function assertViewLayout(
  page: Page,
  viewName: string,
  selectors: string[],
): Promise<void> {
  type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  type Violation = { view: string; type: string; selector?: string; message: string; rect?: Rect };

  const documentViolations = await page.evaluate(
    ({ view }) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const results: Violation[] = [];
      if (document.documentElement.scrollWidth > viewport.width) {
        results.push({
          view,
          type: 'document-overflow',
          message: `scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${viewport.width}`,
        });
      }
      return results;
    },
    { view: viewName },
  );
  expect(documentViolations).toEqual([]);

  for (const selector of selectors) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const violations = await page.evaluate(
      ({ view, selector }) => {
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        const results: Array<{
          view: string;
          type: string;
          selector?: string;
          message: string;
          rect?: { left: number; top: number; right: number; bottom: number; width: number; height: number };
        }> = [];
        const element = document.querySelector(selector);
        if (!element) {
          results.push({ view, type: 'missing', selector, message: 'element not found' });
          return results;
        }
        const rect = element.getBoundingClientRect();
        // Fractional-DPI displays (1.75 scale) snap scroll positions to device
        // pixels (~0.57 px), so allow the same 0-2 px rounding setViewport uses.
        const tolerance = 2;
        if (
          rect.left < -tolerance ||
          rect.right > viewport.width + tolerance ||
          rect.top < -tolerance ||
          rect.bottom > viewport.height + tolerance
        ) {
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
        return results;
      },
      { view: viewName, selector },
    );
    expect(violations).toEqual([]);
  }
}

async function createAvatar(page: Page, name: string): Promise<void> {
  await page.click('nav[aria-label="主导航"] button:has-text("数字模特")');
  await expect(page.locator('#avatar-name')).toBeVisible();
  await expect(page.locator('.avatar-preview-empty')).toHaveText('尚未选择照片');
  await page.fill('#avatar-name', name);

  await page.click('button:has-text("选择照片")');
  const preview = page.locator('img[alt="待保存模特照片预览"]');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute('src', /^smo-media:\/\//);
  await expect(page.locator('.selected-file')).toHaveText('avatar.png');

  await page.click('button:has-text("移除照片")');
  await expect(preview).toHaveCount(0);
  await expect(page.locator('.avatar-preview-empty')).toHaveText('尚未选择照片');

  await page.click('button:has-text("选择照片")');
  await expect(page.locator('.selected-file')).toHaveText('avatar.png');
  await page.click('button:has-text("保存模特")');

  const avatar = page.locator('.avatar-list article').filter({ hasText: name });
  await expect(avatar).toBeVisible();
  await expect(avatar.getByRole('button', { name: '当前模特' })).toBeDisabled();
}

async function saveLlmProfile(page: Page, baseUrl: string): Promise<void> {
  await page.click('nav[aria-label="主导航"] button:has-text("设置")');
  await expect(page.locator('#llm-base-url')).toBeVisible();
  await page.fill('#llm-base-url', `${baseUrl}/v1`);
  await page.fill('#llm-model', 'model-a');
  await page.fill('#llm-api-key', TEST_LLM_API_KEY);
  await page.click('button:has-text("保存设置")');
  await expect(page.locator('h3:has-text("已配置 LLM")')).toBeVisible();
  await expect(page.locator('#llm-api-key')).toHaveValue('');
}

async function openStudio(page: Page, avatarName: string): Promise<void> {
  await page.click('nav[aria-label="主导航"] button:has-text("制作台")');
  await expect(
    page.locator(`.person-preview h2:has-text("${avatarName}")`),
  ).toBeVisible();
}

async function readVisibleTextJobId(page: Page): Promise<string> {
  const jobId = page.locator(
    '#text-mode-panel section[aria-label="任务状态"]:visible code',
  );
  await expect(jobId).toHaveText(/^[0-9a-f-]{36}$/);
  return (await jobId.textContent())!;
}

test.describe('SMO.H3 Studio end-to-end', () => {
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let tempDirectory: string | undefined;
  let launchOptions: LaunchAppOptions;
  let llmMock: Awaited<ReturnType<typeof startLlmMock>>;
  let comfyMock: Awaited<ReturnType<typeof startComfyMock>>;
  let pageErrors: Error[] = [];
  let consoleErrors: string[] = [];
  let rendererLogs: string[] = [];
  let mainProcessRaw: (Buffer | string)[] = [];

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
      // createAvatar verifies preview and removal, which re-selects the image once.
      fileDialogPaths: [media.imagePath, media.imagePath, media.audioPath],
    };
    pageErrors = [];
    consoleErrors = [];
    rendererLogs = [];
    mainProcessRaw = [];

    app = await launchApp(launchOptions);
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await expect(page).toHaveTitle('SMO.H3 Studio');
  });

  test.afterEach(async () => {
    try {
      await app?.close();
    } finally {
      app = undefined;
      page = undefined;
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
      mainProcessRaw
        .map((chunk) => (typeof chunk === 'string' ? chunk : chunk.toString()))
        .join(''),
    ].join('\n');
    expect.soft(diagnosticLog).not.toContain(TEST_LLM_API_KEY);
  });

  test('creates and selects an avatar', async () => {
    await createAvatar(page!, 'E2E Avatar Create');
    await expect(page!.locator('.avatar-list article')).toHaveCount(1);
  });

  test('keeps studio draft across navigation', async () => {
    const draft = 'Keep this draft across every module.';
    await createAvatar(page!, 'E2E Draft Avatar');
    await openStudio(page!, 'E2E Draft Avatar');
    await page!.fill('#original-text', draft);

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      await page!.click(`nav[aria-label="主导航"] button:has-text("${moduleName}")`);
      await page!.click('nav[aria-label="主导航"] button:has-text("制作台")');
      await expect(page!.locator('#original-text')).toHaveValue(draft);
    }
  });

  test('configures LLM profile and tests the model', async () => {
    await saveLlmProfile(page!, llmMock.baseUrl);
    await page!.click('button:has-text("获取模型")');
    await expect(page!.locator('.model-options')).toContainText('model-a', {
      timeout: 15_000,
    });
    await expect(page!.locator('.model-options')).toContainText('model-b');
    await page!.click('button:has-text("测试模型")');
    await expect(page!.locator('text=测试通过')).toBeVisible({ timeout: 15_000 });
  });

  test('text-to-video with polish', async () => {
    const avatarName = 'E2E Text Avatar';
    const originalText = 'A woman waves and says hello.';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', originalText);
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await expect(page!.locator('#polished-tab')).toHaveAttribute('aria-selected', 'true');
    const polishedText = await page!.inputValue('#polished-text');
    expect(polishedText).toContain('subject_definitions:');

    await page!.click('#original-tab');
    await expect(page!.locator('#original-text')).toHaveValue(originalText);
    await page!.click('#polished-tab');
    await expect(page!.locator('#polished-text')).toHaveValue(polishedText);
    await page!.fill('#polished-text', 'Polished: a woman waves and says hello.');

    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work.locator('video')).toBeVisible();
    await waitForVideoReadyByJobId(page!, jobId);
  });

  test('audio digital human', async () => {
    const avatarName = 'E2E Audio Avatar';
    await createAvatar(page!, avatarName);
    await openStudio(page!, avatarName);
    await page!.click('#audio-mode-tab');
    await page!.click('button:has-text("选择音频")');
    await expect(page!.locator('.audio-file')).toContainText('voice.mp3');
    await expect(page!.locator('audio[src^="smo-media://"]')).toBeVisible();
    await page!.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return audio !== null && Number.isFinite(audio.duration) && audio.duration > 0;
    });

    await page!.fill('#audio-prompt', 'She speaks with a calm expression.');
    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#audio-mode-panel button:has-text("生成视频")');
    const jobLocator = page!.locator(
      '#audio-mode-panel section[aria-label="任务状态"]:visible code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(page!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);
  });

  test('works list shows completed work and filters by status and mode', async () => {
    const avatarName = 'E2E Works Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Works list test.');
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work).toContainText('文字生视频');

    await page!.click('.works-filters button:has-text("音频数字人")');
    await expect(page!.locator('.works-list article')).toHaveCount(0);
    await page!.click('.works-filters button:has-text("文字生视频")');
    await expect(work).toBeVisible();

    await page!.click('.works-filters button:has-text("失败")');
    await expect(page!.locator('.works-list article')).toHaveCount(0);
    await page!.click('.works-filters button:has-text("已完成")');
    await expect(work).toBeVisible();
  });

  test('shows real execution stage text and elapsed time during progress', async () => {
    const avatarName = 'E2E Progress Avatar';
    await createAvatar(page!, avatarName);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Execution stage progress text test.');
    await page!.click('#text-mode-panel button:has-text("生成视频")');

    const jobStatus = page!.locator('#text-mode-panel section[aria-label="任务状态"]');
    await expect(jobStatus).toContainText(
      /本地排队中|正在上传素材|等待 ComfyUI|正在加载模型并执行节点|正在采样生成|正在读取输出并收尾/,
      { timeout: 15_000 },
    );
    await expect(jobStatus).toContainText(/已用时间/, { timeout: 15_000 });

    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toContainText('已完成');
    await expect(work).toContainText('100%');
  });

  test('failed generation is retried successfully', async () => {
    const avatarName = 'E2E Retry Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Failure scenario test.');
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });

    comfyMock.failNext();
    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'failed');
    expect(comfyMock.submittedPromptIds.length).toBe(previousCount + 1);

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const failedWork = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(failedWork).toBeVisible();
    const worksBefore = await page!.locator('.works-list article').count();

    await page!.click('button:has-text("重试")');

    await expect
      .poll(
        async () => page!.locator('.works-list article').count(),
        { timeout: 30_000 },
      )
      .toBe(worksBefore + 1);

    let retryWork: { id: string; status: string; metadata?: { retryOf?: string } } | undefined;
    await expect
      .poll(
        async () => {
         const works = await page!.evaluate(() => (window as unknown as SmoGlobal).smo.works.list());
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
    await waitForStableStatus(page!, retryWork!.id, 'done');
    expect(comfyMock.submittedPromptIds.length).toBe(previousCount + 2);
  });

  test('deletes a completed work and removes the output video file', async () => {
    const avatarName = 'E2E Delete Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Deletion removes the record and the video.');
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');

    const workOutputDirectory = join(outputDirectory, 'SMO-H3', jobId);
    const outputName = (await readdir(workOutputDirectory)).find((name) =>
      name.endsWith('.mp4'),
    );
    expect(outputName).toBeDefined();
    const videoPath = join(workOutputDirectory, outputName!);
    expect(existsSync(videoPath)).toBe(true);

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');

    await work.getByRole('button', { name: `删除作品 ${jobId}` }).click();
    const dialog = page!.getByRole('dialog', { name: '删除作品' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(avatarName);
    await expect(dialog).toContainText(outputName!);
    await dialog.getByRole('button', { name: '确认删除' }).click();

    await expect(work).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(existsSync(videoPath)).toBe(false);

    const avatarPhotos = await readdir(join(dataDirectory, 'avatars'));
    expect(avatarPhotos.length).toBeGreaterThan(0);
    for (const photo of avatarPhotos) {
      expect(existsSync(join(dataDirectory, 'avatars', photo))).toBe(true);
    }
  });

  test('restart preserves avatar, works and LLM config', async () => {
    const avatarName = 'E2E Restart Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Restart persistence test.');
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');

    await app!.close();
    app = undefined;
    page = undefined;

    app = await launchApp({
      dataDirectory,
      outputDirectory,
      userDataDir,
      comfyBaseUrl: comfyMock.baseUrl,
      fileDialogPaths: [],
    });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await expect(page).toHaveTitle('SMO.H3 Studio');

    // no array reset: logs must persist across the restart

    await page.click('nav[aria-label="主导航"] button:has-text("数字模特")');
    await expect(page.locator('.avatar-list')).toContainText(avatarName);

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');

    await page.click('nav[aria-label="主导航"] button:has-text("设置")');
    await expect(page.locator('#llm-base-url')).toHaveValue(`${llmMock.baseUrl}/v1`);
    await expect(page.locator('#llm-model')).toHaveValue('model-a');
    await expect(page.locator('#llm-api-key')).toHaveValue('');

    const requestsBefore = llmMock.requests.length;
    await page.click('button:has-text("测试模型")');
    await expect(page.locator('text=测试通过')).toBeVisible({ timeout: 15_000 });

    const testRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(testRequest).toBeDefined();
    expect(testRequest!.authorization).toBe(`Bearer ${TEST_LLM_API_KEY}`);
  });

  test('no layout regressions on main views', async () => {
    const testInfo = test.info();
    await expect(page!.locator('.app-shell')).toBeVisible();
    await expect(page!.locator('.window-titlebar')).toBeVisible();
    await expect(
      page!.getByRole('button', { name: '最小化', exact: true }),
    ).toBeVisible();
    await expect(
      page!.getByRole('button', { name: /^(最大化|还原)$/ }),
    ).toBeVisible();
    await expect(
      page!.getByRole('button', { name: '关闭', exact: true }),
    ).toBeVisible();
    await createAvatar(page!, 'E2E Layout Avatar');

    const viewports = [
      { width: 1280, height: 820 },
      { width: 960, height: 640 },
    ];

    for (const viewport of viewports) {
      await setViewport(app!, page!, viewport.width, viewport.height);

      // The rounded frame fills the viewport; tolerate the same fractional-DPI
      // rounding (0-2 px) that setViewport observes on a 1.75 scale display.
      const frameRect = await page!.evaluate(() => {
        const element = document.querySelector('.app-frame');
        if (!element) {
          return null;
        }
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        };
      });
      expect(frameRect).not.toBeNull();
      expect(frameRect!.left).toBe(0);
      expect(frameRect!.top).toBe(0);
      expect(
        Math.abs(frameRect!.right - frameRect!.innerWidth),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(frameRect!.bottom - frameRect!.innerHeight),
      ).toBeLessThanOrEqual(2);

      await page!.click('nav[aria-label="主导航"] button:has-text("制作台")');
      // The studio preserves the previously selected mode, so switch back to
      // text mode explicitly instead of relying on an implicit reset.
      await page!.click('#text-mode-tab');
      await expect(page!.locator('#text-mode-panel')).toBeVisible();
      await assertViewLayout(page!, 'studio-text', [
        '#original-text',
        '#polished-tab',
        '#text-mode-panel .button-generate',
      ]);

      await page!.click('#audio-mode-tab');
      await expect(page!.locator('#audio-mode-panel')).toBeVisible();
      await assertViewLayout(page!, 'studio-audio', [
        '#audio-mode-tab',
        '#audio-mode-panel .button-generate',
      ]);

      await page!.click('nav[aria-label="主导航"] button:has-text("数字模特")');
      await expect(page!.locator('.avatar-list')).toBeVisible();
      await assertViewLayout(page!, 'avatars', [
        '#avatar-name',
        '.avatar-form .button-primary',
        '.avatar-list',
      ]);

      await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
      await expect(page!.locator('.works-filters')).toBeVisible();
      await assertViewLayout(page!, 'works', [
        '.works-filters',
        '.page-header .button-secondary',
      ]);

      await page!.click('nav[aria-label="主导航"] button:has-text("设置")');
      await expect(page!.locator('#llm-base-url')).toBeVisible();
      await assertViewLayout(page!, 'settings', [
        '#llm-base-url',
        '#llm-model',
        '.settings-actions .button-primary',
      ]);

      await page!.click('nav[aria-label="主导航"] button:has-text("制作台")');
      // We left the studio in audio mode; the mode must be preserved.
      await expect(page!.locator('#audio-mode-panel')).toBeVisible();
      await page!.click('#text-mode-tab');
      await expect(page!.locator('#text-mode-panel')).toBeVisible();
      await page!.screenshot({
        path: testInfo.outputPath(`studio-${viewport.width}x${viewport.height}.png`),
      });
    }
  });

  test('settings layout handles narrow viewport at 200% zoom', async () => {
    await expect(page!.locator('.app-shell')).toBeVisible();
    await createAvatar(page!, 'E2E Zoom Avatar');
    await setZoomedViewport(app!, page!, 400, 320);

    await page!.click('nav[aria-label="主导航"] button:has-text("设置")');
    await expect(page!.locator('#llm-base-url')).toBeVisible();

    const violations = await page!.evaluate(() => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const results: Array<{
        type: string;
        index?: number;
        width?: number;
        right?: number;
        message: string;
      }> = [];
      if (document.documentElement.scrollWidth > viewport.width) {
        results.push({
          type: 'document-overflow',
          message: `scrollWidth ${document.documentElement.scrollWidth} > innerWidth ${viewport.width}`,
        });
      }
      document.querySelectorAll('.settings-section').forEach((element, index) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 100) {
          results.push({ type: 'too-narrow', index, width: rect.width, message: `section ${index} width ${rect.width}` });
        }
        if (rect.right > viewport.width + 0.5) {
          results.push({
            type: 'overflow-right',
            index,
            right: rect.right,
            message: `section ${index} right ${rect.right} > viewport ${viewport.width}`,
          });
        }
      });
      return results;
    });
    expect(violations).toEqual([]);
  });
});
