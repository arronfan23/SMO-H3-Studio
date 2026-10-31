import { test, expect, _electron as electron, chromium } from '@playwright/test';
import type { Browser, ElectronApplication, Page, TestInfo } from '@playwright/test';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { seedAvatar } from '../fixtures/seed-avatar';
import { startComfyMock } from '../fixtures/mock-comfy';
import { startLlmMock } from '../fixtures/mock-llm';
import { writeReadyEnvironment } from '../fixtures/ready-environment';
import { DEFAULT_MODEL_DIRECTORY } from '../../src/shared/generation-options';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const RELEASE_DIRECTORY = join(PROJECT_ROOT, 'release');
const SHORTCUT_SCRIPT = join(PROJECT_ROOT, 'scripts', 'create-shortcut.ps1');
const TEST_LLM_API_KEY = 'smo-package-test-key';
const AVATAR_NAME = 'PKG Test Avatar';

const execFileAsync = promisify(execFile);

const FFMPEG_PATH =
  process.env.SMO_FFMPEG_PATH ??
  'G:\\H3Selflift整合包\\ComfyUI_SelfLift_Spark_SM120_CUDA130\\tools\\ffmpeg\\ffmpeg.exe';

interface SmoWorksGlobal {
  smo: {
    works: {
      list: () => Promise<
        Array<{ id: string; status: string; outputPath: string | null }>
      >;
    };
  };
}

type SemanticVersion = [number, number, number];

function portableExeVersion(filename: string): SemanticVersion | null {
  const match = /^SMO\.H3-Studio-(\d+)\.(\d+)\.(\d+)\.exe$/.exec(filename);
  return match === null
    ? null
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

async function findPortableExe(): Promise<string> {
  const entries = await readdir(RELEASE_DIRECTORY).catch(() => [] as string[]);
  const candidates = entries
    .map((entry) => ({ entry, version: portableExeVersion(entry) }))
    .filter(
      (candidate): candidate is { entry: string; version: SemanticVersion } =>
        candidate.version !== null,
    )
    // Semantic ordering: 1.10.0 must win over 1.9.0 (lexicographic sort would not).
    .sort((left, right) => compareVersion(right.version, left.version));
  if (candidates.length === 0) {
    throw new Error(
      'Portable executable missing; run `npm run pack` before test:e2e:package.',
    );
  }
  return join(RELEASE_DIRECTORY, candidates[0].entry);
}

async function createTestAvatarImage(directory: string): Promise<string> {
  const imagePath = join(directory, 'avatar.png');
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
  return imagePath;
}

async function reserveFreePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function childExePath(parentPid: number): Promise<string | null> {
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${parentPid} -and $_.ExecutablePath } | Select-Object -First 1).ExecutablePath`,
  ]);
  const executablePath = stdout.trim();
  return executablePath.length > 0 ? executablePath : null;
}

async function connectOverCdp(port: number, timeoutMs: number): Promise<Browser> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`packaged app did not expose CDP on 127.0.0.1:${port}: ${String(lastError)}`);
}

async function waitForChildExe(
  wrapper: ChildProcess,
  timeoutMs: number,
  describeFailure?: () => string,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (wrapper.exitCode !== null) {
      throw new Error(
        `portable wrapper exited before the app started (code ${wrapper.exitCode})${describeFailure ? `: ${describeFailure()}` : ''}`,
      );
    }
    const executablePath = await childExePath(wrapper.pid!);
    if (executablePath !== null) {
      return executablePath;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for the extracted app process${describeFailure ? `: ${describeFailure()}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface PackagedLaunchState {
  wrapper?: ChildProcess;
  cdpBrowser?: Browser;
  innerExe?: string;
  extractionRoot?: string;
}

// Processes are matched by extraction path with a strict boundary (root equal
// or root + separator), never by image name, so a user's own SMO.H3 Studio
// instance is never touched.
async function countProcessesUnder(root: string): Promise<number> {
  const escaped = root.replace(/'/g, "''");
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    `$root='${escaped}'; (Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq $root -or $_.ExecutablePath.StartsWith($root + '\\')) } | Measure-Object).Count`,
  ]);
  const count = Number(stdout.trim());
  return Number.isFinite(count) ? count : 0;
}

