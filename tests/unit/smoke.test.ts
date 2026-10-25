// @vitest-environment node

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Configuration } from 'app-builder-lib';
import { loadConfig } from 'app-builder-lib/out/util/config/load';
import type { BrowserWindowConstructorOptions } from 'electron';
import { describe, expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

type PackageManifest = {
  name: string;
  productName: string;
  private: boolean;
  type: string;
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

type WindowEnvironment = {
  isPackaged: boolean;
  resourcesPath: string;
  moduleDirectory: string;
};

type WindowOptionsModule = {
  createWindowOptions: (environment: WindowEnvironment) => BrowserWindowConstructorOptions;
};

async function readManifest(): Promise<PackageManifest> {
  const manifestPath = join(projectRoot, 'package.json');
  expect(existsSync(manifestPath), 'package.json should exist').toBe(true);

  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
}

async function loadWindowOptions(): Promise<WindowOptionsModule> {
  const modulePath = join(projectRoot, 'src/main/window-options.ts');
  expect(existsSync(modulePath), 'window options module should exist').toBe(true);

  return import(pathToFileURL(modulePath).href) as Promise<WindowOptionsModule>;
}

async function readBuilderConfig(): Promise<Configuration> {
  const config = await loadConfig<Configuration>({
    packageKey: 'build',
    configFilename: 'electron-builder',
    projectDir: projectRoot,
    packageMetadata: null,
  });
  expect(config?.configFile, 'electron-builder.yml should be loaded').toBe(
    join(projectRoot, 'electron-builder.yml'),
  );

  return config!.result;
}

describe('desktop shell manifest', () => {
  test('uses the SMO product name and ESM Electron entry point', async () => {
    const manifest = await readManifest();

    expect(manifest).toMatchObject({
      name: 'smo-h3-studio',
      productName: 'SMO.H3 Studio',
      private: true,
      type: 'module',
      main: 'dist/main/index.js',
    });
  });

  test('defines the development, verification, asset, and packaging commands', async () => {
    const { scripts } = await readManifest();

    expect(scripts).toMatchObject({
      dev: 'electron-vite dev',
      build: 'electron-vite build',
      test: 'vitest run',
      'test:e2e': 'playwright test',
      assets: 'node scripts/prepare-brand.mjs && node scripts/build-workflows.mjs',
      pack: 'npm run build && electron-builder --win portable',
    });
  });

  test('declares the required runtime dependencies', async () => {
    const { dependencies } = await readManifest();

    expect(Object.keys(dependencies)).toEqual(
      expect.arrayContaining(['react', 'react-dom', 'lucide-react', 'ws', 'zod']),
    );
  });

  test('declares the required development dependencies', async () => {
    const { devDependencies } = await readManifest();

    expect(Object.keys(devDependencies)).toEqual(
      expect.arrayContaining([
        'electron',
        'electron-vite',
        'vite',
        '@vitejs/plugin-react',
        'typescript',
        'vitest',
        '@types/node',
        '@types/react',
        '@types/react-dom',
        '@types/ws',
        'jsdom',
        '@testing-library/react',
        '@testing-library/jest-dom',
        '@playwright/test',
        'electron-builder',
        'sharp',
        'png-to-ico',
      ]),
    );
  });

  test('configures the SMO window dimensions and security defaults', async () => {
    const { createWindowOptions } = await loadWindowOptions();
    const options = createWindowOptions({
      isPackaged: false,
      resourcesPath: join(projectRoot, 'packed-resources'),
      moduleDirectory: join(projectRoot, 'dist/main'),
    });

    expect(options).toMatchObject({
      title: 'SMO.H3 Studio',
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });

  test('combines an ESM main process with a sandboxed CommonJS preload', async () => {
    const manifest = await readManifest();
    const { createWindowOptions } = await loadWindowOptions();
    const moduleDirectory = join(projectRoot, 'dist/main');
    const options = createWindowOptions({
      isPackaged: false,
      resourcesPath: join(projectRoot, 'packed-resources'),
      moduleDirectory,
    });

    expect(manifest).toMatchObject({
      type: 'module',
      main: 'dist/main/index.js',
    });
    expect(options.webPreferences).toMatchObject({
      preload: join(moduleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });

  test.each([
    {
      scenario: 'development',
      isPackaged: false,
      expectedIcon: join(projectRoot, 'resources/brand/icon.ico'),
    },
    {
      scenario: 'packaged app',
      isPackaged: true,
      expectedIcon: join(projectRoot, 'packed-resources/resources/brand/icon.ico'),
    },
  ])('resolves the desktop icon for $scenario', async ({ isPackaged, expectedIcon }) => {
    const { createWindowOptions } = await loadWindowOptions();
    const options = createWindowOptions({
      isPackaged,
      resourcesPath: join(projectRoot, 'packed-resources'),
      moduleDirectory: join(projectRoot, 'dist/main'),
    });

    expect(options.icon).toBe(expectedIcon);
  });
});

describe('electron-builder configuration', () => {
  test('uses release output without embedding runtime resources in app.asar', async () => {
    const config = await readBuilderConfig();

    expect(config.directories?.output).toBe('release');
    expect(config.files).toEqual(['dist/**']);
  });

  test('externalizes brand, workflow, and skill resources', async () => {
    const config = await readBuilderConfig();

    expect(config.extraResources).toEqual(
      expect.arrayContaining([
        { from: 'resources/brand', to: 'resources/brand' },
        { from: 'resources/workflows', to: 'resources/workflows' },
        { from: 'resources/skills', to: 'resources/skills' },
      ]),
    );
  });

  test('has the brand icon referenced by the external resource mapping', async () => {
    const config = await readBuilderConfig();
    const resources = Array.isArray(config.extraResources) ? config.extraResources : [];
    const brandMapping = resources.find(
      (resource) =>
        typeof resource !== 'string' && resource.from === 'resources/brand',
    );
    expect(brandMapping).toMatchObject({ to: 'resources/brand' });

    const sourceDirectory =
      brandMapping && typeof brandMapping !== 'string' ? brandMapping.from : undefined;
    const iconPath = join(projectRoot, sourceDirectory!, 'icon.ico');
    expect(existsSync(iconPath), 'resources/brand/icon.ico should exist').toBe(true);
  });
});
