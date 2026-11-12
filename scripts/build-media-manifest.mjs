import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const INDEX_TTS_REPOSITORY = 'IndexTeam/IndexTTS-2.5';
const INDEX_TTS_CORE_PATHS = new Set([
  'LICENSE',
  'codec.pth',
  'config.yaml',
  'feat1.pt',
  'feat2.pt',
  'gpt.pth',
  'multilingual_zh_ja_yue_char_del.tiktoken',
  's2mel.pth',
  'wav2vec2bert_stats.pt',
]);
const INDEX_TTS_QWEN_DIRECTORY = 'qwen0.6bemo4-merge/';
const INDEX_TTS_AUXILIARIES = [
  {
    repository: 'facebook/w2v-bert-2.0',
    paths: ['config.json', 'preprocessor_config.json', 'model.safetensors'],
  },
  {
    repository: 'funasr/campplus',
    paths: ['campplus_cn_common.bin'],
  },
  {
    repository: 'nvidia/bigvgan_v2_22khz_80band_256x',
    paths: ['config.json', 'bigvgan_generator.pt'],
  },
];
const IMAGE_REPOSITORY = 'Comfy-Org/Qwen-Image-2.1';
const IMAGE_MODEL_PATHS = [
  'diffusion_models/qwen_image_2.1_int8_convrot.safetensors',
  'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
  'vae/qwen_image_2.1_vae_bf16.safetensors',
];
const UV_REPOSITORY = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_ASSET_NAME = 'uv-x86_64-pc-windows-msvc.zip';
const UV_DOWNLOAD_URL =
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET_NAME}`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const MAXIMUM_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAXIMUM_REDIRECTS = 20;
const SMALL_FILE_NETWORK_ATTEMPTS = 3;
const HUGGINGFACE_ORIGIN = 'https://huggingface.co';
const HUGGINGFACE_METADATA_MIRROR = 'https://hf-mirror.com';
const METADATA_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

class NonTransientHttpError extends Error {}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} does not provide a lowercase SHA256 digest`);
  }
  return value;
}

function encodeRepositoryPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function resolveUrl(repository, revision, path) {
  return `https://huggingface.co/${repository}/resolve/${revision}/${encodeRepositoryPath(path)}`;
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i.exec(part);
    if (!match) continue;
    const url = new URL(match[1]);
    if (
      url.protocol !== 'https:' ||
      !['huggingface.co', 'hf-mirror.com'].includes(url.hostname)
    ) {
      throw new Error('Hugging Face returned an unsafe pagination URL');
    }
    return url.href;
  }
  return null;
}

function metadataAttemptInit(init, timeoutMs) {
  const { signal: externalSignal, ...requestInit } = init;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    ...requestInit,
    signal: externalSignal
      ? AbortSignal.any([externalSignal, timeoutSignal])
      : timeoutSignal,
  };
}

async function fetchRepositoryMetadata(url, init, fetchImpl, timeoutMs) {
  const externalSignal = init.signal;
  const request = async (requestUrl) => {
    externalSignal?.throwIfAborted();
    const response = await fetchImpl(requestUrl, metadataAttemptInit(init, timeoutMs));
    if (response.status === 429 || response.status >= 500) {
      discardResponse(response);
      throw new Error(`Hugging Face metadata request failed for ${requestUrl}: HTTP ${response.status}`);
    }
    if (!response.ok) return { response, metadata: undefined };
    return { response, metadata: await response.json() };
  };
  try {
    return await request(url);
  } catch (error) {
    externalSignal?.throwIfAborted();
    if (!url.startsWith(`${HUGGINGFACE_ORIGIN}/api/models/`)) throw error;
    const mirrorUrl = `${HUGGINGFACE_METADATA_MIRROR}${url.slice(HUGGINGFACE_ORIGIN.length)}`;
    return request(mirrorUrl);
  }
}

