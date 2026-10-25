// @vitest-environment node

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  createRendererLoadFailureMessage,
  loadRenderer,
  selectRendererTarget,
  type RendererWindow,
} from '../../src/main/renderer';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

describe('renderer startup', () => {
  test('uses the development URL for an unpackaged app', () => {
    expect(
      selectRendererTarget({
        isPackaged: false,
        rendererUrl: 'http://localhost:5173',
        moduleDirectory: join(projectRoot, 'dist/main'),
      }),
    ).toEqual({ type: 'url', location: 'http://localhost:5173' });
  });

  test('ignores the development URL for a packaged app', () => {
    const moduleDirectory = join(projectRoot, 'dist/main');

    expect(
      selectRendererTarget({
        isPackaged: true,
        rendererUrl: 'http://localhost:5173',
        moduleDirectory,
      }),
    ).toEqual({
      type: 'file',
      location: join(moduleDirectory, '../renderer/index.html'),
    });
  });

  test('uses the local renderer when development URL is absent', () => {
    const moduleDirectory = join(projectRoot, 'dist/main');

    expect(
      selectRendererTarget({ isPackaged: false, moduleDirectory }),
    ).toEqual({
      type: 'file',
      location: join(moduleDirectory, '../renderer/index.html'),
    });
  });

  test.each([
    { targetType: 'url' as const, expectedMethod: 'loadURL' },
    { targetType: 'file' as const, expectedMethod: 'loadFile' },
  ])('loads a $targetType target with $expectedMethod', async ({
    targetType,
    expectedMethod,
  }) => {
    const calls: string[] = [];
    const window: RendererWindow = {
      loadURL: async (url) => {
        calls.push(`loadURL:${url}`);
      },
      loadFile: async (path) => {
        calls.push(`loadFile:${path}`);
      },
    };
    const failures: unknown[] = [];

    await loadRenderer(
      window,
      { type: targetType, location: 'renderer-target' },
      (error) => failures.push(error),
    );

    expect(calls).toEqual([`${expectedMethod}:renderer-target`]);
    expect(failures).toEqual([]);
  });

  test('reports a rejected renderer load without rethrowing', async () => {
    const failure = new Error('development server unavailable');
    const failures: unknown[] = [];
    const window: RendererWindow = {
      loadURL: async () => {
        throw failure;
      },
      loadFile: async () => {
        throw new Error('unexpected loadFile call');
      },
    };

    await expect(
      loadRenderer(
        window,
        { type: 'url', location: 'http://localhost:5173' },
        (error) => failures.push(error),
      ),
    ).resolves.toBeUndefined();
    expect(failures).toEqual([failure]);
  });

  test('creates an actionable startup failure message', () => {
    const message = createRendererLoadFailureMessage(new Error('index.html missing'));

    expect(message).toContain('界面加载失败');
    expect(message).toContain('重新启动');
    expect(message).toContain('index.html missing');
  });
});
