// @vitest-environment node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

type TypeScriptConfig = {
  compilerOptions: {
    lib: string[];
    types: string[];
  };
};

async function readTypeScriptConfig(filename: string): Promise<TypeScriptConfig> {
  const configPath = join(projectRoot, filename);
  expect(existsSync(configPath), `${filename} should exist`).toBe(true);

  return JSON.parse(await readFile(configPath, 'utf8')) as TypeScriptConfig;
}

test('separates Node and renderer global types', async () => {
  const [nodeConfig, rendererConfig] = await Promise.all([
    readTypeScriptConfig('tsconfig.node.json'),
    readTypeScriptConfig('tsconfig.renderer.json'),
  ]);

  expect(nodeConfig.compilerOptions.types).toEqual(['node']);
  expect(rendererConfig.compilerOptions.types).toEqual([]);
  expect(rendererConfig.compilerOptions.lib).toEqual(
    expect.arrayContaining(['DOM', 'DOM.Iterable']),
  );
});

test('rejects process and Buffer in the renderer type environment', () => {
  const fixtureConfig = join(
    projectRoot,
    'tests/fixtures/tsconfig.renderer-node-globals.json',
  );
  expect(existsSync(fixtureConfig), 'renderer type fixture should exist').toBe(true);

  const result = spawnSync(
    process.execPath,
    [
      join(projectRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--project',
      fixtureConfig,
    ],
    { cwd: projectRoot, encoding: 'utf8' },
  );
  const output = `${result.stdout}${result.stderr}`;

  expect(result.status).toBe(1);
  expect(output).not.toContain('Cannot read file');
  expect(output).toContain("Cannot find name 'process'");
  expect(output).toContain("Cannot find name 'Buffer'");
});