// The portable stub spawns the real Electron app as a child process; killing
// the Playwright handle may leave the child behind. Stop anything still running
// from the stub's extraction directory, then wait until the directory is clear.
async function stopExtractedApp(extractionRoot: string | undefined): Promise<void> {
  if (!extractionRoot) {
    return;
  }
  const escaped = extractionRoot.replace(/'/g, "''");
  await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    `$root='${escaped}'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq $root -or $_.ExecutablePath.StartsWith($root + '\\')) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]).catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await countProcessesUnder(extractionRoot)) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// Idempotent teardown for the two-layer portable launch. Works with whatever
// state was recorded before a failure: closing the CDP browser first gives the
// wrapper app a graceful quit; killing leftover extraction processes unblocks
// the stub's ExecWait; the stub itself is waited on, then force-killed only if
// it still lingers. A second call is a no-op.
async function cleanupPackagedLaunch(state: PackagedLaunchState): Promise<void> {
  const { wrapper, cdpBrowser } = state;
  const root =
    state.extractionRoot ??
    (state.innerExe !== undefined ? dirname(state.innerExe) : undefined);
  state.wrapper = undefined;
  state.cdpBrowser = undefined;
  state.innerExe = undefined;
  state.extractionRoot = undefined;

  try {
    await cdpBrowser?.close();
  } catch {
    // The wrapper app may already be gone; the extraction kill below covers it.
  }
  await stopExtractedApp(root);
  if (wrapper !== undefined && wrapper.exitCode === null) {
    const deadline = Date.now() + 15_000;
    while (wrapper.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (wrapper.exitCode === null) {
      wrapper.kill('SIGKILL');
    }
  }
}

async function assertNonBlankScreenshot(path: string): Promise<void> {
  const stats = await sharp(path).stats();
  expect(stats.channels.length).toBeGreaterThan(0);
  const maxStdev = Math.max(...stats.channels.map((channel) => channel.stdev));
  expect(maxStdev).toBeGreaterThan(5);
}

async function removeTempDirectory(directory: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function scanSensitiveFiles(root: string): Promise<string[]> {
  const violations: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test-results' || entry.name === '.worktrees') {
          violations.push(full);
        } else {
          await walk(full);
        }
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (/\.(sqlite|sqlite3|db|log)$/.test(lower)) {
        violations.push(full);
      }
      if (/\.(mp4|webm|mov)$/.test(lower)) {
        violations.push(full);
      }
      if (/\.(md|txt|json|js|ts|yaml|yml|html|css)$/.test(lower)) {
        const content = await readFile(full, 'utf8');
        if (content.includes(TEST_LLM_API_KEY)) {
          violations.push(`${full} (contains test API key)`);
        }
      }
    }
  };
  await walk(root);
  return violations;
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

async function setViewport(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const [actualWidth, actualHeight] = await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) {
        throw new Error('No BrowserWindow found');
      }
      win.webContents.setZoomFactor(1);
      win.setContentSize(width, height);
      return win.getContentSize();
    },
    { width, height },
  );

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

async function assertViewWithinViewport(
  page: Page,
  viewName: string,
  selectors: string[],
): Promise<void> {
  const violations = await page.evaluate(
    ({ view, selectors }) => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const results: Array<{
        view: string;
        type: string;
        selector?: string;
        message: string;
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
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        if (
          rect.left < 0 ||
          rect.right > viewport.width ||
          rect.top < 0 ||
          rect.bottom > viewport.height
        ) {
          results.push({
            view,
            type: 'out-of-viewport',
            selector,
            message: `element overflows viewport ${JSON.stringify(viewport)}`,
          });
        }
      }
      return results;
    },
    { view: viewName, selectors },
  );
  expect(violations).toEqual([]);
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

async function readVisibleTextJobId(page: Page): Promise<string> {
  const jobId = page.locator(
    '#text-mode-panel section[aria-label="任务状态"]:visible code',
  );
  await expect(jobId).toHaveText(/^[0-9a-f-]{36}$/);
  return (await jobId.textContent())!;
}

async function readShortcut(lnkPath: string): Promise<{
  TargetPath: string;
  WorkingDirectory: string;
  IconLocation: string;
}> {
  const escaped = lnkPath.replace(/'/g, "''");
  const script =
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${escaped}'); ` +
    `[pscustomobject]@{ TargetPath = $s.TargetPath; WorkingDirectory = $s.WorkingDirectory; ` +
    `IconLocation = $s.IconLocation } | ConvertTo-Json -Compress`;
  const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
  return JSON.parse(stdout.trim()) as {
    TargetPath: string;
    WorkingDirectory: string;
    IconLocation: string;
  };
}

test.describe('SMO.H3 Studio portable package', () => {
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  let tempDirectory: string | undefined;
  let llmMock: Awaited<ReturnType<typeof startLlmMock>>;
  let comfyMock: Awaited<ReturnType<typeof startComfyMock>>;
  let pageErrors: Error[] = [];
  let consoleErrors: string[] = [];
  let rendererLogs: string[] = [];
  let mainProcessRaw: (Buffer | string)[] = [];
  let resourcesPath: string | undefined;
  // Teardown handles, recorded the moment they exist so afterEach can clean
  // up even when launchPackaged throws midway through beforeEach.
  const launchState: PackagedLaunchState = {};

  let dataDirectory: string;
  let outputDirectory: string;
  let userDataDir: string;
  let avatarImagePath: string;

  // Two-layer launch against the REAL portable artifact:
  // 1. Spawn the portable wrapper itself with a fixed CDP port; connect over CDP
  //    to prove the wrapper extracts and starts the packaged UI.
  // 2. Locate the exe the wrapper just extracted (its own child process — never
  //    release/win-unpacked) and drive THAT file with _electron.launch so the
  //    suite keeps main-process access (app.isPackaged, process.resourcesPath,
  //    BrowserWindow.setContentSize) with the reliable pipe transport.
  // Every stage records its handle in launchState immediately. Stage budgets
  // (discovery 90s + CDP 60s + inner launch 60s) stay well under the 300s
  // hook/test timeout, leaving room for the test body and for teardown.
  async function launchPackaged(): Promise<string> {
    const portableExe = await findPortableExe();
    const cdpPort = await reserveFreePort();
    const wrapperDataDirectory = join(tempDirectory!, 'wrapper-data');
    const wrapperOutputDirectory = join(tempDirectory!, 'wrapper-output');
    const wrapperUserDataDir = join(tempDirectory!, 'wrapper-user');
    await mkdir(wrapperDataDirectory, { recursive: true });
    await mkdir(wrapperOutputDirectory, { recursive: true });
    await mkdir(wrapperUserDataDir, { recursive: true });
    await writeReadyEnvironment({
      dataDirectory: wrapperDataDirectory,
      installRoot: join(tempDirectory!, 'wrapper-environment'),
      outputDirectory: wrapperOutputDirectory,
    });

    const wrapperLogs: string[] = [];
    const wrapper: ChildProcess = spawn(
      portableExe,
      [
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
        '--user-data-dir',
        wrapperUserDataDir,
      ],
      {
        env: {
          ...process.env,
          // Throwaway dirs: the wrapper instance only proves the packaged UI
          // starts; the inner instance uses the real per-test directories.
          SMO_DATA_DIRECTORY: wrapperDataDirectory,
          SMO_OUTPUT_DIRECTORY: wrapperOutputDirectory,
          SMO_COMFYUI_BASE_URL: comfyMock.baseUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    launchState.wrapper = wrapper;
    const collectWrapperLog = (data: Buffer | string) =>
      wrapperLogs.push(typeof data === 'string' ? data : data.toString());
    wrapper.stdout?.on('data', collectWrapperLog);
    wrapper.stderr?.on('data', collectWrapperLog);

    // Layer 1 (budget 90s): find the exe this wrapper extracted.
    const innerExe = await waitForChildExe(wrapper, 90_000, () => wrapperLogs.join(''));
    launchState.innerExe = innerExe;
    launchState.extractionRoot = dirname(innerExe);
    expect(innerExe.toLowerCase().startsWith(tmpdir().toLowerCase())).toBe(true);

    // Layer 2 (budget 60s): prove the wrapper-launched instance serves the packaged UI.
    let cdpBrowser: Browser;
    try {
      cdpBrowser = await connectOverCdp(cdpPort, 60_000);
    } catch (error) {
      throw new Error(`${String(error)} — wrapper logs: ${wrapperLogs.join('')}`);
    }
    launchState.cdpBrowser = cdpBrowser;
    const cdpPages = cdpBrowser.contexts().flatMap((context) => context.pages());
    if (cdpPages.length === 0) {
      throw new Error(`wrapper instance exposed CDP but no pages: ${wrapperLogs.join('')}`);
    }
    const cdpPage = cdpPages[0];
    await expect
      .poll(async () => cdpPage.title(), { timeout: 60_000 })
      .toBe('SMO.H3 Studio');
    expect(cdpPage.url().startsWith('file://')).toBe(true);

    // Layer 3 (budget 60s): drive the SAME extracted exe with Playwright's Electron transport.
    app = await electron.launch({
      executablePath: innerExe,
      timeout: 60_000,
      args: [
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
        SMO_FFMPEG_PATH: FFMPEG_PATH,
        // Must be ignored by the packaged app (unit-covered guard); the
        // packaged flow must never depend on the test file dialog.
        SMO_TEST_FILE_DIALOG: JSON.stringify([avatarImagePath]),
      },
    });
    attachMainProcessLogs(app, mainProcessRaw);
    app.on('window', (windowPage) =>
      attachRendererLogs(windowPage, pageErrors, consoleErrors, rendererLogs),
    );
    page = await app.firstWindow();

    const discoveredResourcesPath = await app.evaluate(() => process.resourcesPath);
    launchState.extractionRoot = dirname(discoveredResourcesPath);
    return discoveredResourcesPath;
  }

  test.beforeEach(async () => {
    launchState.wrapper = undefined;
    launchState.cdpBrowser = undefined;
    launchState.innerExe = undefined;
    launchState.extractionRoot = undefined;
    tempDirectory = await mkdtemp(join(tmpdir(), 'smo-package-e2e-'));
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
    avatarImagePath = await createTestAvatarImage(mediaDirectory);
    await seedAvatar({
      dataDirectory,
      outputDirectory,
      name: AVATAR_NAME,
      photoPath: avatarImagePath,
    });

    llmMock = await startLlmMock();
    comfyMock = await startComfyMock({
      outputDirectory,
      ffmpegPath: existsSync(FFMPEG_PATH) ? FFMPEG_PATH : undefined,
    });

    pageErrors = [];
    consoleErrors = [];
    rendererLogs = [];
    mainProcessRaw = [];
    resourcesPath = undefined;

    resourcesPath = await launchPackaged();
  });

  test.afterEach(async () => {
    try {
      try {
        await app?.close();
      } catch {
        // Best effort: the extraction cleanup below covers a stuck inner app.
      }
    } finally {
      app = undefined;
      page = undefined;
      await cleanupPackagedLaunch(launchState);
      resourcesPath = undefined;
      await llmMock?.close();
      await comfyMock?.close();
      if (tempDirectory) {
        await removeTempDirectory(tempDirectory);
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

  test('portable runtime exposes packaged resources and excludes sensitive files', async () => {
    await expect(page!).toHaveTitle('SMO.H3 Studio');

    expect(await app!.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    expect(resourcesPath).toBeDefined();
    const packagedResourcesPath = resourcesPath!;

    const brandIcon = join(packagedResourcesPath, 'resources', 'brand', 'icon.ico');
    const brandLogo = join(packagedResourcesPath, 'resources', 'brand', 'icon.png');
    expect((await stat(brandIcon)).size).toBeGreaterThan(0);
    expect((await stat(brandLogo)).size).toBeGreaterThan(0);

    const workflowFiles = (await readdir(join(packagedResourcesPath, 'resources', 'workflows')))
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    expect(workflowFiles).toEqual(['audio-digital-human.json', 'text-ref2va.json']);

    const skillEntries = await readdir(join(packagedResourcesPath, 'resources', 'skills'), {
      withFileTypes: true,
    });
    const skillDirectories = skillEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(skillDirectories).toHaveLength(9);

    const violations = await scanSensitiveFiles(packagedResourcesPath);
    expect(violations).toEqual([]);
  });

  test('packaged app completes a text-to-video work against local mocks', async () => {
    await expect(page!).toHaveTitle('SMO.H3 Studio');
    expect(await app!.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(true);
    const packagedResourcesPath = resourcesPath!;

    // Model list + test against the local mock LLM.
    await saveLlmProfile(page!, llmMock.baseUrl);
    await page!.click('button:has-text("获取模型")');
    await expect(page!.locator('.model-options')).toContainText('model-a', {
      timeout: 15_000,
    });
    await expect(page!.locator('.model-options')).toContainText('model-b');
    await page!.click('button:has-text("测试模型")');
    await expect(page!.locator('text=测试通过')).toBeVisible({ timeout: 15_000 });

    // ComfyUI health against the local mock.
    await expect(page!.locator('h3:has-text("ComfyUI 连接正常")')).toBeVisible();

    // Non-empty studio preview comes from the seeded avatar.
    await page!.click('nav[aria-label="主导航"] button:has-text("制作台")');
    await expect(
      page!.locator(`.person-preview h2:has-text("${AVATAR_NAME}")`),
    ).toBeVisible();
    const previewWidth = await page!
      .locator('.person-preview img')
      .evaluate((img) => (img as HTMLImageElement).naturalWidth);
    expect(previewWidth).toBeGreaterThan(0);

    await page!.fill('#original-text', 'A packaged app waves hello.');
    await page!.click('button:has-text("AI 润色")');
    await expect(page!.locator('#polished-tab')).toBeEnabled({ timeout: 30_000 });
    const polishedText = await page!.inputValue('#polished-text');
    expect(polishedText).toContain('subject_definitions:');

    const previousCount = comfyMock.submittedPromptIds.length;
    await page!.click('#text-mode-panel button:has-text("生成视频")');
    const jobId = await readVisibleTextJobId(page!);
    await waitForStableStatus(page!, jobId, 'done');
    expect(comfyMock.submittedPromptIds).toHaveLength(previousCount + 1);

    // The submitted ComfyUI graph must come from the packaged workflow file.
    const packagedWorkflow = JSON.parse(
      await readFile(
        join(packagedResourcesPath, 'resources', 'workflows', 'text-ref2va.json'),
        'utf8',
      ),
    ) as Record<string, { class_type: string }>;
    const submitted = comfyMock.submittedPrompts[comfyMock.submittedPrompts.length - 1];
    const submittedNodes = submitted.prompt as Record<
      string,
      { class_type: string }
    >;
    // The submitted graph must be exactly the packaged workflow: same node IDs,
    // same node types (inputs are patched in place, never added or removed).
    expect(Object.keys(submittedNodes).sort()).toEqual(
      Object.keys(packagedWorkflow).sort(),
    );
    for (const [nodeId, node] of Object.entries(submittedNodes)) {
      expect(node.class_type).toBe(packagedWorkflow[nodeId].class_type);
    }

    // Works view: completed work with playable packaged output.
    await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
    const work = page!.locator('.works-list article').filter({ hasText: jobId });
    await expect(work).toBeVisible();
    await expect(work).toContainText('已完成');
    await expect(work.locator('video')).toBeVisible();
    await waitForVideoReadyByJobId(page!, jobId);

    const works = await page!.evaluate(
      () => (window as unknown as SmoWorksGlobal).smo.works.list(),
    );
    const finished = works.find((candidate) => candidate.id === jobId);
    expect(finished?.status).toBe('done');
    expect(finished?.outputPath).toBeTruthy();
    expect(finished!.outputPath!.startsWith(outputDirectory)).toBe(true);
    expect(existsSync(finished!.outputPath!)).toBe(true);

    // SMO_TEST_FILE_DIALOG must stay disabled in the packaged app: exactly the
    // seeded avatar exists and nothing was auto-selected.
    await page!.click('nav[aria-label="主导航"] button:has-text("数字模特")');
    await expect(page!.locator('.avatar-list article')).toHaveCount(1);
    await expect(page!.locator('.avatar-list')).toContainText(AVATAR_NAME);
  });

  test('packaged layout stays inside viewport at 1280x820 and 960x640', async () => {
    const testInfo: TestInfo = test.info();
    await expect(page!).toHaveTitle('SMO.H3 Studio');

    for (const { width, height } of [
      { width: 1280, height: 820 },
      { width: 960, height: 640 },
    ]) {
      await setViewport(app!, page!, width, height);

      await page!.click('nav[aria-label="主导航"] button:has-text("制作台")');
      await expect(page!.locator('#text-mode-panel')).toBeVisible();
      await assertViewWithinViewport(page!, `package-studio-${width}`, [
        '.brand-lockup',
        '.person-preview',
        '#original-text',
        '#text-mode-panel .button-generate',
      ]);
      const logoWidth = await page!
        .locator('.brand-lockup img')
        .evaluate((img) => (img as HTMLImageElement).naturalWidth);
      expect(logoWidth).toBeGreaterThan(0);

      const studioShot = testInfo.outputPath(`package-studio-${width}x${height}.png`);
      await page!.screenshot({ path: studioShot });
      expect((await stat(studioShot)).size).toBeGreaterThan(1000);
      await assertNonBlankScreenshot(studioShot);

      await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
      await expect(page!.locator('.works-filters')).toBeVisible();
      await assertViewWithinViewport(page!, `package-works-${width}`, [
        '.works-filters',
        '.page-header .button-secondary',
      ]);

      const worksShot = testInfo.outputPath(`package-works-${width}x${height}.png`);
      await page!.screenshot({ path: worksShot });
      expect((await stat(worksShot)).size).toBeGreaterThan(1000);
      await assertNonBlankScreenshot(worksShot);
    }
  });
});

test.describe('create-shortcut.ps1', () => {
  test('creates a verifiable shortcut in a target directory without touching the Desktop', async () => {
    const portableExe = await findPortableExe();
    const shortcutDirectory = await mkdtemp(join(tmpdir(), 'smo-shortcut-'));
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SHORTCUT_SCRIPT,
        '-ReleaseDirectory',
        RELEASE_DIRECTORY,
        '-ShortcutDirectory',
        shortcutDirectory,
      ]);

      const lnkPath = join(shortcutDirectory, 'SMO.H3 Studio.lnk');
      expect(stdout).toContain(lnkPath);
      expect(existsSync(lnkPath)).toBe(true);

      const shortcut = await readShortcut(lnkPath);
      expect(shortcut.TargetPath).toBe(portableExe);
      expect(shortcut.WorkingDirectory).toBe(RELEASE_DIRECTORY);
      expect(shortcut.IconLocation).toBe(`${portableExe},0`);
    } finally {
      await rm(shortcutDirectory, { recursive: true, force: true });
    }
  });

  test('fails clearly when the portable executable is missing', async () => {
    const emptyRelease = await mkdtemp(join(tmpdir(), 'smo-shortcut-empty-'));
    const shortcutDirectory = await mkdtemp(join(tmpdir(), 'smo-shortcut-out-'));
    try {
      await expect(
        execFileAsync('powershell', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          SHORTCUT_SCRIPT,
          '-ReleaseDirectory',
          emptyRelease,
          '-ShortcutDirectory',
          shortcutDirectory,
        ]),
      ).rejects.toThrow(/Portable executable not found/);
      expect(existsSync(join(shortcutDirectory, 'SMO.H3 Studio.lnk'))).toBe(false);
    } finally {
      await rm(emptyRelease, { recursive: true, force: true });
      await rm(shortcutDirectory, { recursive: true, force: true });
    }
  });
});

test.describe('portable launch cleanup', () => {
  // Deterministic fault injection: start the real wrapper, wait until it has
  // extracted and launched the app (the point where a beforeEach is most likely
  // to give up), then run the same teardown afterEach uses — without any CDP
  // connection or inner launch ever happening. Nothing must be left behind.
  test('aborted launch after extraction leaves no wrapper or extracted processes', async () => {
    const portableExe = await findPortableExe();
    const root = await mkdtemp(join(tmpdir(), 'smo-abort-e2e-'));
    const state: PackagedLaunchState = {};
    let comfy: Awaited<ReturnType<typeof startComfyMock>> | undefined;
    try {
      const dataDirectory = join(root, 'data');
      const outputDirectory = join(root, 'output');
      await mkdir(dataDirectory, { recursive: true });
      await mkdir(outputDirectory, { recursive: true });
      await writeReadyEnvironment({
        dataDirectory,
        installRoot: join(root, 'environment'),
        outputDirectory,
      });
      comfy = await startComfyMock({ outputDirectory });

      state.wrapper = spawn(
        portableExe,
        ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox'],
        {
          env: {
            ...process.env,
            SMO_DATA_DIRECTORY: dataDirectory,
            SMO_OUTPUT_DIRECTORY: outputDirectory,
            SMO_COMFYUI_BASE_URL: comfy.baseUrl,
          },
          stdio: 'ignore',
        },
      );
      state.innerExe = await waitForChildExe(state.wrapper, 90_000);
      state.extractionRoot = dirname(state.innerExe);

      const captured = { ...state };
      // Simulated failed beforeEach: abort right after extraction.
      await cleanupPackagedLaunch(state);
      // The teardown is idempotent; a second pass must be a no-op.
      await cleanupPackagedLaunch(state);

      expect(captured.wrapper!.exitCode).not.toBeNull();
      expect(await countProcessesUnder(captured.extractionRoot!)).toBe(0);
    } finally {
      await cleanupPackagedLaunch(state);
      await comfy?.close();
      await removeTempDirectory(root);
    }
  });
});
