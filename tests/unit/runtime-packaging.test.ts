// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import rawManifest from '../../resources/environment/selflift-spark.json';
import { parseEnvironmentManifest } from '../../src/main/environment-manifest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageScript = join(projectRoot, 'scripts/package-runtime.ps1');
const builderScript = join(projectRoot, 'scripts/build-environment-manifest.mjs');
const releaseBaseUrl =
  'https://github.com/arronfan23/SMO-H3-Runtime/releases/download/runtime-v1';

interface RuntimeMetadata {
  id: 'sm89' | 'sm120';
  sourceArchive: string;
  chunkSize: number;
  archiveParts: Array<{ path: string; size: number; sha256: string }>;
  archiveSize: number;
  archiveSha256: string;
  estimatedExtractedBytes: number;
  pythonPath: string;
  launchScript: string;
  ffprobePath: string;
}

interface PackageMetadata {
  version: 1;
  runtimes: {
    sm89: RuntimeMetadata;
    sm120: RuntimeMetadata;
  };
}

interface BuilderModule {
  buildEnvironmentManifest(options: {
    packageMetadata: PackageMetadata;
    sourceManifest: unknown;
    fetchImpl?: typeof fetch;
  }): Promise<unknown>;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'smo-runtime-packaging-'));
const sm89Zip = join(temporaryRoot, 'SampleSM89.zip');
const sm120Zip = join(temporaryRoot, 'SampleSM120.zip');
const outputRoot = join(temporaryRoot, 'output');
const chunkSize = 127;
let packageMetadata: PackageMetadata;
const sourceHashes = new Map<string, string>();

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function runPowerShell(script: string, args: string[]): void {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `& { ${script} }`,
      ...args,
    ],
    { stdio: 'pipe' },
  );
}

function createSampleZip(path: string, root: string, marker: string): void {
  runPowerShell(
    `
Add-Type -AssemblyName System.IO.Compression
$stream = [System.IO.File]::Create($args[0])
$archive = [System.IO.Compression.ZipArchive]::new(
  $stream,
  [System.IO.Compression.ZipArchiveMode]::Create
)
try {
  $root = $args[1]
  $entries = [ordered]@{
    "$root/python_embeded/python.exe" = "python-$($args[2])"
    "$root/tools/launch.py" = "launch-$($args[2])"
    "$root/tools/ffmpeg/ffprobe.exe" = "ffprobe-$($args[2])"
    "$root/payload.bin" = [string]::new([char]65, 2048)
  }
  foreach ($entry in $entries.GetEnumerator()) {
    $zipEntry = $archive.CreateEntry($entry.Key)
    $entryStream = $zipEntry.Open()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$entry.Value)
      $entryStream.Write($bytes, 0, $bytes.Length)
    } finally {
      $entryStream.Dispose()
    }
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
`,
    [path, root, marker],
  );
}

function runPackager(extraArgs: string[] = []): void {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      packageScript,
      '-SM89Zip',
      sm89Zip,
      '-SM120Zip',
      sm120Zip,
      '-OutputRoot',
      outputRoot,
      '-ChunkSize',
      String(chunkSize),
      ...extraArgs,
    ],
    { stdio: 'pipe' },
  );
}

function metadataPath(id: 'sm89' | 'sm120'): string {
  return join(outputRoot, 'runtime-packs', id, 'metadata.json');
}

function reconstructedPartHash(runtime: RuntimeMetadata, id: 'sm89' | 'sm120'): string {
  const hash = createHash('sha256');
  for (const part of runtime.archiveParts) {
    hash.update(readFileSync(join(outputRoot, 'runtime-packs', id, part.path)));
  }
  return hash.digest('hex').toUpperCase();
}