async function readUrlWithCurl(url, signal) {
  signal?.throwIfAborted();
  const requestUrl = url.hostname === new URL(HUGGINGFACE_ORIGIN).hostname
    ? new URL(`${HUGGINGFACE_METADATA_MIRROR}${url.pathname}${url.search}`)
    : url;
  const { stdout } = await execFileAsync(
    'curl.exe',
    [
      '--fail',
      '--silent',
      '--show-error',
      '--location',
      '--connect-timeout',
      '15',
      '--max-time',
      '45',
      '--retry',
      '2',
      '--retry-all-errors',
      '--output',
      '-',
      requestUrl.href,
    ],
    {
      encoding: 'buffer',
      maxBuffer: MAXIMUM_UNTRACKED_FILE_BYTES + 1024,
      windowsHide: true,
      shell: false,
      ...(signal ? { signal } : {}),
    },
  );
  return new Response(Buffer.from(stdout), { status: 200 });
}

function withCurlFallback(fetchImpl) {
  const allowedHosts = new Set([
    'huggingface.co',
    'hf-mirror.com',
    'api.github.com',
    'github.com',
  ]);
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (!allowedHosts.has(url.hostname)) return fetchImpl(input, init);
    if (
      process.platform === 'win32' &&
      process.env.SMO_MANIFEST_CURL_FALLBACK === '1'
    ) {
      return readUrlWithCurl(url, init?.signal);
    }
    return fetchImpl(input, init);
  };
}

async function fetchRepositoryRevision(repository, fetchImpl, options = {}) {
  const url = `https://huggingface.co/api/models/${repository}`;
  const { response, metadata } = await fetchRepositoryMetadata(url, {
    headers: { Accept: 'application/json' },
    signal: options.signal,
  }, fetchImpl, options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(
      `Hugging Face repository info request failed for ${repository}: HTTP ${response.status}`,
    );
  }
  if (typeof metadata?.sha !== 'string' || !REVISION_PATTERN.test(metadata.sha)) {
    throw new Error(`Hugging Face repository info has no full commit SHA for ${repository}`);
  }
  return metadata.sha;
}

async function fetchRepositoryTree(repository, revision, fetchImpl, options = {}) {
  const files = [];
  const visited = new Set();
  let url =
    `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true`;

  while (url) {
    if (visited.has(url)) throw new Error(`Hugging Face pagination loop for ${repository}`);
    visited.add(url);
    const { response, metadata: entries } = await fetchRepositoryMetadata(url, {
      headers: { Accept: 'application/json' },
      signal: options.signal,
    }, fetchImpl, options.metadataTimeoutMs ?? METADATA_TIMEOUT_MS);
    if (!response.ok) {
      throw new Error(
        `Hugging Face tree request failed for ${repository}: HTTP ${response.status}`,
      );
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Hugging Face tree response is not an array for ${repository}`);
    }
    files.push(...entries.filter((entry) => entry?.type === 'file'));
    url = nextPageUrl(response.headers.get('link'));
  }
  return files;
}

function discardResponse(response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A redirect or HTTP status remains authoritative if body cleanup fails.
  }
}

function validatedHttpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Unsafe file redirect URL: ${url.href}`);
  }
  return url;
}

