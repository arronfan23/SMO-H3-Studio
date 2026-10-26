import { test, expect, _electron as electron } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('Electron app starts and exposes window.smo domains', async () => {
  const appPath = join(__dirname, '../../dist/main/index.js');
  const userDataDir = await mkdtemp(join(tmpdir(), 'smo-e2e-'));
  const app = await electron.launch({
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
  });
  try {
    const window = await app.firstWindow();
    await expect(window).toHaveTitle('SMO.H3 Studio');

    const smo = await window.evaluate(() => (window as unknown as Record<string, unknown>).smo);
    expect(smo).toBeDefined();
    for (const domain of ['avatars', 'jobs', 'llm', 'comfy', 'hardware', 'works', 'files']) {
      expect((smo as Record<string, unknown>)[domain]).toBeDefined();
    }
  } finally {
    await app.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
