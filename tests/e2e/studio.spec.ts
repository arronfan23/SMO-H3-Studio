import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { startComfyMock } from '../fixtures/mock-comfy';
import { startLlmMock } from '../fixtures/mock-llm';
import { writeReadyEnvironment } from '../fixtures/ready-environment';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';
import { Store } from '../../src/main/store';
import { convertAudio } from '../../src/main/audio-converter';

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
    'testsrc=duration=1:size=400x800:rate=1',
    '-vframes',
    '1',
    imagePath,
  ]);
  await execFileAsync(FFMPEG_PATH, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:duration=8',
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
  appPath?: string;
}

async function launchApp(options: LaunchAppOptions): Promise<ElectronApplication> {
  const appPath = options.appPath ?? join(__dirname, '../../dist/main/index.js');
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

async function createImageServiceProbeEntry(): Promise<string> {
  const sourcePath = join(__dirname, '../../dist/main/index.js');
  const source = await readFile(sourcePath, 'utf8');
  const needle = 'const services = await bootstrapApplication(';
  if (!source.includes(needle)) {
    throw new Error('Could not locate the application services bootstrap in the test build');
  }
  const probePath = join(
    __dirname,
    `../../dist/main/image-service-probe-${process.pid}.js`,
  );
  await writeFile(
    probePath,
    source.replace(
      needle,
      'const services = process.__smoImageE2eServices = await bootstrapApplication(',
    ),
    'utf8',
  );
  return probePath;
}

async function installImageBackendProbe(
  app: ElectronApplication,
  options: { outputDirectory: string; pngBase64: string },
): Promise<void> {
  await expect.poll(() =>
    app.evaluate(() => Object.hasOwn(process, '__smoImageE2eServices')),
  ).toBe(true);
  await app.evaluate(async (_electron, { outputDirectory, pngBase64 }) => {
    type Graph = Record<string, { inputs: Record<string, unknown> }>;
    type ProbeServices = {
      components: { getState: (id: 'speech' | 'image') => unknown };
      comfy: {
        uploadFile: (input: {
          filePath: string;
          kind: 'image' | 'audio';
        }) => Promise<string>;
        submit: (graph: Graph) => Promise<{
          prompt_id: string;
          number: number;
          node_errors: Record<string, never>;
        }>;
        waitForCompletion: (promptId: string) => Promise<void>;
        history: (promptId: string) => Promise<Array<{
          nodeId: string;
          kind: 'images';
          filename: string;
          subfolder: string;
          type: 'output';
        }>>;
      };
    };
    const probeGlobal = process as unknown as {
      __smoImageE2eServices?: ProbeServices;
      __smoImageE2eGraph?: Graph;
      __smoImageE2eUploads?: Array<{ filePath: string; kind: string }>;
    };
    const services = probeGlobal.__smoImageE2eServices;
    if (!services) {
      throw new Error('Image E2E service probe is unavailable');
    }
    const originalGetState = services.components.getState.bind(services.components);
    services.components.getState = (id) =>
      id === 'image'
        ? {
            id,
            status: 'ready',
            downloadedBytes: 1,
            totalBytes: 1,
            currentFile: null,
            error: null,
            active: false,
          }
        : originalGetState(id);

    let workId = '';
    services.comfy.uploadFile = async ({ filePath, kind }) => {
      const uploads = probeGlobal.__smoImageE2eUploads ??= [];
      uploads.push({ filePath, kind });
      return `uploaded-${uploads.length}.png`;
    };
    services.comfy.submit = async (graph) => {
      const prefix = graph['461']?.inputs.filename_prefix;
      if (typeof prefix !== 'string') {
        throw new Error('Image output prefix is missing from the submitted graph');
      }
      workId = prefix.slice(prefix.lastIndexOf('/') + 1);
      probeGlobal.__smoImageE2eGraph = structuredClone(graph);
      const { mkdir, writeFile } = process.getBuiltinModule('node:fs/promises');
      const { join } = process.getBuiltinModule('node:path');
      const directory = join(outputDirectory, 'SMO-Image');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${workId}_00001.png`),
        Buffer.from(pngBase64, 'base64'),
      );
      return { prompt_id: 'image-e2e-prompt', number: 1, node_errors: {} };
    };
    services.comfy.waitForCompletion = async () => undefined;
    services.comfy.history = async () => [
      {
        nodeId: '461',
        kind: 'images',
        filename: `${workId}_00001.png`,
        subfolder: 'SMO-Image',
        type: 'output',
      },
    ];
  }, options);
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

function readWindowBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) {
      throw new Error('No BrowserWindow found');
    }
    return win.getBounds();
  });
}

async function assertViewLayout(
  page: Page,
  viewName: string,
  selectors: string[],
  textAssertions: Array<{ selector: string; text: string }> = [],
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

  const overlapViolations = await page.evaluate(({ view, selectors: targets }) => {
    const rects = targets.map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect === undefined
        ? { selector, rect: null }
        : {
            selector,
            rect: {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            },
          };
    });
    const results: Array<{ view: string; first: string; second: string }> = [];
    for (let first = 0; first < rects.length; first += 1) {
      for (let second = first + 1; second < rects.length; second += 1) {
        const a = rects[first];
        const b = rects[second];
        if (a.rect === null || b.rect === null) continue;
        const overlapWidth = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        const overlapHeight = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (overlapWidth > 2 && overlapHeight > 2) {
          results.push({ view, first: a.selector, second: b.selector });
        }
      }
    }
    return results;
  }, { view: viewName, selectors });
  expect(overlapViolations).toEqual([]);

  for (const assertion of textAssertions) {
    const locator = page.locator(assertion.selector);
    await expect(locator, `${viewName}: ${assertion.text}`).toBeVisible();
    await expect(locator, `${viewName}: ${assertion.text}`).toHaveText(assertion.text);
  }
}

async function assertCurrentOptionText(
  page: Page,
  viewName: string,
  selector: string,
  expectedText: string,
): Promise<void> {
  const select = page.locator(selector);
  await expect(select, `${viewName}: select visible`).toBeVisible();
  await expect(select, `${viewName}: select value`).not.toHaveValue('');

  const metrics = await select.evaluate((element) => {
    const selectElement = element as HTMLSelectElement;
    const option = selectElement.selectedOptions[0];
    if (!option) {
      throw new Error('No selected option');
    }
    const selectStyle = getComputedStyle(element);
    const optionStyle = getComputedStyle(option);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas text measurement is unavailable');
    }
    context.font = `${optionStyle.fontStyle} ${optionStyle.fontWeight} ${optionStyle.fontSize} ${optionStyle.fontFamily}`;
    const optionText = option.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const optionRow = selectElement.closest('.image-option-row');
    const horizontalPadding =
      Number.parseFloat(selectStyle.paddingLeft) +
      Number.parseFloat(selectStyle.paddingRight);
    return {
      optionText,
      optionVisibility: optionStyle.visibility,
      optionDisplay: optionStyle.display,
      viewportWidth: window.innerWidth,
      selectWidth: selectElement.clientWidth,
      optionRowColumns: optionRow === null ? null : getComputedStyle(optionRow).gridTemplateColumns,
      textWidth: context.measureText(optionText).width,
      availableTextWidth: selectElement.clientWidth - horizontalPadding - 28,
    };
  });

  expect(metrics.optionText, `${viewName}: complete option text`).toBe(expectedText);
  expect(metrics.optionVisibility, `${viewName}: option visibility`).toBe('visible');
  expect(metrics.optionDisplay, `${viewName}: option display`).not.toBe('none');
  expect(metrics.availableTextWidth, `${viewName}: text space`).toBeGreaterThan(0);
  expect(metrics.textWidth, `${viewName}: ${JSON.stringify(metrics)}`)
    .toBeLessThanOrEqual(metrics.availableTextWidth + 2);
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

function seedSpeechWork(options: {
  dataDirectory: string;
  id: string;
  outputPath: string;
}): void {
  const store = new Store(join(options.dataDirectory, 'studio.sqlite'));
  try {
    store.addWork({
      id: options.id,
      avatarId: null,
      mode: 'speech',
      outputPath: options.outputPath,
      status: 'done',
      title: '模拟语音作品',
      completedAt: new Date().toISOString(),
      metadata: null,
      error: null,
    });
  } finally {
    store.close();
  }
}

async function saveLlmProfile(page: Page, baseUrl: string): Promise<void> {
  await page.click('nav[aria-label="主导航"] button:has-text("设置")');
  await expect(page.locator('#llm-base-url')).toBeVisible();
  await page.fill('#llm-base-url', `${baseUrl}/v1`);
  await page.fill('#llm-model', 'model-a');
  await page.fill('#llm-api-key', TEST_LLM_API_KEY);
  await page.click('#llm-save-profile');
  await expect(page.locator('h3:has-text("已配置 LLM")')).toBeVisible();
  await expect(page.locator('#llm-api-key')).toHaveValue('');
}

async function openStudio(page: Page, avatarName?: string): Promise<void> {
  const parent = page.locator('#studio-nav-button');
  if (await parent.getAttribute('aria-expanded') !== 'true') {
    await parent.click();
  }
  await page.locator('#studio-video-button').click();
  if (avatarName !== undefined) {
    await expect(
      page.locator(`.person-preview h2:has-text("${avatarName}")`),
    ).toBeVisible();
  } else {
    await expect(page.locator('#text-mode-panel')).toBeVisible();
  }
}

async function selectCurrentAvatarReference(page: Page): Promise<void> {
  await page.click('#reference-mode-tab');
  await page.click('#reference-mode-panel button:has-text("使用当前模特")');
  await expect(page.locator('#reference-mode-panel .reference-image-count'))
    .toHaveText('1 / 9');
}

async function assertStudioAvatarLayout(page: Page, viewName: string): Promise<void> {
  const image = page.locator('.person-preview .avatar-image img');
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  await expect(page.locator('.person-preview .reference-label')).toHaveCount(0);
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);

  const layout = await page.evaluate(() => {
    const imageElement = document.querySelector<HTMLImageElement>(
      '.person-preview .avatar-image img',
    );
    const container = document.querySelector<HTMLElement>('.person-preview .avatar-image');
    if (!imageElement || !container) {
      return null;
    }
    const imageRect = imageElement.getBoundingClientRect();
    const imageStyle = getComputedStyle(imageElement);
    const containerStyle = getComputedStyle(container);
    return {
      naturalRatio: imageElement.naturalWidth / imageElement.naturalHeight,
      renderedRatio: imageRect.width / imageRect.height,
      objectFit: imageStyle.objectFit,
      containerAspectRatio: containerStyle.aspectRatio,
      containerOverflow: containerStyle.overflow,
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
    };
  });

  expect(layout, viewName).not.toBeNull();
  expect(layout!.naturalRatio, viewName).toBeCloseTo(0.5, 2);
  expect(layout!.renderedRatio, viewName).toBeCloseTo(layout!.naturalRatio, 2);
  expect(layout!.objectFit, viewName).toBe('contain');
  expect(layout!.containerAspectRatio, viewName).toBe('auto');
  expect(layout!.containerOverflow, viewName).toBe('visible');
  expect(layout!.documentOverflow, viewName).toBe(false);
}

async function readVisibleTextJobId(page: Page): Promise<string> {
  const jobId = page.locator(
    '#text-mode-panel section[aria-label="任务状态"]:visible code',
  );
  await expect(jobId).toHaveText(/^[0-9a-f-]{36}$/);
  return (await jobId.textContent())!;
}

async function readVisibleReferenceJobId(page: Page): Promise<string> {
  const jobId = page.locator(
    '#reference-mode-panel section[aria-label="任务状态"]:visible code',
  );
  await expect(jobId).toHaveText(/^[0-9a-f-]{36}$/);
  return (await jobId.textContent())!;
}

function expectNoLlmPathLeaks(
  messages: ReadonlyArray<{ role: string; content: string }>,
  sensitivePaths: readonly string[],
): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const [messageIndex, message] of messages.entries()) {
    const normalizedContent = message.content.replaceAll('\\', '/');
    for (const sensitivePath of sensitivePaths) {
      const directory = dirname(sensitivePath);
      const context = `message ${messageIndex} (${message.role})`;
      expect(message.content, `${context}: native path`).not.toContain(sensitivePath);
      expect(message.content, `${context}: native dirname`).not.toContain(directory);
      expect(normalizedContent, `${context}: POSIX path`)
        .not.toContain(sensitivePath.replaceAll('\\', '/'));
      expect(normalizedContent, `${context}: POSIX dirname`)
        .not.toContain(directory.replaceAll('\\', '/'));
    }
  }
}

function reachableImageNodeIds(
  graph: Record<string, { inputs: Record<string, unknown> }>,
  entryId: string,
): Set<string> {
  const reachable = new Set<string>();
  const visitInput = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'number'
    ) {
      visitNode(value[0]);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const nested of Object.values(value)) visitInput(nested);
    }
  };
  const visitNode = (id: string): void => {
    if (reachable.has(id) || !graph[id]) return;
    reachable.add(id);
    visitInput(graph[id].inputs);
  };
  visitNode(entryId);
  return reachable;
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
  let imageServiceProbeEntry: string | undefined;

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
    await writeReadyEnvironment({
      dataDirectory,
      installRoot: join(root, 'environment'),
      modelDirectory: DEFAULT_MODEL_DIRECTORY,
      outputDirectory,
    });
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
    page = await app.firstWindow().catch((error: unknown) => {
      console.error(
        mainProcessRaw.map((chunk) => typeof chunk === 'string' ? chunk : chunk.toString()).join(''),
      );
      throw error;
    });
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
      if (imageServiceProbeEntry) {
        await rm(imageServiceProbeEntry, { force: true });
        imageServiceProbeEntry = undefined;
      }
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

  test('二级制作目录支持键盘导航、切页和收起草稿保留', async () => {
    const avatarName = 'E2E Sidebar Avatar';
    await createAvatar(page!, avatarName);
    await openStudio(page!, avatarName);
    await page!.fill('#original-text', 'Keep the video draft from the sidebar.');

    const parent = page!.locator('#studio-nav-button');
    await expect(parent).toHaveAttribute('aria-expanded', 'true');
    await expect(parent).toHaveAttribute('aria-controls', 'studio-mode-navigation');
    await page!.locator('#studio-image-button').click();
    await expect(page!.locator('#image-main-panel')).toBeVisible();
    await expect(page!.locator('#studio-image-button')).toHaveAttribute('aria-current', 'page');
    await page!.fill('#image-prompt', 'Keep the image draft while collapsed.');

    await parent.focus();
    await page!.keyboard.press('Enter');
    await expect(parent).toHaveAttribute('aria-expanded', 'false');
    await expect(parent).toBeFocused();
    await expect(page!.locator('#studio-mode-navigation')).toBeHidden();
    await expect(page!.locator('#image-prompt')).toHaveValue(
      'Keep the image draft while collapsed.',
    );

    await page!.keyboard.press('Enter');
    await expect(parent).toHaveAttribute('aria-expanded', 'true');
    await page!.keyboard.press('Tab');
    await expect(page!.locator('#studio-speech-button')).toBeFocused();
    await page!.keyboard.press('Tab');
    await expect(page!.locator('#studio-image-button')).toBeFocused();
    await page!.keyboard.press('Enter');
    await expect(page!.locator('#image-main-panel')).toBeVisible();
    await expect(page!.locator('#studio-image-button')).toBeFocused();

    await page!.click('nav[aria-label="主导航"] button:has-text("设置")');
    await page!.locator('#studio-video-button').click();
    await expect(page!.locator('#text-mode-panel')).toBeVisible();
    await expect(page!.locator('#original-text')).toHaveValue(
      'Keep the video draft from the sidebar.',
    );
    await expect(page!.getByRole('tablist', { name: '主制作模式' })).toHaveCount(0);
    await expect(page!.getByRole('tablist', { name: '制作模式' })).toBeVisible();
  });

  test('keeps studio draft across navigation', async () => {
    const draft = 'Keep this draft across every module.';
    await createAvatar(page!, 'E2E Draft Avatar');
    await openStudio(page!, 'E2E Draft Avatar');
    await page!.fill('#original-text', draft);

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      await page!.click(`nav[aria-label="主导航"] button:has-text("${moduleName}")`);
      await page!.locator('#studio-video-button').click();
      await expect(page!.locator('#original-text')).toHaveValue(draft);
    }
  });

  test('视频子模式切换与页面导航保留完整草稿', async () => {
    const avatarName = 'E2E Video Draft Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Original text video draft.');
    await page!.fill('#text-steps', '11');
    await selectCurrentAvatarReference(page!);
    await page!.fill('#reference-original-text', 'Original reference video draft.');
    await page!.fill('#reference-steps', '12');
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-text')).toBeVisible({ timeout: 30_000 });
    await page!.fill('#reference-polished-text', 'Edited reference video polished draft.');

    await page!.click('#audio-mode-tab');
    await page!.click('#audio-mode-panel button:has-text("选择音频")');
    await expect(page!.locator('.audio-file')).toContainText('voice.mp3');
    await page!.waitForFunction(() => {
      const audio = document.querySelector<HTMLAudioElement>('#audio-mode-panel audio');
      return audio !== null && Number.isFinite(audio.duration) && audio.duration > 0;
    });
    await page!.fill('#audio-prompt', 'Original audio video draft.');
    await page!.fill('#audio-steps', '9');
    await page!.click('#audio-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#audio-polished-text')).toBeVisible({ timeout: 30_000 });
    await page!.fill('#audio-polished-text', 'Edited audio video polished draft.');

    await page!.click('#text-mode-tab');
    await expect(page!.locator('#original-text')).toHaveValue('Original text video draft.');
    await expect(page!.locator('#text-steps')).toHaveValue('11');
    await page!.click('#reference-mode-tab');
    await expect(page!.locator('#reference-polished-text')).toHaveValue(
      'Edited reference video polished draft.',
    );
    await expect(page!.locator('#reference-steps')).toHaveValue('12');
    await page!.click('#reference-original-tab');
    await expect(page!.locator('#reference-original-text')).toHaveValue(
      'Original reference video draft.',
    );
    await page!.click('#reference-polished-tab');

    await page!.click('#audio-mode-tab');
    await expect(page!.locator('.audio-file')).toContainText('voice.mp3');
    await expect(page!.locator('#audio-polished-text')).toHaveValue(
      'Edited audio video polished draft.',
    );
    await expect(page!.locator('#audio-steps')).toHaveValue('9');
    await page!.click('#audio-original-tab');
    await expect(page!.locator('#audio-prompt')).toHaveValue('Original audio video draft.');
    await page!.click('#audio-polished-tab');

    for (const moduleName of ['数字模特', '我的作品', '设置']) {
      await page!.click(`nav[aria-label="主导航"] button:has-text("${moduleName}")`);
      await page!.locator('#studio-video-button').click();
      await expect(page!.locator('#audio-mode-panel')).toBeVisible();
      await expect(page!.locator('.audio-file')).toContainText('voice.mp3');
      await expect(page!.locator('#audio-polished-text')).toHaveValue(
        'Edited audio video polished draft.',
      );
      await expect(page!.locator('#audio-steps')).toHaveValue('9');
    }

    await page!.click('#reference-mode-tab');
    await expect(page!.locator('#reference-polished-text')).toHaveValue(
      'Edited reference video polished draft.',
    );
    await expect(page!.locator('#reference-steps')).toHaveValue('12');
    await page!.click('#text-mode-tab');
    await expect(page!.locator('#text-steps')).toHaveValue('11');
    await expect(page!.locator('#original-text')).toHaveValue('Original text video draft.');

    await page!.click('#audio-mode-tab');
    await page!.click('#audio-original-tab');
    await expect(page!.locator('#audio-prompt')).toHaveValue('Original audio video draft.');
  });

  for (const format of ['wav', 'mp3', 'flac', 'm4a'] as const) {
    test(`用于音频数字人 ${format} 真实音频可预览并提交生成`, async () => {
      const avatarName = `E2E Speech Work ${format}`;
      await createAvatar(page!, avatarName);
      await openStudio(page!, avatarName);
      await page!.fill('#original-text', 'Keep text video draft.');
      await page!.fill('#text-steps', '13');
      await page!.click('#audio-mode-tab');
      await page!.fill('#audio-prompt', 'Keep audio video draft.');
      await page!.fill('#audio-steps', '17');
      await page!.click('#studio-speech-button');
      await page!.fill('#custom-speech-prompt', 'Keep speech draft.');
      await page!.fill('#custom-speech-instruct', 'Calm and warm.');

      const speechDirectory = join(outputDirectory, 'SMO-Speech');
      const speechPath = join(speechDirectory, `mock-speech.${format}`);
      await mkdir(speechDirectory, { recursive: true });
      await convertAudio({
        ffmpegPath: FFMPEG_PATH,
        sourcePath: launchOptions.fileDialogPaths[2],
        destinationPath: speechPath,
        format,
      });
      const workId = `mock-speech-work-${format}`;
      seedSpeechWork({ dataDirectory, id: workId, outputPath: speechPath });
      const submittedBefore = comfyMock.submittedPromptIds.length;

      await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
      const work = page!.locator('.works-list article').filter({ hasText: workId });
      await expect(work).toBeVisible();
      await work.getByRole('button', { name: `用于音频数字人 ${workId}` }).click();

      await expect(page!.locator('#studio-video-button')).toHaveAttribute('aria-current', 'page');
      await expect(page!.locator('#audio-mode-tab')).toHaveAttribute('aria-selected', 'true');
      await expect(page!.locator('#audio-mode-tab')).toBeFocused();
      await expect(page!.locator('#audio-mode-panel')).toBeVisible();
      await expect(page!.locator('.audio-file')).toContainText(`mock-speech.${format}`);
      const selectedAudio = page!.locator('#audio-mode-panel audio[aria-label="所选音频"]');
      await expect(selectedAudio).toHaveAttribute('src', /^smo-media:\/\//);
      await expect
        .poll(() =>
          selectedAudio.evaluate((element) => (element as HTMLAudioElement).duration),
        )
        .toBeGreaterThan(0);
      const seconds = await selectedAudio.evaluate(
        (element) => (element as HTMLAudioElement).duration,
      );
      expect(Number.isFinite(seconds)).toBe(true);
      expect(seconds).toBeGreaterThan(7.5);
      expect(seconds).toBeLessThan(8.5);
      expect(Number(await page!.locator('#audio-duration').inputValue())).toBeCloseTo(seconds, 5);
      await expect(page!.locator('#audio-prompt')).toHaveValue('Keep audio video draft.');
      await expect(page!.locator('#audio-steps')).toHaveValue('17');

      await page!.click('#text-mode-tab');
      await expect(page!.locator('#original-text')).toHaveValue('Keep text video draft.');
      await expect(page!.locator('#text-steps')).toHaveValue('13');
      await page!.click('#studio-speech-button');
      await expect(page!.locator('#custom-speech-prompt')).toHaveValue('Keep speech draft.');
      await expect(page!.locator('#custom-speech-instruct')).toHaveValue('Calm and warm.');
      expect(comfyMock.submittedPromptIds).toHaveLength(submittedBefore);

      await page!.click('#studio-video-button');
      await page!.click('#audio-mode-tab');
      await page!.click('#audio-mode-panel button:has-text("生成视频")');
      const jobLocator = page!.locator(
        '#audio-mode-panel section[aria-label="任务状态"]:visible code',
      );
      await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
      const jobId = (await jobLocator.textContent())!;
      await waitForStableStatus(page!, jobId, 'done');
      expect(comfyMock.submittedPromptIds).toHaveLength(submittedBefore + 1);
      const submitted = comfyMock.submittedPrompts[submittedBefore];
      const promptNode = submitted.prompt['42'] as { inputs: { prompt: string } };
      expect(promptNode.inputs.prompt).toBe('Keep audio video draft.');
    });
  }

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

  test('无模特文生完成 T2VA 原文与润色后生成', async () => {
    const originalText = 'A quiet studio shot with no reference image.';
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!);

    await expect(page!.locator('.studio-layout-without-avatar')).toBeVisible();
    await expect(page!.locator('.person-preview')).toHaveCount(0);
    await expect(page!.locator('#video-main-panel .empty-state:visible')).toHaveCount(0);
    await expect(page!.locator('#original-text')).toBeEditable();
    await expect(page!.locator('#text-mode-panel .button-generate')).toBeEnabled();

    await page!.fill('#original-text', originalText);
    await page!.fill('#text-duration', '7');
    await page!.fill('#text-seed', '314');
    await page!.fill('#text-steps', '9');
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const originalJobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, originalJobId, 'done');

    expect(comfyMock.uploadedImages).toEqual([]);
    expect(comfyMock.submittedPrompts).toHaveLength(1);
    const originalGraph = comfyMock.submittedPrompts[0].prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(originalGraph['136'].class_type).toBe('MiniMaxH3ImageToVideo');
    expect(originalGraph['136'].inputs.prompt).toBe(originalText);
    expect(originalGraph['136'].inputs).not.toHaveProperty('audio_vae');
    expect(originalGraph['136'].inputs).not.toHaveProperty('ref_image_size');
    expect(originalGraph['136'].inputs).not.toHaveProperty('ref_images');
    expect(
      Object.keys(originalGraph['136'].inputs).filter((key) =>
        key.startsWith('ref_images.'),
      ),
    ).toEqual([]);
    expect(originalGraph['226']).toBeUndefined();
    expect(originalGraph['132'].inputs.value).toBe(7);
    expect(originalGraph['269'].inputs.seed).toBe(314);
    expect(originalGraph['124'].inputs.steps).toBe(9);
    expect(originalGraph['180'].inputs.filename_prefix).toBe(
      `SMO-H3/${originalJobId}`,
    );
    const originalMp4 = (await readdir(
      join(outputDirectory, 'SMO-H3', originalJobId),
    )).find((name) => name.endsWith('.mp4'));
    expect(originalMp4).toBeDefined();

    const requestsBefore = llmMock.requests.length;
    await page!.click('#text-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    await expect(page!.locator('#polished-tab')).toHaveAttribute('aria-selected', 'true');
    const polishedResult = await page!.inputValue('#polished-text');
    expect(polishedResult).toContain('integrated_multimodal_description:');
    const llmRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(llmRequest).toBeDefined();
    const llmBody = JSON.parse(llmRequest!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const llmUserContent = llmBody.messages.find(
      (message) => message.role === 'user',
    )?.content;
    expect(llmUserContent).toContain('Input mode: T2VA.');
    expect(llmUserContent).toContain('Reference labels: None.');
    expect(comfyMock.submittedPrompts).toHaveLength(1);

    const editedPrompt = 'Edited T2VA polished prompt for the second generation.';
    await page!.fill('#polished-text', editedPrompt);
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const polishedJobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, polishedJobId, 'done');

    expect(comfyMock.uploadedImages).toEqual([]);
    expect(comfyMock.submittedPrompts).toHaveLength(2);
    const polishedGraph = comfyMock.submittedPrompts[1].prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(polishedGraph['136'].class_type).toBe('MiniMaxH3ImageToVideo');
    expect(polishedGraph['136'].inputs.prompt).toBe(editedPrompt);
    expect(polishedGraph['136'].inputs).not.toHaveProperty('audio_vae');
    expect(polishedGraph['136'].inputs).not.toHaveProperty('ref_image_size');
    expect(polishedGraph['136'].inputs).not.toHaveProperty('ref_images');
    expect(
      Object.keys(polishedGraph['136'].inputs).filter((key) =>
        key.startsWith('ref_images.'),
      ),
    ).toEqual([]);
    expect(polishedGraph['226']).toBeUndefined();
    expect(polishedGraph['132'].inputs.value).toBe(7);
    expect(polishedGraph['269'].inputs.seed).toBe(314);
    expect(polishedGraph['124'].inputs.steps).toBe(9);
    expect(polishedGraph['180'].inputs.filename_prefix).toBe(
      `SMO-H3/${polishedJobId}`,
    );
    const polishedMp4 = (await readdir(
      join(outputDirectory, 'SMO-H3', polishedJobId),
    )).find((name) => name.endsWith('.mp4'));
    expect(polishedMp4).toBeDefined();

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    for (const [jobId, outputName] of [
      [originalJobId, originalMp4],
      [polishedJobId, polishedMp4],
    ] as const) {
      expect(existsSync(join(outputDirectory, 'SMO-H3', jobId, outputName!))).toBe(true);
      const work = page!.locator('.works-list article').filter({ hasText: jobId });
      await expect(work).toContainText('已完成');
      await expect(work.locator('video')).toBeVisible();
    }
  });

  test('1 图显式当前模特使用 Ref2VA 且只上传一张', async () => {
    const avatarName = 'E2E Text Avatar';
    const originalText = 'The current avatar waves in one explicit reference.';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await page!.fill('#original-text', 'Independent text-mode draft.');
    await page!.fill('#text-steps', '11');
    await page!.click('#reference-mode-tab');
    await expect(page!.locator('#reference-original-text')).toHaveValue('');
    await expect(page!.locator('#original-text')).toHaveValue(
      'Independent text-mode draft.',
    );
    await expect(page!.locator('#reference-mode-panel .reference-image-count'))
      .toHaveText('0 / 9');
    await expect(page!.locator('#reference-mode-panel .reference-image-preview img'))
      .toHaveCount(0);

    await page!.click('#reference-mode-panel button:has-text("使用当前模特")');
    await expect(page!.locator('#reference-mode-panel .reference-image-count'))
      .toHaveText('1 / 9');
    await expect(page!.locator('#reference-mode-panel .reference-image-preview img'))
      .toHaveCount(1);
    const [avatarPhotoName] = await readdir(join(dataDirectory, 'avatars'));
    expect(avatarPhotoName).toMatch(/^[0-9a-f-]{36}\.png$/);
    const managedAvatarPath = join(dataDirectory, 'avatars', avatarPhotoName);
    await expect(page!.locator('#reference-mode-panel .reference-image-filename'))
      .toHaveText(avatarPhotoName);
    expect(comfyMock.uploadedImages).toEqual([]);

    await page!.fill('#reference-original-text', originalText);
    await page!.fill('#reference-duration', '6');
    await page!.fill('#reference-seed', '271');
    await page!.fill('#reference-steps', '10');
    await page!.click('#text-mode-tab');
    await expect(page!.locator('#original-text')).toHaveValue(
      'Independent text-mode draft.',
    );
    await expect(page!.locator('#text-steps')).toHaveValue('11');
    await page!.click('#reference-mode-tab');
    await expect(page!.locator('#reference-original-text')).toHaveValue(originalText);
    await expect(page!.locator('#reference-mode-panel .reference-image-count'))
      .toHaveText('1 / 9');

    const requestsBefore = llmMock.requests.length;
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });
    await expect(page!.locator('#reference-polished-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const polishedText = await page!.inputValue('#reference-polished-text');
    expect(polishedText).toContain('subject_definitions:');

    const llmRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(llmRequest).toBeDefined();
    const llmBody = JSON.parse(llmRequest!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const llmUserContent = llmBody.messages.find(
      (message) => message.role === 'user',
    )?.content;
    expect(llmUserContent).toContain('Input mode: REF2VA.');
    expect(llmUserContent).toContain('Reference labels: <Picture 1>.');
    expectNoLlmPathLeaks(llmBody.messages, [
      launchOptions.fileDialogPaths[0],
      managedAvatarPath,
    ]);

    await page!.click('#reference-original-tab');
    await expect(page!.locator('#reference-original-text')).toHaveValue(originalText);
    await page!.click('#reference-polished-tab');
    await expect(page!.locator('#reference-polished-text')).toHaveValue(polishedText);
    const editedPrompt = 'Polished one-reference prompt with no implicit second image.';
    await page!.fill('#reference-polished-text', editedPrompt);

    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);
    expect(comfyMock.uploadedImages.map((image) => image.filename)).toEqual([
      `${jobId}-0.png`,
    ]);
    const graph = comfyMock.submittedPrompts[previousCount].prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['136'].class_type).toBe('MiniMaxH3ReferenceToVideo');
    expect(graph['136'].inputs.prompt).toBe(editedPrompt);
    expect(graph['136'].inputs).not.toHaveProperty('ref_images');
    expect(
      Object.keys(graph['136'].inputs).filter((key) => key.startsWith('ref_images.')),
    ).toEqual(['ref_images.ref_image_0']);
    expect(graph['136'].inputs['ref_images.ref_image_0']).toEqual(['226', 0]);
    expect(graph['226']).toEqual({
      class_type: 'LoadImage',
      inputs: { image: `${jobId}-0.png` },
    });
    expect(graph.ref2).toBeUndefined();
    expect(graph['132'].inputs.value).toBe(6);
    expect(graph['269'].inputs.seed).toBe(271);
    expect(graph['124'].inputs.steps).toBe(10);
    expect(graph['180'].inputs.filename_prefix).toBe(`SMO-H3/${jobId}`);
    expect(await readdir(join(dataDirectory, 'uploads'))).toEqual([]);
    const outputName = (await readdir(join(outputDirectory, 'SMO-H3', jobId)))
      .find((name) => name.endsWith('.mp4'));
    expect(outputName).toBeDefined();

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work.locator('video')).toBeVisible();
    await waitForVideoReadyByJobId(page!, jobId);
  });

  test('9 张无模特参考图按顺序润色、上传并生成 Ref2VA', async () => {
    const referenceDirectory = join(tempDirectory!, 'video-references-9');
    await mkdir(referenceDirectory, { recursive: true });
    const referencePaths: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const referencePath = join(referenceDirectory, `reference-${index + 1}.png`);
      await sharp({
        create: {
          width: 96 + index,
          height: 128 + index,
          channels: 3,
          background: {
            r: 24 + index * 20,
            g: 180 - index * 12,
            b: 48 + index * 16,
          },
        },
      }).png().toFile(referencePath);
      referencePaths.push(referencePath);
    }
    const originalReferences = await Promise.all(
      referencePaths.map((referencePath) => readFile(referencePath)),
    );

    await app!.close();
    app = undefined;
    page = undefined;
    app = await launchApp({ ...launchOptions, fileDialogPaths: referencePaths });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await expect(page).toHaveTitle('SMO.H3 Studio');
    await saveLlmProfile(page, llmMock.baseUrl);
    await openStudio(page);
    await page.click('#reference-mode-tab');

    for (const index of referencePaths.keys()) {
      const selectButton = page.locator(
        '#reference-mode-panel button:has-text("选择参考图")',
      );
      await expect(selectButton).toBeEnabled();
      await selectButton.click();
      await expect(page.locator('#reference-mode-panel .reference-image-count'))
        .toHaveText(`${index + 1} / 9`);
      await expect(page.locator('#reference-mode-panel .reference-image-preview img'))
        .toHaveCount(index + 1);
      const preview = page.getByRole('img', {
        name: `参考图 ${index + 1}：reference-${index + 1}.png`,
      });
      await expect(preview).toBeVisible();
      await expect.poll(() =>
        preview.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      ).toBe(96 + index);
    }
    await expect(page.locator('#reference-mode-panel .reference-image-filename'))
      .toHaveText(referencePaths.map((_, index) => `reference-${index + 1}.png`));
    await expect(
      page.locator('#reference-mode-panel button:has-text("选择参考图")'),
    ).toBeDisabled();

    const originalText = 'Nine ordered references with no avatar and no path leakage.';
    await page.fill('#reference-original-text', originalText);
    await page.fill('#reference-duration', '11');
    await page.fill('#reference-seed', '999');
    await page.fill('#reference-steps', '12');
    const requestsBefore = llmMock.requests.length;
    await page.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });
    const llmRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(llmRequest).toBeDefined();
    const llmBody = JSON.parse(llmRequest!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const llmUserContent = llmBody.messages.find(
      (message) => message.role === 'user',
    )?.content;
    expect(llmUserContent).toContain('Input mode: REF2VA.');
    expect(llmUserContent).toContain(
      `Reference labels: ${Array.from(
        { length: 9 },
        (_, index) => `<Picture ${index + 1}>`,
      ).join(', ')}.`,
    );
    expectNoLlmPathLeaks(llmBody.messages, referencePaths);

    const editedPrompt = 'Polished nine-reference prompt in the selected order.';
    await page.fill('#reference-polished-text', editedPrompt);
    await page.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page);
    await waitForStableStatus(page, jobId, 'done');

    expect(comfyMock.submittedPrompts).toHaveLength(1);
    expect(comfyMock.uploadedImages.map((image) => image.filename)).toEqual(
      Array.from({ length: 9 }, (_, index) => `${jobId}-${index}.png`),
    );
    for (const [index, uploadedImage] of comfyMock.uploadedImages.entries()) {
      const sourceBytes = await readFile(referencePaths[index]);
      expect(sourceBytes.length).toBeGreaterThan(0);
      expect(uploadedImage.data.length).toBeGreaterThan(0);
      expect(uploadedImage.data.equals(sourceBytes)).toBe(true);
    }
    const graph = comfyMock.submittedPrompts[0].prompt as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(graph['136'].class_type).toBe('MiniMaxH3ReferenceToVideo');
    expect(graph['136'].inputs).toMatchObject({
      prompt: editedPrompt,
      ref_image_size: 'match',
      audio_vae: ['184', 0],
    });
    expect(graph['136'].inputs).not.toHaveProperty('ref_images');
    expect(
      Object.keys(graph['136'].inputs).filter((key) => key.startsWith('ref_images.')),
    ).toEqual(
      Array.from({ length: 9 }, (_, index) => `ref_images.ref_image_${index}`),
    );
    for (let index = 0; index < 9; index += 1) {
      const nodeId = index === 0 ? '226' : `ref${index + 1}`;
      expect(graph['136'].inputs[`ref_images.ref_image_${index}`]).toEqual([nodeId, 0]);
      expect(graph[nodeId]).toEqual({
        class_type: 'LoadImage',
        inputs: { image: `${jobId}-${index}.png` },
      });
    }
    expect(graph.ref1).toBeUndefined();
    expect(graph.ref10).toBeUndefined();
    expect(graph['132'].inputs.value).toBe(11);
    expect(graph['269'].inputs.seed).toBe(999);
    expect(graph['124'].inputs.steps).toBe(12);
    expect(graph['180'].inputs.filename_prefix).toBe(`SMO-H3/${jobId}`);
    expect(await readdir(join(dataDirectory, 'uploads'))).toEqual([]);
    for (const [index, referencePath] of referencePaths.entries()) {
      expect(await readFile(referencePath)).toEqual(originalReferences[index]);
    }
    const outputName = (await readdir(join(outputDirectory, 'SMO-H3', jobId)))
      .find((name) => name.endsWith('.mp4'));
    expect(outputName).toBeDefined();

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work.locator('video')).toBeVisible();
  });

  test('audio digital human', async () => {
    const avatarName = 'E2E Audio Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);
    await page!.click('#audio-mode-tab');
    await page!.click('#audio-mode-panel button:has-text("选择音频")');
    await expect(page!.locator('.audio-file')).toContainText('voice.mp3');
    await expect(page!.locator('audio[src^="smo-media://"]')).toBeVisible();
    await page!.waitForFunction(() => {
      const audio = document.querySelector('audio');
      return audio !== null && Number.isFinite(audio.duration) && audio.duration > 0;
    });

    await page!.fill('#audio-prompt', 'She speaks with a calm expression.');
    await page!.fill('#audio-trim', '1');
    await page!.fill('#audio-duration', '6');
    const requestsBefore = llmMock.requests.length;
    await page!.click('#audio-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#audio-polished-tab')).toBeEnabled({ timeout: 30_000 });
    await expect(page!.locator('#audio-polished-tab')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const editedPrompt = 'Edited audio digital human prompt used for generation.';
    await page!.fill('#audio-polished-text', editedPrompt);

    const llmRequest = llmMock.requests
      .slice(requestsBefore)
      .find((request) => request.method === 'POST' && request.url === '/v1/chat/completions');
    expect(llmRequest).toBeDefined();
    const llmBody = JSON.parse(llmRequest!.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    const llmUserContent = llmBody.messages.find((message) => message.role === 'user')?.content;
    expect(llmUserContent).toContain('Reference labels: <Picture 1>, <Audio 1>.');
    expect(llmUserContent).not.toContain('audioPath');
    expect(llmUserContent).not.toContain(launchOptions.fileDialogPaths[2]);

    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#audio-mode-panel button:has-text("生成视频")');
    const jobLocator = page!.locator(
      '#audio-mode-panel section[aria-label="任务状态"]:visible code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(page!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);
    const submitted = comfyMock.submittedPrompts[previousCount];
    const promptNode = submitted.prompt['42'] as { inputs: { prompt: string } };
    expect(promptNode.inputs.prompt).toBe(editedPrompt);
  });

  test('图像生成使用模拟 ComfyUI PNG 并在作品页保持原始比例', async () => {
    const png = await sharp({
      create: {
        width: 96,
        height: 48,
        channels: 3,
        background: { r: 24, g: 150, b: 112 },
      },
    }).png().toBuffer();

    await app!.close();
    app = undefined;
    page = undefined;
    imageServiceProbeEntry = await createImageServiceProbeEntry();
    app = await launchApp({
      ...launchOptions,
      appPath: imageServiceProbeEntry,
      fileDialogPaths: [],
    });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await installImageBackendProbe(app, {
      outputDirectory,
      pngBase64: png.toString('base64'),
    });
    await page.reload();
    await expect(page).toHaveTitle('SMO.H3 Studio');

    await page.click('#studio-image-button');
    await expect(page.locator('#image-main-panel')).toBeVisible();
    await expect(page.locator('.person-preview:visible')).toHaveCount(0);
    await expect(page.locator('#image-main-panel button:has-text("生成图像")')).toBeEnabled();
    await page.fill('#image-prompt', 'A clean geometric image from the simulated backend.');
    await page.selectOption('#image-aspect', '16:9 (Widescreen)');
    await page.selectOption('#image-resolution', '1');
    await page.fill('#image-seed', '7');
    await page.fill('#image-steps', '30');
    await page.click('#image-main-panel button:has-text("生成图像")');

    const jobLocator = page.locator(
      '#image-main-panel section[aria-label="任务状态"] code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(page, jobId, 'done');
    const outputPath = join(outputDirectory, 'SMO-Image', `${jobId}_00001.png`);
    expect(existsSync(outputPath)).toBe(true);

    const submitted = await app.evaluate(() => {
      const probeGlobal = process as unknown as {
        __smoImageE2eGraph?: Record<string, { inputs: Record<string, unknown> }>;
      };
      return {
        prompt: probeGlobal.__smoImageE2eGraph?.['452']?.inputs,
        latent: probeGlobal.__smoImageE2eGraph?.['456']?.inputs,
        sampler: probeGlobal.__smoImageE2eGraph?.['458']?.inputs,
      };
    });
    expect(submitted.prompt).toMatchObject({
      prompt: 'A clean geometric image from the simulated backend.',
    });
    expect(submitted.latent).toMatchObject({ width: 1376, height: 768 });
    expect(submitted.sampler).toMatchObject({ seed: 7, steps: 30 });

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    const image = work.getByRole('img', { name: `作品图像 ${jobId}` });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(96);
    const display = await image.evaluate((element) => {
      const imageElement = element as HTMLImageElement;
      const rect = imageElement.getBoundingClientRect();
      return {
        naturalRatio: imageElement.naturalWidth / imageElement.naturalHeight,
        renderedRatio: rect.width / rect.height,
        objectFit: getComputedStyle(imageElement).objectFit,
      };
    });
    expect(display.naturalRatio).toBe(2);
    expect(display.renderedRatio).toBeCloseTo(display.naturalRatio, 2);
    expect(display.objectFit).toBe('contain');

    const avatarName = jobId.slice(0, 8);
    const originalBytes = await readFile(outputPath);
    await work.getByRole('button', { name: '导入数字模特', exact: true }).click();
    await expect(page.getByRole('heading', { name: '数字模特', exact: true })).toBeVisible();
    const avatarList = page.locator('.avatar-list');
    const importedAvatar = avatarList.locator('article').filter({ hasText: avatarName });
    await expect(importedAvatar).toHaveCount(1);
    await expect(importedAvatar.getByRole('button', { name: '当前模特' })).toBeDisabled();

    const firstAvatarPhotos = await readdir(join(dataDirectory, 'avatars'));
    expect(firstAvatarPhotos).toHaveLength(1);
    const firstCopyPath = join(dataDirectory, 'avatars', firstAvatarPhotos[0]);
    expect(firstCopyPath).not.toBe(outputPath);
    expect(await readFile(firstCopyPath)).toEqual(originalBytes);
    expect(await readFile(outputPath)).toEqual(originalBytes);

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    await expect(work).toBeVisible();
    await work.getByRole('button', { name: '导入数字模特', exact: true }).click();
    await expect(avatarList.locator('article')).toHaveCount(2);
    await expect(avatarList.getByRole('button', { name: '当前模特' })).toHaveCount(1);
    const secondAvatarPhotos = await readdir(join(dataDirectory, 'avatars'));
    expect(secondAvatarPhotos).toHaveLength(2);
    expect(new Set(secondAvatarPhotos).size).toBe(2);
    for (const photo of secondAvatarPhotos) {
      expect(await readFile(join(dataDirectory, 'avatars', photo))).toEqual(originalBytes);
    }
    expect(await readFile(outputPath)).toEqual(originalBytes);
  });

  test('参考生图 1 张横图按 1MP 端到端验收', async () => {
    const referenceDirectory = join(tempDirectory!, 'references');
    await mkdir(referenceDirectory, { recursive: true });
    const referencePath = join(referenceDirectory, 'reference-1.png');
    await sharp({
      create: {
        width: 1600,
        height: 900,
        channels: 3,
        background: { r: 32, g: 120, b: 196 },
      },
    }).png().toFile(referencePath);
    const originalReference = await readFile(referencePath);
    const outputPng = await sharp({
      create: {
        width: 1376,
        height: 768,
        channels: 3,
        background: { r: 24, g: 150, b: 112 },
      },
    }).png().toBuffer();

    await app!.close();
    app = undefined;
    page = undefined;
    imageServiceProbeEntry = await createImageServiceProbeEntry();
    app = await launchApp({
      ...launchOptions,
      appPath: imageServiceProbeEntry,
      fileDialogPaths: [referencePath],
    });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await installImageBackendProbe(app, {
      outputDirectory,
      pngBase64: outputPng.toString('base64'),
    });
    await page.reload();
    await expect(page).toHaveTitle('SMO.H3 Studio');

    const prompt = 'One ordered landscape reference at 1MP.';
    await page.click('#studio-image-button');
    await page.fill('#image-prompt', prompt);
    await page.click('#reference-image-tab');
    await page.getByRole('button', { name: '选择参考图', exact: true }).click();
    const referencePreview = page.getByRole('img', {
      name: '参考图 1：reference-1.png',
    });
    await expect(referencePreview).toBeVisible();
    await expect.poll(() =>
      referencePreview.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBe(1600);

    await page.click('#text-image-tab');
    await expect(page.locator('#image-prompt')).toHaveValue(prompt);
    await page.click('#reference-image-tab');
    await expect(page.locator('#image-prompt')).toHaveValue(prompt);
    await expect(page.locator('#image-main-panel .reference-image-preview img')).toHaveCount(1);
    await expect(referencePreview).toBeVisible();
    await page.selectOption('#image-resolution', '1');
    await expect(page.locator('#image-resolution')).toHaveValue('1');
    await expect(page.locator('#image-main-panel .form-notice')).toContainText(
      '输出 1376 × 768 px',
    );
    await page.fill('#image-seed', '71');
    await page.fill('#image-steps', '28');
    await expect(page.locator('#image-main-panel .button-generate')).toBeEnabled();
    await page.locator('#image-main-panel .button-generate').click();

    const jobLocator = page.locator(
      '#image-main-panel section[aria-label="任务状态"] code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(page, jobId, 'done');
    const outputPath = join(outputDirectory, 'SMO-Image', `${jobId}_00001.png`);
    expect(existsSync(outputPath)).toBe(true);

    const probe = await app.evaluate(() => {
      const probeGlobal = process as unknown as {
        __smoImageE2eGraph?: Record<string, {
          class_type: string;
          inputs: Record<string, unknown>;
        }>;
        __smoImageE2eUploads?: Array<{
          filePath: string;
          kind: string;
        }>;
      };
      return {
        graph: probeGlobal.__smoImageE2eGraph,
        uploads: probeGlobal.__smoImageE2eUploads,
      };
    });
    expect(probe.graph).toBeDefined();
    expect(probe.uploads).toEqual([
      {
        filePath: join(dataDirectory, 'uploads', `${jobId}-0.png`),
        kind: 'image',
      },
    ]);
    expect(await readdir(join(dataDirectory, 'uploads'))).toEqual([]);
    expect(await readFile(referencePath)).toEqual(originalReference);

    const graph = probe.graph!;
    expect(graph.ref1).toEqual({
      class_type: 'LoadImage',
      inputs: { image: 'uploaded-1.png' },
    });
    expect(graph.ref2).toBeUndefined();
    expect(graph['452'].inputs).toMatchObject({
      prompt,
      vae: ['454', 0],
      resolution: 1024,
      'images.image_1': ['ref1', 0],
    });
    expect(graph['452'].inputs).not.toHaveProperty('images');
    expect(graph['458'].inputs).toMatchObject({
      latent_image: ['452', 2],
      seed: 71,
      steps: 28,
    });
    expect(graph['461'].inputs).toMatchObject({
      filename_prefix: `SMO-Image/${jobId}`,
      format: 'png',
    });
    expect(reachableImageNodeIds(graph, '461')).not.toContain('456');

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    const outputImage = work.getByRole('img', { name: `作品图像 ${jobId}` });
    await expect(outputImage).toBeVisible();
    await expect.poll(() => outputImage.evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
    }))).toEqual({ width: 1376, height: 768 });
  });

  test('参考生图 4 张首图方形按 4MP 端到端验收', async () => {
    const referenceDirectory = join(tempDirectory!, 'references-4');
    await mkdir(referenceDirectory, { recursive: true });
    const referenceDefinitions = [
      { width: 1200, height: 1200, background: { r: 32, g: 120, b: 196 } },
      { width: 1600, height: 900, background: { r: 196, g: 80, b: 32 } },
      { width: 900, height: 1600, background: { r: 48, g: 160, b: 96 } },
      { width: 1400, height: 1000, background: { r: 160, g: 64, b: 144 } },
    ];
    const referencePaths: string[] = [];
    for (const [index, definition] of referenceDefinitions.entries()) {
      const referencePath = join(referenceDirectory, `reference-${index + 1}.png`);
      await sharp({
        create: { ...definition, channels: 3 },
      }).png().toFile(referencePath);
      referencePaths.push(referencePath);
    }
    const originalReferences = await Promise.all(
      referencePaths.map((referencePath) => readFile(referencePath)),
    );
    const outputInset = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,
        background: { r: 224, g: 84, b: 48 },
      },
    }).png().toBuffer();
    const outputPng = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: { r: 24, g: 150, b: 112 },
      },
    })
      .composite([{ input: outputInset, top: 512, left: 512 }])
      .png()
      .toBuffer();

    await app!.close();
    app = undefined;
    page = undefined;
    imageServiceProbeEntry = await createImageServiceProbeEntry();
    app = await launchApp({
      ...launchOptions,
      appPath: imageServiceProbeEntry,
      fileDialogPaths: referencePaths,
    });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();
    await installImageBackendProbe(app, {
      outputDirectory,
      pngBase64: outputPng.toString('base64'),
    });
    await page.reload();
    await expect(page).toHaveTitle('SMO.H3 Studio');

    const prompt = 'Four ordered references with a square first image at 4MP.';
    await page.click('#studio-image-button');
    await page.fill('#image-prompt', prompt);
    await page.click('#reference-image-tab');
    for (const [index, definition] of referenceDefinitions.entries()) {
      const selectButton = page.getByRole('button', {
        name: '选择参考图',
        exact: true,
      });
      await expect(selectButton).toBeEnabled();
      await selectButton.click();
      await expect(page.locator('#image-main-panel .reference-image-count')).toHaveText(
        `${index + 1} / 4`,
      );
      await expect(page.locator('#image-main-panel .reference-image-preview img'))
        .toHaveCount(index + 1);
      const preview = page.getByRole('img', {
        name: `参考图 ${index + 1}：reference-${index + 1}.png`,
      });
      await expect(preview).toBeVisible();
      await expect.poll(() =>
        preview.evaluate((element) => (element as HTMLImageElement).naturalWidth),
      ).toBe(definition.width);
    }
    await expect(page.locator('#image-main-panel .reference-image-filename')).toHaveText(
      referencePaths.map((_, index) => `reference-${index + 1}.png`),
    );
    await expect(
      page.getByRole('button', { name: '选择参考图', exact: true }),
    ).toBeDisabled();

    await page.click('#text-image-tab');
    await expect(page.locator('#image-prompt')).toHaveValue(prompt);
    await page.click('#reference-image-tab');
    await expect(page.locator('#image-prompt')).toHaveValue(prompt);
    await expect(page.locator('#image-main-panel .reference-image-count')).toHaveText('4 / 4');
    await expect(page.locator('#image-main-panel .reference-image-preview img')).toHaveCount(4);
    await page.selectOption('#image-resolution', '4');
    await expect(page.locator('#image-resolution')).toHaveValue('4');
    await expect(page.locator('#image-main-panel .form-notice')).toContainText(
      '首图 1200 × 1200 px，输出 2048 × 2048 px',
    );
    await page.fill('#image-seed', '144');
    await page.fill('#image-steps', '32');

    await setViewport(app, page, 960, 640);
    await assertViewLayout(page, 'studio-reference-four-960x640', [
      '#image-prompt',
      '#image-main-panel .reference-image-picker',
      '#image-resolution',
      '#image-steps',
      '#image-main-panel .button-generate',
    ]);

    await expect(page.locator('#image-main-panel .button-generate')).toBeEnabled();
    await page.locator('#image-main-panel .button-generate').click();
    const jobLocator = page.locator(
      '#image-main-panel section[aria-label="任务状态"] code',
    );
    await expect(jobLocator).toHaveText(/^[0-9a-f-]{36}$/);
    const jobId = (await jobLocator.textContent())!;
    await waitForStableStatus(page, jobId, 'done');
    const outputPath = join(outputDirectory, 'SMO-Image', `${jobId}_00001.png`);
    expect(existsSync(outputPath)).toBe(true);
    const outputMetadata = await sharp(outputPath).metadata();
    expect(outputMetadata).toMatchObject({ width: 2048, height: 2048, format: 'png' });
    const outputStats = await sharp(outputPath).stats();
    expect(outputStats.channels.some((channel) => channel.stdev > 0)).toBe(true);

    const probe = await app.evaluate(() => {
      const probeGlobal = process as unknown as {
        __smoImageE2eGraph?: Record<string, {
          class_type: string;
          inputs: Record<string, unknown>;
        }>;
        __smoImageE2eUploads?: Array<{
          filePath: string;
          kind: string;
        }>;
      };
      return {
        graph: probeGlobal.__smoImageE2eGraph,
        uploads: probeGlobal.__smoImageE2eUploads,
      };
    });
    expect(probe.uploads).toEqual(
      referencePaths.map((_, index) => ({
        filePath: join(dataDirectory, 'uploads', `${jobId}-${index}.png`),
        kind: 'image',
      })),
    );
    expect(await readdir(join(dataDirectory, 'uploads'))).toEqual([]);
    for (const [index, referencePath] of referencePaths.entries()) {
      expect(await readFile(referencePath)).toEqual(originalReferences[index]);
    }

    const graph = probe.graph!;
    expect(graph).toBeDefined();
    for (const index of [0, 1, 2, 3]) {
      expect(graph[`ref${index + 1}`]).toEqual({
        class_type: 'LoadImage',
        inputs: { image: `uploaded-${index + 1}.png` },
      });
    }
    expect(graph.ref5).toBeUndefined();
    expect(graph['452'].class_type).toBe('TextEncodeQwenImage21');
    expect(graph['452'].inputs).toMatchObject({
      prompt,
      vae: ['454', 0],
      resolution: 2048,
      'images.image_1': ['ref1', 0],
      'images.image_2': ['ref2', 0],
      'images.image_3': ['ref3', 0],
      'images.image_4': ['ref4', 0],
    });
    expect(graph['452'].inputs).not.toHaveProperty('images');
    expect(
      Object.keys(graph['452'].inputs).filter((key) => key.startsWith('images.')),
    ).toEqual([
      'images.image_1',
      'images.image_2',
      'images.image_3',
      'images.image_4',
    ]);
    expect(graph['454'].class_type).toBe('VAELoader');
    expect(graph['458'].inputs).toMatchObject({
      latent_image: ['452', 2],
      seed: 144,
      steps: 32,
    });
    expect(graph['461'].inputs).toMatchObject({
      filename_prefix: `SMO-Image/${jobId}`,
      format: 'png',
    });
    expect(graph['456'].class_type).toBe('EmptyLatentImage');
    expect(reachableImageNodeIds(graph, '461')).not.toContain('456');

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    const outputImage = work.getByRole('img', { name: `作品图像 ${jobId}` });
    await expect(outputImage).toBeVisible();
    await expect.poll(() => outputImage.evaluate((element) => ({
      width: (element as HTMLImageElement).naturalWidth,
      height: (element as HTMLImageElement).naturalHeight,
    }))).toEqual({ width: 2048, height: 2048 });

    const originalOutput = await readFile(outputPath);
    const avatarName = jobId.slice(0, 8);
    await work.getByRole('button', { name: '导入数字模特', exact: true }).click();
    await expect(page.getByRole('heading', { name: '数字模特', exact: true })).toBeVisible();
    const avatarList = page.locator('.avatar-list');
    const importedAvatar = avatarList.locator('article').filter({ hasText: avatarName });
    await expect(importedAvatar).toHaveCount(1);
    const avatarPhotos = await readdir(join(dataDirectory, 'avatars'));
    expect(avatarPhotos).toHaveLength(1);
    const importedAssetPath = join(dataDirectory, 'avatars', avatarPhotos[0]);
    expect(importedAssetPath).not.toBe(outputPath);
    expect(await readFile(importedAssetPath)).toEqual(originalOutput);
    expect(await readFile(outputPath)).toEqual(originalOutput);

    await page.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    await expect(work).toBeVisible();
    await work.getByRole('button', { name: `删除作品 ${jobId}` }).click();
    const dialog = page.getByRole('dialog', { name: '删除作品' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${jobId}_00001.png`);
    await dialog.getByRole('button', { name: '确认删除' }).click();
    await expect(work).toHaveCount(0);
    await expect(dialog).toHaveCount(0);
    expect(existsSync(outputPath)).toBe(false);
    expect(await readFile(importedAssetPath)).toEqual(originalOutput);
    expect(await readdir(join(dataDirectory, 'avatars'))).toEqual(avatarPhotos);
    for (const [index, referencePath] of referencePaths.entries()) {
      expect(await readFile(referencePath)).toEqual(originalReferences[index]);
    }
  });

  test('works list combines hierarchical mode and status filters', async () => {
    const avatarName = 'E2E Works Avatar';
    await createAvatar(page!, avatarName);
    await saveLlmProfile(page!, llmMock.baseUrl);
    await openStudio(page!, avatarName);

    await selectCurrentAvatarReference(page!);
    await page!.fill('#reference-original-text', 'Works list test.');
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work).toContainText('文字生视频');

    const workTypes = page!.getByRole('group', { name: '作品类型' });
    const statusFilters = page!.getByRole('group', { name: '作品状态' });
    await workTypes.getByRole('button', { name: '视频', exact: true }).click();
    const videoTypes = page!.getByRole('group', { name: '视频类型' });
    await videoTypes.getByRole('button', { name: '音频数字人', exact: true }).click();
    await expect(page!.locator('.works-list article')).toHaveCount(0);
    await videoTypes.getByRole('button', { name: '文字生视频', exact: true }).click();
    await expect(work).toBeVisible();

    await statusFilters.getByRole('button', { name: '失败', exact: true }).click();
    await expect(page!.locator('.works-list article')).toHaveCount(0);
    await statusFilters.getByRole('button', { name: '已完成', exact: true }).click();
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

    await selectCurrentAvatarReference(page!);
    await page!.fill('#reference-original-text', 'Failure scenario test.');
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });

    comfyMock.failNext();
    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page!);
    await waitForStableStatus(page!, jobId, 'failed');
    expect(comfyMock.submittedPromptIds.length).toBe(previousCount + 1);

    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const failedWork = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(failedWork).toBeVisible();
    const worksBefore = await page!.locator('.works-list article').count();

    await failedWork.getByRole('button', { name: '重试' }).click();

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

    await selectCurrentAvatarReference(page!);
    await page!.fill('#reference-original-text', 'Deletion removes the record and the video.');
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page!);
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
    await expect(dialog).not.toContainText(avatarName);
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

    await selectCurrentAvatarReference(page!);
    await page!.fill('#reference-original-text', 'Restart persistence test.');
    await page!.click('#reference-mode-panel button:has-text("AI 润色")');
    await expect(page!.locator('#reference-polished-tab')).toBeEnabled({ timeout: 30_000 });
    await page!.click('#reference-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleReferenceJobId(page!);
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

      // The 8px east resize hot zone must never cover the main-content
      // scrollbar: the content edge stays at least the hot-zone width inside
      // the frame (same 0-2 px fractional-DPI tolerance as above).
      const contentInset = await page!.evaluate(() => {
        const frame = document.querySelector('.app-frame');
        const main = document.querySelector('.main-content');
        if (!frame || !main) {
          return null;
        }
        return (
          frame.getBoundingClientRect().right - main.getBoundingClientRect().right
        );
      });
      expect(contentInset).not.toBeNull();
      expect(contentInset!).toBeGreaterThanOrEqual(6);

      await page!.locator('#studio-video-button').click();
      // The studio preserves the previously selected mode, so switch back to
      // text mode explicitly instead of relying on an implicit reset.
      await page!.click('#text-mode-tab');
      await expect(page!.locator('#text-mode-panel')).toBeVisible();
      await assertStudioAvatarLayout(page!, `studio-${viewport.width}x${viewport.height}`);
      await assertViewLayout(page!, 'studio-text', [
        '.person-preview .avatar-image img',
        '#reference-mode-tab',
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

      await page!.click('#studio-image-button');
      await expect(page!.locator('#image-main-panel')).toBeVisible();
      await expect(page!.locator('.person-preview:visible')).toHaveCount(0);
      await assertViewLayout(page!, 'studio-image', [
        '#image-prompt',
        '#image-aspect',
        '#image-resolution',
        '#image-seed',
        '#image-steps',
        '#image-main-panel .button-generate',
      ], [
        { selector: 'label[for="image-prompt"]', text: '图像提示词' },
        { selector: 'label[for="image-aspect"]', text: '图像比例' },
        { selector: 'label[for="image-resolution"]', text: '分辨率' },
        { selector: 'label[for="image-seed"]', text: '随机种子' },
        { selector: 'label[for="image-steps"]', text: '采样步数' },
        { selector: '#image-main-panel .button-generate', text: '生成图像' },
      ]);
      await assertCurrentOptionText(
        page!,
        'studio-image aspect',
        '#image-aspect',
        '1:1 方形（Square）',
      );
      await assertCurrentOptionText(
        page!,
        'studio-image resolution',
        '#image-resolution',
        '1024 × 1024 px',
      );
      await page!.click('#studio-video-button');

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

      await page!.locator('#studio-video-button').click();
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
      document.querySelectorAll('.settings-section:not([hidden])').forEach((element, index) => {
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

    await page!.locator('#studio-video-button').click();
    await expect(page!.locator('#text-mode-panel')).toBeVisible();
    await assertStudioAvatarLayout(page!, 'studio-200-zoom');
    await assertViewLayout(page!, 'studio-200-zoom', [
      '.person-preview .avatar-image img',
      '#reference-mode-tab',
      '#original-text',
      '#text-mode-panel .button-generate',
    ]);

    await page!.click('#studio-image-button');
    await expect(page!.locator('#image-main-panel')).toBeVisible();
    await assertViewLayout(page!, 'studio-image-200-zoom', [
      '#image-prompt',
      '#image-aspect',
      '#image-resolution',
      '#image-seed',
      '#image-steps',
      '#image-main-panel .button-generate',
    ], [
      { selector: 'label[for="image-prompt"]', text: '图像提示词' },
      { selector: 'label[for="image-aspect"]', text: '图像比例' },
      { selector: 'label[for="image-resolution"]', text: '分辨率' },
      { selector: 'label[for="image-seed"]', text: '随机种子' },
      { selector: 'label[for="image-steps"]', text: '采样步数' },
      { selector: '#image-main-panel .button-generate', text: '生成图像' },
    ]);
    await assertCurrentOptionText(
      page!,
      'studio-image-200-zoom aspect',
      '#image-aspect',
      '1:1 方形（Square）',
    );
    await assertCurrentOptionText(
      page!,
      'studio-image-200-zoom resolution',
      '#image-resolution',
      '1024 × 1024 px',
    );
  });

  test('window maximize round trip toggles the rounded frame', async () => {
    await expect(page!.locator('.app-shell')).toBeVisible();

    const readMaximized = () =>
      page!.evaluate(() =>
        (
          window as unknown as {
            smo: { window: { isMaximized(): Promise<boolean> } };
          }
        ).smo.window.isMaximized(),
      );
    const readChromeState = () =>
      page!.evaluate(() => ({
        maximizedDataset: document.body.dataset.windowMaximized ?? null,
        radius: getComputedStyle(document.querySelector('.app-frame')!)
          .borderTopLeftRadius,
      }));

    // Initial state: restored window with rounded corners.
    await expect.poll(readMaximized).toBe(false);
    expect((await readChromeState()).radius).toBe('12px');

    // Maximize through the titlebar button.
    await page!.getByRole('button', { name: '最大化', exact: true }).click();
    await expect.poll(readMaximized).toBe(true);
    await expect(
      page!.getByRole('button', { name: '还原', exact: true }),
    ).toBeVisible();
    await expect.poll(readChromeState).toEqual({
      maximizedDataset: 'true',
      radius: '0px',
    });
    await expect(page!.locator('.app-shell')).toBeVisible();

    // Restore through the titlebar button.
    await page!.getByRole('button', { name: '还原', exact: true }).click();
    await expect.poll(readMaximized).toBe(false);
    await expect(
      page!.getByRole('button', { name: '最大化', exact: true }),
    ).toBeVisible();
    await expect.poll(readChromeState).toEqual({
      maximizedDataset: 'false',
      radius: '12px',
    });
    await expect(page!.locator('.app-shell')).toBeVisible();
  });

  test('window resize handle grows the transparent window', async () => {
    await expect(page!.locator('.app-shell')).toBeVisible();
    await setViewport(app!, page!, 1280, 820);

    const handle = page!.locator('.window-resize-se');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();

    const readBounds = () => readWindowBounds(app!);

    const startBounds = await readBounds();
    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;

    // Drag the south-east hot zone at least 30 px along both axes.
    await page!.mouse.move(centerX, centerY);
    await page!.mouse.down();
    await page!.mouse.move(centerX + 15, centerY + 15, { steps: 3 });
    await page!.mouse.move(centerX + 45, centerY + 45, { steps: 6 });
    await page!.mouse.up();

    // The resize IPC is rAF-throttled; poll until the main process applies it.
    let resizedBounds = startBounds;
    await expect
      .poll(
        async () => {
          resizedBounds = await readBounds();
          return Math.min(
            resizedBounds.width - startBounds.width,
            resizedBounds.height - startBounds.height,
          );
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(20);

    // Directional assertion only (fractional-DPI displays round to device
    // pixels): se grows width/height while the top-left corner stays put.
    expect(resizedBounds.width - startBounds.width).toBeGreaterThanOrEqual(20);
    expect(resizedBounds.height - startBounds.height).toBeGreaterThanOrEqual(20);
    expect(Math.abs(resizedBounds.x - startBounds.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(resizedBounds.y - startBounds.y)).toBeLessThanOrEqual(2);

    // The session ended on pointerup: further hovers must not resize.
    await page!.mouse.move(centerX + 80, centerY + 80, { steps: 5 });
    await page!.waitForTimeout(250);
    expect(await readBounds()).toEqual(resizedBounds);
    await expect(page!.locator('.app-shell')).toBeVisible();
  });

  test('window resize via the ne corner never hits the close button', async () => {
    await expect(page!.locator('.app-shell')).toBeVisible();
    await setViewport(app!, page!, 1280, 820);

    // The ne hot zone overlaps the titlebar's close button area; the drag
    // must resize the window without ever triggering close.
    const handle = page!.locator('.window-resize-ne');
    await expect(handle).toBeVisible();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();

    const readBounds = () => readWindowBounds(app!);
    const startBounds = await readBounds();
    const centerX = box!.x + box!.width / 2;
    const centerY = box!.y + box!.height / 2;

    // Drag diagonally up-right at least 30 px along both axes.
    await page!.mouse.move(centerX, centerY);
    await page!.mouse.down();
    await page!.mouse.move(centerX + 15, centerY - 15, { steps: 3 });
    await page!.mouse.move(centerX + 45, centerY - 45, { steps: 6 });
    await page!.mouse.up();

    let resizedBounds = startBounds;
    await expect
      .poll(
        async () => {
          resizedBounds = await readBounds();
          return Math.min(
            resizedBounds.width - startBounds.width,
            resizedBounds.height - startBounds.height,
          );
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(20);

    // ne grows width/height, moves the top edge up and anchors the
    // bottom-left corner (the edge opposite the dragged corner stays put).
    expect(resizedBounds.width - startBounds.width).toBeGreaterThanOrEqual(20);
    expect(resizedBounds.height - startBounds.height).toBeGreaterThanOrEqual(20);
    expect(resizedBounds.y).toBeLessThan(startBounds.y);
    expect(Math.abs(resizedBounds.x - startBounds.x)).toBeLessThanOrEqual(2);
    expect(
      Math.abs(
        resizedBounds.y + resizedBounds.height -
          (startBounds.y + startBounds.height),
      ),
    ).toBeLessThanOrEqual(2);

    // The app survived the corner drag: window alive, close button unused.
    const windowCount = await app!.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    expect(windowCount).toBe(1);
    await expect(page!).toHaveTitle('SMO.H3 Studio');
    await expect(page!.locator('.app-shell')).toBeVisible();

    // Session ended: hovering further does not resize.
    await page!.mouse.move(centerX + 80, centerY - 80, { steps: 5 });
    await page!.waitForTimeout(250);
    expect(await readBounds()).toEqual(resizedBounds);
  });
});
