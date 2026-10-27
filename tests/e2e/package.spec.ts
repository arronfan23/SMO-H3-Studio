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
import { seedAvatar } from '../fixtures/seed-avatar';
import { startComfyMock } from '../fixtures/mock-comfy';
import { startLlmMock } from '../fixtures/mock-llm';

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

async function findPortableExe(): Promise<string> {
  const entries = await readdir(RELEASE_DIRECTORY).catch(() => [] as string[]);
  const executables = entries
    .filter((entry) => /^SMO\.H3-Studio-.*\.exe$/.test(entry))
    .sort()
    .reverse();
  if (executables.length === 0) {
    throw new Error(
      'Portable executable missing; run `npm run pack` before test:e2e:package.',
    );
  }
  return join(RELEASE_DIRECTORY, executables[0]);
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

// The portable stub spawns the real Electron app as a child process; killing
// the Playwright handle may leave the child behind. Stop anything still
// running from the stub's extraction directory (never by image name, so a
// user's own SMO.H3 Studio instance is never touched).
async function stopExtractedApp(extractionRoot: string | undefined): Promise<void> {
  if (!extractionRoot) {
    return;
  }
  const script =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${extractionRoot}') } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  await execFileAsync('powershell', ['-NoProfile', '-Command', script]).catch(
    () => undefined,
  );
  // The portable child keeps the sqlite handle open briefly after the kill;
  // wait until the extraction directory no longer hosts our processes.
  const probe = () =>
    execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${extractionRoot}') } | Measure-Object).Count`,
    ]).then(
      ({ stdout }) => Number(stdout.trim()),
      () => 0,
    );
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await probe()) === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
  let extractionRoot: string | undefined;
  let resourcesPath: string | undefined;
  let harness: PackagedHarness | undefined;

  let dataDirectory: string;
  let outputDirectory: string;
  let userDataDir: string;
  let avatarImagePath: string;

  interface PackagedHarness {
    resourcesPath: string;
    close(): Promise<void>;
  }

  // Two-layer launch against the REAL portable artifact:
  // 1. Spawn the portable wrapper itself with a fixed CDP port; connect over CDP
  //    to prove the wrapper extracts and starts the packaged UI.
  // 2. Locate the exe the wrapper just extracted (its own child process — never
  //    release/win-unpacked) and drive THAT file with _electron.launch so the
  //    suite keeps main-process access (app.isPackaged, process.resourcesPath,
  //    BrowserWindow.setContentSize) with the reliable pipe transport.
  // The wrapper instance keeps running (with throwaway data dirs) while the
  // inner instance runs the real assertions, and is closed first on teardown so
  // the stub can clean up its own extraction directory.
  async function launchPackaged(): Promise<PackagedHarness> {
    const portableExe = await findPortableExe();
    const cdpPort = await reserveFreePort();
    const wrapperDataDirectory = join(tempDirectory!, 'wrapper-data');
    const wrapperOutputDirectory = join(tempDirectory!, 'wrapper-output');
    await mkdir(wrapperDataDirectory, { recursive: true });
    await mkdir(wrapperOutputDirectory, { recursive: true });

    const wrapperLogs: string[] = [];
    const wrapper: ChildProcess = spawn(
      portableExe,
      [
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--remote-debugging-port=${cdpPort}`,
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
    const collectWrapperLog = (data: Buffer | string) =>
      wrapperLogs.push(typeof data === 'string' ? data : data.toString());
    wrapper.stdout?.on('data', collectWrapperLog);
    wrapper.stderr?.on('data', collectWrapperLog);

    let cdpBrowser: Browser | undefined;
    let innerExe: string | null = null;
    try {
      // Layer 1: find the exe this wrapper extracted and verify its UI over CDP.
      const deadline = Date.now() + 150_000;
      while (innerExe === null && Date.now() < deadline) {
        if (wrapper.exitCode !== null) {
          throw new Error(
            `portable wrapper exited before the app started (code ${wrapper.exitCode}): ${wrapperLogs.join('')}`,
          );
        }
        innerExe = await childExePath(wrapper.pid!);
        if (innerExe === null) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      if (innerExe === null) {
        throw new Error(`timed out waiting for the extracted app process: ${wrapperLogs.join('')}`);
      }
      expect(innerExe.toLowerCase().startsWith(tmpdir().toLowerCase())).toBe(true);

      cdpBrowser = await connectOverCdp(cdpPort, 150_000);
      const cdpPages = cdpBrowser.contexts().flatMap((context) => context.pages());
      if (cdpPages.length === 0) {
        throw new Error('wrapper instance exposed CDP but no pages');
      }
      const cdpPage = cdpPages[0];
      await expect
        .poll(async () => cdpPage.title(), { timeout: 60_000 })
        .toBe('SMO.H3 Studio');
      expect(cdpPage.url().startsWith('file://')).toBe(true);

      // Layer 2: drive the SAME extracted exe with Playwright's Electron transport.
      app = await electron.launch({
        executablePath: innerExe,
        timeout: 120_000,
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
      extractionRoot = dirname(discoveredResourcesPath);
      return {
        resourcesPath: discoveredResourcesPath,
        close: async () => {
          try {
            await app?.close();
          } finally {
            app = undefined;
            page = undefined;
            try {
              await cdpBrowser?.close();
            } catch {
              // The wrapper app may already be gone; make sure its processes are.
              await stopExtractedApp(extractionRoot);
            }
            cdpBrowser = undefined;
            const exitDeadline = Date.now() + 15_000;
            while (wrapper.exitCode === null && Date.now() < exitDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (wrapper.exitCode === null) {
              wrapper.kill('SIGKILL');
            }
          }
        },
      };
    } catch (error) {
      try {
        await app?.close();
      } catch {
        // best effort
      }
      app = undefined;
      page = undefined;
      try {
        await cdpBrowser?.close();
      } catch {
        // best effort
      }
      await stopExtractedApp(innerExe === null ? undefined : dirname(innerExe));
      if (wrapper.exitCode === null) {
        wrapper.kill('SIGKILL');
      }
      throw error;
    }
  }

  test.beforeEach(async () => {
    harness = undefined;
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
    extractionRoot = undefined;
    resourcesPath = undefined;

    harness = await launchPackaged();
    resourcesPath = harness.resourcesPath;
  });

  test.afterEach(async () => {
    try {
      await harness?.close();
    } finally {
      harness = undefined;
      await stopExtractedApp(extractionRoot);
      app = undefined;
      page = undefined;
      extractionRoot = undefined;
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
    const workflowClassTypes = new Set(
      Object.values(packagedWorkflow).map((node) => node.class_type),
    );
    const submitted = comfyMock.submittedPrompts[comfyMock.submittedPrompts.length - 1];
    const submittedNodes = Object.values(submitted.prompt) as Array<{
      class_type: string;
    }>;
    expect(submittedNodes.length).toBeGreaterThan(0);
    for (const node of submittedNodes) {
      expect(workflowClassTypes.has(node.class_type)).toBe(true);
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

      await page!.click('nav[aria-label="主导航"] button:has-text("我的作品")');
      await expect(page!.locator('.works-filters')).toBeVisible();
      await assertViewWithinViewport(page!, `package-works-${width}`, [
        '.works-filters',
        '.page-header .button-secondary',
      ]);

      const worksShot = testInfo.outputPath(`package-works-${width}x${height}.png`);
      await page!.screenshot({ path: worksShot });
      expect((await stat(worksShot)).size).toBeGreaterThan(1000);
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