async function fetchSmallFileWithRedirects(repository, revision, path, fetchImpl) {
  let url = validatedHttpsUrl(resolveUrl(repository, revision, path));
  for (let redirectCount = 0; redirectCount <= MAXIMUM_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(60_000),
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirectCount === MAXIMUM_REDIRECTS) {
      throw new Error(`Too many redirects for ${repository}/${path}`);
    }
    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect has no Location for ${repository}/${path}`);
    discardResponse(response);
    url = validatedHttpsUrl(new URL(location, url).href);
  }
  throw new Error(`Unreachable redirect state for ${repository}/${path}`);
}

async function readSmallFileOnce(repository, revision, path, fetchImpl) {
  const response = await fetchSmallFileWithRedirects(
    repository,
    revision,
    path,
    fetchImpl,
  );
  if (!response.ok) {
    discardResponse(response);
    throw new NonTransientHttpError(
      `Could not read ${repository}/${path}: HTTP ${response.status}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

async function readSmallFileWithRetry(repository, revision, path, fetchImpl) {
  for (let attempt = 1; attempt <= SMALL_FILE_NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await readSmallFileOnce(repository, revision, path, fetchImpl);
    } catch (error) {
      if (error instanceof NonTransientHttpError || attempt === SMALL_FILE_NETWORK_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error(`Unreachable retry state for ${repository}/${path}`);
}

async function readSmallFileWithMirrorFallback(repository, revision, path, fetchImpl) {
  try {
    return await readSmallFileOnce(repository, revision, path, fetchImpl);
  } catch (error) {
    if (error instanceof NonTransientHttpError) throw error;
    const mirrorFetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname !== new URL(HUGGINGFACE_ORIGIN).hostname) {
        return fetchImpl(input, init);
      }
      return fetchImpl(
        `${HUGGINGFACE_METADATA_MIRROR}${url.pathname}${url.search}`,
        init,
      );
    };
    try {
      return await readSmallFileWithRetry(repository, revision, path, mirrorFetch);
    } catch (mirrorError) {
      if (
        process.platform !== 'win32' ||
        process.env.SMO_MANIFEST_CURL_FALLBACK !== '1'
      ) {
        throw mirrorError;
      }
      const mirrorUrl =
        `${HUGGINGFACE_METADATA_MIRROR}/${repository}/resolve/${revision}/${encodeRepositoryPath(path)}`;
      const { stdout } = await execFileAsync(
        'curl.exe',
        [
          '--fail',
          '--silent',
          '--show-error',
          '--location',
          '--connect-timeout',
          '15',
          '--max-time',
          '45',
          '--retry',
          '2',
          '--retry-all-errors',
          '--output',
          '-',
          mirrorUrl,
        ],
        {
          encoding: 'buffer',
          maxBuffer: MAXIMUM_UNTRACKED_FILE_BYTES + 1024,
          windowsHide: true,
          shell: false,
        },
      );
      return Buffer.from(stdout);
    }
  }
}

async function hashSmallFile(repository, revision, entry, fetchImpl) {
  assertPositiveSafeInteger(entry.size, `${repository}/${entry.path} size`);
  if (entry.size > MAXIMUM_UNTRACKED_FILE_BYTES) {
    throw new Error(
      `Refusing to hash a non-LFS file larger than ${MAXIMUM_UNTRACKED_FILE_BYTES} bytes: ` +
        `${repository}/${entry.path}`,
    );
  }
  let data;
  try {
    data = await readSmallFileWithMirrorFallback(repository, revision, entry.path, fetchImpl);
  } catch (error) {
    if (error instanceof NonTransientHttpError) throw error;
    throw new Error(`Could not read ${repository}/${entry.path}`, { cause: error });
  }
  if (data.length !== entry.size) {
    throw new Error(
      `Size mismatch for ${repository}/${entry.path}: expected ${entry.size}, received ${data.length}`,
    );
  }
  return createHash('sha256').update(data).digest('hex');
}

async function buildFile(
  repository,
  revision,
  entry,
  fetchImpl,
  { outputPath, requireLfs = false } = {},
) {
  if (process.env.SMO_MANIFEST_PROGRESS === '1') {
    console.error(`Verifying ${repository}/${entry?.path ?? 'unknown'}`);
  }
  if (
    typeof entry?.path !== 'string' ||
    entry.path.length === 0 ||
    entry.path.startsWith('/') ||
    entry.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe Hugging Face path in ${repository}`);
  }
  assertPositiveSafeInteger(entry.size, `${repository}/${entry.path} size`);
  const publishedSha256 = entry.lfs?.oid ?? entry.lfs?.sha256;
  if (requireLfs && !publishedSha256) {
    throw new Error(`${repository}/${entry.path} must provide an LFS SHA256 digest`);
  }
  const sha256 = publishedSha256
    ? assertSha256(publishedSha256.toLowerCase(), `${repository}/${entry.path}`)
    : await hashSmallFile(repository, revision, entry, fetchImpl);

  return {
    url: resolveUrl(repository, revision, entry.path),
    path: outputPath ?? `${repository.split('/')[1]}/${entry.path}`,
    size: entry.size,
    sha256,
    source: repository,
  };
}

function indexTtsAuxiliaryPath(repository, path) {
  if (repository === 'facebook/w2v-bert-2.0') {
    return `IndexTTS-2.5/hf_cache/w2v-bert-2.0/${path}`;
  }
  if (repository === 'funasr/campplus') {
    return 'IndexTTS-2.5/hf_cache/campplus_cn_common.bin';
  }
  if (repository === 'nvidia/bigvgan_v2_22khz_80band_256x') {
    return `IndexTTS-2.5/hf_cache/bigvgan/${path}`;
  }
  throw new Error(`Unsupported IndexTTS2.5 auxiliary repository: ${repository}`);
}

function isIndexTtsCoreFile(path) {
  return INDEX_TTS_CORE_PATHS.has(path) || path.startsWith(INDEX_TTS_QWEN_DIRECTORY);
}

async function fetchJson(url, fetchImpl, label) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}`);
  return response.json();
}

export async function buildUvRuntime(fetchImpl) {
  const releaseUrl =
    `https://api.github.com/repos/astral-sh/uv/releases/tags/${UV_VERSION}`;
  const revisionUrl =
    `https://api.github.com/repos/astral-sh/uv/git/ref/tags/${UV_VERSION}`;
  const [release, reference] = await Promise.all([
    fetchJson(releaseUrl, fetchImpl, 'Astral uv release request'),
    fetchJson(revisionUrl, fetchImpl, 'Astral uv tag request'),
  ]);
  if (release?.tag_name !== UV_VERSION) {
    throw new Error('Astral uv release has an unexpected version');
  }
  if (typeof reference?.object?.sha !== 'string' || !REVISION_PATTERN.test(reference.object.sha)) {
    throw new Error('Astral uv tag has no full commit SHA');
  }
  const asset = Array.isArray(release.assets)
    ? release.assets.find((candidate) => candidate?.name === UV_ASSET_NAME)
    : undefined;
  if (!asset || asset.browser_download_url !== UV_DOWNLOAD_URL) {
    throw new Error('Astral uv release has no official Windows x64 archive');
  }
  assertPositiveSafeInteger(asset.size, 'Astral uv archive size');
  const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '');
  if (!digest) throw new Error('Astral uv archive has no SHA256 digest');
  return {
    revision: reference.object.sha,
    file: {
      url: UV_DOWNLOAD_URL,
      path: `runtime/uv-${UV_VERSION}-x86_64-pc-windows-msvc.zip`,
      size: asset.size,
      sha256: digest[1],
      source: UV_REPOSITORY,
    },
  };
}

