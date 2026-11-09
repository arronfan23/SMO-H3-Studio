import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPEECH_REPOSITORIES = [
  'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
  'Qwen/Qwen3-TTS-Tokenizer-12Hz',
];
const UV_REPOSITORY = 'astral-sh/uv';
const UV_VERSION = '0.11.13';
const UV_ASSET_NAME = 'uv-x86_64-pc-windows-msvc.zip';
const UV_DOWNLOAD_URL =
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${UV_ASSET_NAME}`;
const RUNTIME_EXTENSIONS = [
  '.safetensors',
  '.json',
  '.txt',
  '.model',
  '.vocab',
  '.merges',
  '.jinja',
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const MAXIMUM_UNTRACKED_FILE_BYTES = 32 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAXIMUM_REDIRECTS = 20;
const SMALL_FILE_NETWORK_ATTEMPTS = 3;

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

function isRuntimeFile(path) {
  const name = path.split('/').at(-1) ?? '';
  if (/^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:\.[a-z0-9]+)?$/i.test(name)) {
    return true;
  }
  if (/\.gguf$/i.test(name)) return false;
  return RUNTIME_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/i.exec(part);
    if (!match) continue;
    const url = new URL(match[1]);
    if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co') {
      throw new Error('Hugging Face returned an unsafe pagination URL');
    }
    return url.href;
  }
  return null;
}

async function fetchRepositoryRevision(repository, fetchImpl) {
  const url = `https://huggingface.co/api/models/${repository}`;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Hugging Face repository info request failed for ${repository}: HTTP ${response.status}`,
    );
  }
  const metadata = await response.json();
  if (typeof metadata?.sha !== 'string' || !REVISION_PATTERN.test(metadata.sha)) {
    throw new Error(`Hugging Face repository info has no full commit SHA for ${repository}`);
  }
  return metadata.sha;
}

async function fetchRepositoryTree(repository, revision, fetchImpl) {
  const files = [];
  const visited = new Set();
  let url =
    `https://huggingface.co/api/models/${repository}/tree/${revision}?recursive=true`;

  while (url) {
    if (visited.has(url)) throw new Error(`Hugging Face pagination loop for ${repository}`);
    visited.add(url);
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(
        `Hugging Face tree request failed for ${repository}: HTTP ${response.status}`,
      );
    }
    const entries = await response.json();
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
    data = await readSmallFileWithRetry(repository, revision, entry.path, fetchImpl);
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

async function buildFile(repository, revision, entry, fetchImpl) {
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
  const sha256 = publishedSha256
    ? assertSha256(publishedSha256.toLowerCase(), `${repository}/${entry.path}`)
    : await hashSmallFile(repository, revision, entry, fetchImpl);

  return {
    url: resolveUrl(repository, revision, entry.path),
    path: `${repository.split('/')[1]}/${entry.path}`,
    size: entry.size,
    sha256,
    source: repository,
  };
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

export async function buildMediaComponentManifest({ component, fetchImpl = fetch }) {
  if (component !== 'speech') {
    throw new Error('Only the speech media component has a manifest generator');
  }

  const files = [];
  const revisions = {};
  for (const repository of SPEECH_REPOSITORIES) {
    const revision = await fetchRepositoryRevision(repository, fetchImpl);
    revisions[repository] = revision;
    const tree = await fetchRepositoryTree(repository, revision, fetchImpl);
    const selected = tree
      .filter((entry) => isRuntimeFile(entry.path))
      .sort((a, b) => a.path.localeCompare(b.path, 'en'));
    for (const entry of selected) {
      files.push(await buildFile(repository, revision, entry, fetchImpl));
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
        'Usage: node scripts/build-media-manifest.mjs --component speech [--output <manifest.json>]',
      );
    }
  }
  if (component !== 'speech') {
    throw new Error(
      'Usage: node scripts/build-media-manifest.mjs --component speech [--output <manifest.json>]',
    );
  }
  return { component, output };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = await buildMediaComponentManifest({ component: options.component });
  const outputPath = options.output
    ? resolve(options.output)
    : fileURLToPath(new URL('../resources/environment/media-components.json', import.meta.url));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const { files, totalBytes } = manifest.components.speech;
  console.log(`speech: ${files.length} files, ${totalBytes} bytes`);
  console.log(outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
