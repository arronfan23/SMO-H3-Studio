import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('Electron app starts with isolated env and exposes window.smo domains', async () => {
  const appPath = join(__dirname, '../../dist/main/index.js');
  const userDataDir = await mkdtemp(join(tmpdir(), 'smo-e2e-'));
  const dataDirectory = await mkdtemp(join(tmpdir(), 'smo-e2e-data-'));
  const outputDirectory = await mkdtemp(join(tmpdir(), 'smo-e2e-output-'));
  const comfyBaseUrl = 'http://127.0.0.1:65534';

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
        SMO_COMFYUI_BASE_URL: comfyBaseUrl,
      },
    });

    const window = await app.firstWindow();
    await expect(window).toHaveTitle('SMO.H3 Studio');

    await expect(
      window.evaluate(() => (window as unknown as Record<string, unknown>).smo !== undefined),
    ).resolves.toBe(true);

    const expectedDomains: Record<string, string[]> = {
      avatars: ['list', 'create', 'update', 'delete'],
      jobs: ['start', 'retry', 'cancel'],
      llm: ['saveProfile', 'getProfile', 'listModels', 'testModel', 'polish'],
      comfy: ['health', 'open'],
      hardware: ['detect', 'recommend', 'reset', 'apply'],
      works: ['list'],
      files: ['selectImage', 'selectAudio', 'mediaUrl', 'openFolder'],
    };

    for (const [domain, methods] of Object.entries(expectedDomains)) {
      await expect(
        window.evaluate(
          ({ domain: d, methods: ms }) => {
           const api = (window as unknown as Record<string, Record<string, unknown>>).smo?.[d];
            if (api == null || typeof api !== 'object') return 'missing-domain';
            return ms.map((m) =>
              typeof (api as Record<string, unknown>)[m] === 'function'
                ? 'function'
                : typeof (api as Record<string, unknown>)[m],
            );
          },
          { domain, methods },
        ),
      ).resolves.toEqual(methods.map(() => 'function'));
    }

    expect(existsSync(join(dataDirectory, 'studio.sqlite'))).toBe(true);
  } finally {
    await app?.close();
    await rm(userDataDir, { recursive: true, force: true });
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