export async function buildMediaComponentManifest({
  component,
  fetchImpl = fetch,
  signal,
  metadataTimeoutMs,
}) {
  fetchImpl = withCurlFallback(fetchImpl);
  const metadataOptions = { signal, metadataTimeoutMs };
  if (component === 'image') {
    const revision = await fetchRepositoryRevision(
      IMAGE_REPOSITORY,
      fetchImpl,
      metadataOptions,
    );
    const tree = await fetchRepositoryTree(
      IMAGE_REPOSITORY,
      revision,
      fetchImpl,
      metadataOptions,
    );
    const entries = new Map(
      tree
        .filter((entry) => IMAGE_MODEL_PATHS.includes(entry.path))
        .map((entry) => [entry.path, entry]),
    );
    const files = [];
    for (const path of IMAGE_MODEL_PATHS) {
      const entry = entries.get(path);
      if (!entry) throw new Error(`The image component is missing ${IMAGE_REPOSITORY}/${path}`);
      files.push(
        await buildFile(IMAGE_REPOSITORY, revision, entry, fetchImpl, {
          outputPath: path,
          requireLfs: true,
        }),
      );
    }
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error('Image component total bytes must be a safe integer');
    }
    return {
      version: 1,
      components: {
        image: {
          id: 'image',
          target: 'comfy-models',
          revisions: { [IMAGE_REPOSITORY]: revision },
          files,
          totalBytes,
        },
      },
    };
  }
  if (component !== 'speech') {
    throw new Error('Only the speech and image media components have manifest generators');
  }

  const files = [];
  const revisions = {};
  const coreRevision = await fetchRepositoryRevision(
    INDEX_TTS_REPOSITORY,
    fetchImpl,
    metadataOptions,
  );
  revisions[INDEX_TTS_REPOSITORY] = coreRevision;
  const coreTree = await fetchRepositoryTree(
    INDEX_TTS_REPOSITORY,
    coreRevision,
    fetchImpl,
    metadataOptions,
  );
  const coreEntries = coreTree.filter((entry) => isIndexTtsCoreFile(entry.path));
  const corePaths = new Set(coreEntries.map((entry) => entry.path));
  for (const path of INDEX_TTS_CORE_PATHS) {
    if (!corePaths.has(path)) {
      throw new Error(`IndexTTS2 is missing the required model file: ${path}`);
    }
  }
  for (const entry of coreEntries) {
    files.push(await buildFile(INDEX_TTS_REPOSITORY, coreRevision, entry, fetchImpl));
  }

  for (const auxiliary of INDEX_TTS_AUXILIARIES) {
    const { repository, paths } = auxiliary;
    const revision = await fetchRepositoryRevision(
      repository,
      fetchImpl,
      metadataOptions,
    );
    revisions[repository] = revision;
    const tree = await fetchRepositoryTree(
      repository,
      revision,
      fetchImpl,
      metadataOptions,
    );
    const entries = new Map(tree.map((entry) => [entry.path, entry]));
    for (const path of paths) {
      const entry = entries.get(path);
      if (!entry) throw new Error(`IndexTTS2 auxiliary model is missing ${repository}/${path}`);
      files.push(await buildFile(repository, revision, entry, fetchImpl, {
        outputPath: indexTtsAuxiliaryPath(repository, path),
      }));
    }
  }
  const uv = await buildUvRuntime(fetchImpl);
  revisions[UV_REPOSITORY] = uv.revision;
  files.push(uv.file);
  if (files.length === 0) throw new Error('The speech component has no runtime files');

  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const paths = new Set();
  let totalBytes = 0;
  for (const file of files) {
    const normalizedPath = file.path.toLowerCase();
    if (paths.has(normalizedPath)) throw new Error(`Duplicate output path: ${file.path}`);
    paths.add(normalizedPath);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error('Speech component total bytes must be a safe integer');
    }
  }

  return {
    version: 1,
    components: {
      speech: {
        id: 'speech',
        target: 'component',
        revisions,
        files,
        totalBytes,
      },
    },
  };
}

function parseArguments(argv) {
  let component;
  let output;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--component' && !component) {
      component = argv[++index];
    } else if (flag === '--output' && !output) {
      output = argv[++index];
    } else {
      throw new Error(
        'Usage: node scripts/build-media-manifest.mjs --component speech|image [--output <manifest.json>]',
      );
    }
  }
  if (component !== 'speech' && component !== 'image') {
    throw new Error(
      'Usage: node scripts/build-media-manifest.mjs --component speech|image [--output <manifest.json>]',
    );
  }
  return { component, output };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const outputPath = options.output
    ? resolve(options.output)
    : fileURLToPath(new URL('../resources/environment/media-components.json', import.meta.url));
  const generated = await buildMediaComponentManifest({ component: options.component });
  let manifest = generated;
  try {
    const existing = JSON.parse(await readFile(outputPath, 'utf8'));
    manifest = {
      ...generated,
      components: {
        ...(existing.components ?? {}),
        ...generated.components,
      },
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const { files, totalBytes } = manifest.components[options.component];
  console.log(`${options.component}: ${files.length} files, ${totalBytes} bytes`);
  console.log(outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