function huggingFaceLocation(modelUrl: string) {
  const url = new URL(modelUrl);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Unexpected test model URL: ${modelUrl}`);
  return {
    owner: match[1],
    repo: match[2],
    revision: match[3],
    path: match[4],
  };
}

function makeHuggingFaceFetch(
  options: { wrongSize?: boolean; fail?: boolean; currentLfsField?: boolean } = {},
) {
  const requestedUrls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const requestUrl = String(input);
    requestedUrls.push(requestUrl);
    if (options.fail) throw new TypeError('simulated network failure');

    const url = new URL(requestUrl);
    const match = url.pathname.match(/^\/api\/models\/([^/]+)\/([^/]+)$/);
    if (!match || url.search !== '?blobs=true') {
      throw new Error(`Unexpected Hugging Face API request: ${requestUrl}`);
    }

    const siblings = rawManifest.modelFiles
      .filter((model) => {
        const location = huggingFaceLocation(model.url);
        return location.owner === match[1] && location.repo === match[2];
      })
      .map((model, index) => ({
        rfilename: huggingFaceLocation(model.url).path,
        size: model.size + (options.wrongSize && index === 0 ? 1 : 0),
        lfs: options.currentLfsField
          ? { sha256: model.sha256, size: model.size, pointerSize: 136 }
          : { oid: model.sha256 },
      }));
    return Response.json({ siblings });
  };

  return { fetchImpl: fetchImpl as typeof fetch, requestedUrls };
}

async function loadBuilder(): Promise<BuilderModule> {
  return (await import(pathToFileURL(builderScript).href)) as BuilderModule;
}

beforeAll(() => {
  createSampleZip(sm89Zip, 'SampleSM89', 'sm89');
  createSampleZip(sm120Zip, 'SampleSM120', 'sm120');
  sourceHashes.set(sm89Zip, sha256(sm89Zip));
  sourceHashes.set(sm120Zip, sha256(sm120Zip));
  runPackager();
  packageMetadata = JSON.parse(
    readFileSync(join(outputRoot, 'runtime-packs', 'metadata.json'), 'utf8'),
  ) as PackageMetadata;
}, 30_000);

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe('package-runtime.ps1', () => {
  test.each(['sm89', 'sm120'] as const)(
    'streams %s into ordered bounded chunks with whole and part hashes',
    (id) => {
      const runtime = packageMetadata.runtimes[id];
      const sourcePath = id === 'sm89' ? sm89Zip : sm120Zip;
      const directory = join(outputRoot, 'runtime-packs', id);
      const partFiles = readdirSync(directory).filter((name) => /\.zip\.part\d+$/.test(name));

      expect(runtime.id).toBe(id);
      expect(runtime.sourceArchive).toBe(basename(sourcePath));
      expect(runtime.chunkSize).toBe(chunkSize);
      expect(runtime.archiveSize).toBe(statSync(sourcePath).size);
      expect(runtime.archiveSha256).toBe(sourceHashes.get(sourcePath));
      expect(runtime.archiveParts).toHaveLength(Math.ceil(runtime.archiveSize / chunkSize));
      expect(partFiles).toEqual(runtime.archiveParts.map((part) => part.path));

      runtime.archiveParts.forEach((part, index) => {
        const partPath = join(directory, part.path);
        expect(part.path).toBe(`${basename(sourcePath)}.part${index + 1}`);
        expect(part.size).toBeLessThanOrEqual(chunkSize);
        expect(part.size).toBe(statSync(partPath).size);
        expect(part.sha256).toBe(sha256(partPath));
        if (index < runtime.archiveParts.length - 1) expect(part.size).toBe(chunkSize);
      });
      expect(runtime.archiveParts.reduce((total, part) => total + part.size, 0)).toBe(
        runtime.archiveSize,
      );
      expect(reconstructedPartHash(runtime, id)).toBe(runtime.archiveSha256);
      expect(sha256(sourcePath)).toBe(sourceHashes.get(sourcePath));
    },
  );

  test('records ZIP extraction size and unique runtime entry paths', () => {
    for (const id of ['sm89', 'sm120'] as const) {
      const root = id === 'sm89' ? 'SampleSM89' : 'SampleSM120';
      const runtime = packageMetadata.runtimes[id];
      expect(runtime.estimatedExtractedBytes).toBeGreaterThan(2048);
      expect(runtime.pythonPath).toBe(`${root}/python_embeded/python.exe`);
      expect(runtime.launchScript).toBe(`${root}/tools/launch.py`);
      expect(runtime.ffprobePath).toBe(`${root}/tools/ffmpeg/ffprobe.exe`);
      expect(JSON.parse(readFileSync(metadataPath(id), 'utf8'))).toEqual(runtime);
    }
  });

  test('skips valid parts and rebuilds a corrupted part instead of trusting it', () => {
    const runtime = packageMetadata.runtimes.sm89;
    const firstPart = join(outputRoot, 'runtime-packs', 'sm89', runtime.archiveParts[0].path);
    const originalModifiedTime = statSync(firstPart).mtimeMs;

    runPackager();
    expect(statSync(firstPart).mtimeMs).toBe(originalModifiedTime);

    writeFileSync(firstPart, 'corrupted');
    runPackager();
    expect(statSync(firstPart).size).toBe(runtime.archiveParts[0].size);
    expect(sha256(firstPart)).toBe(runtime.archiveParts[0].sha256);
    expect(reconstructedPartHash(runtime, 'sm89')).toBe(runtime.archiveSha256);
  });

  test('rejects chunk sizes above the release asset limit', () => {
    expect(() =>
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          packageScript,
          '-SM89Zip',
          sm89Zip,
          '-SM120Zip',
          sm120Zip,
          '-OutputRoot',
          join(temporaryRoot, 'oversized'),
          '-ChunkSize',
          '1900000001',
        ],
        { stdio: 'pipe' },
      ),
    ).toThrow();
  });
});

describe('build-environment-manifest.mjs', () => {
  test('builds a parser-compatible manifest with fixed URLs and original model sources', async () => {
    const { buildEnvironmentManifest } = await loadBuilder();
    const huggingFace = makeHuggingFaceFetch();
    const generated = await buildEnvironmentManifest({
      packageMetadata,
      sourceManifest: rawManifest,
      fetchImpl: huggingFace.fetchImpl,
    });
    const manifest = parseEnvironmentManifest(generated);

    expect(manifest.modelFiles).toEqual(rawManifest.modelFiles);
    expect(manifest.modelFiles).toHaveLength(10);
    for (const id of ['sm89', 'sm120'] as const) {
      const runtime = packageMetadata.runtimes[id];
      expect(manifest.runtimes[id]).toEqual({
        id,
        displayName: rawManifest.runtimes[id].displayName,
        archiveParts: runtime.archiveParts.map((part) => ({
          ...part,
          url: `${releaseBaseUrl}/${part.path}`,
        })),
        archiveSize: runtime.archiveSize,
        archiveSha256: runtime.archiveSha256,
        estimatedExtractedBytes: runtime.estimatedExtractedBytes,
        pythonPath: runtime.pythonPath,
        launchScript: runtime.launchScript,
        ffprobePath: runtime.ffprobePath,
      });
    }
    expect(huggingFace.requestedUrls).toHaveLength(8);
    expect(huggingFace.requestedUrls.every((url) => url.endsWith('?blobs=true'))).toBe(true);
  });

  test('fails when Hugging Face metadata does not match the reviewed size', async () => {
    const { buildEnvironmentManifest } = await loadBuilder();
    const huggingFace = makeHuggingFaceFetch({ wrongSize: true });

    await expect(
      buildEnvironmentManifest({
        packageMetadata,
        sourceManifest: rawManifest,
        fetchImpl: huggingFace.fetchImpl,
      }),
    ).rejects.toThrow(/size|metadata/i);
  });

  test('accepts the current Hugging Face lfs.sha256 response representation', async () => {
    const { buildEnvironmentManifest } = await loadBuilder();
    const huggingFace = makeHuggingFaceFetch({ currentLfsField: true });

    const generated = await buildEnvironmentManifest({
      packageMetadata,
      sourceManifest: rawManifest,
      fetchImpl: huggingFace.fetchImpl,
    });

    expect(parseEnvironmentManifest(generated).modelFiles).toEqual(rawManifest.modelFiles);
  });

  test('fails instead of substituting data when Hugging Face is unavailable', async () => {
    const { buildEnvironmentManifest } = await loadBuilder();
    const huggingFace = makeHuggingFaceFetch({ fail: true });

    await expect(
      buildEnvironmentManifest({
        packageMetadata,
        sourceManifest: rawManifest,
        fetchImpl: huggingFace.fetchImpl,
      }),
    ).rejects.toThrow(/network|failed|unavailable/i);
  });
});

const realManifestTest = process.env.SMO_RUNTIME_MANIFEST ? test : test.skip;
realManifestTest('parses a real generated manifest as semantically identical to the reviewed one', () => {
  const manifestPath = process.env.SMO_RUNTIME_MANIFEST;
  expect(manifestPath && existsSync(manifestPath)).toBe(true);
  const generated = JSON.parse(readFileSync(manifestPath!, 'utf8')) as unknown;
  expect(parseEnvironmentManifest(generated)).toEqual(parseEnvironmentManifest(rawManifest));
});
