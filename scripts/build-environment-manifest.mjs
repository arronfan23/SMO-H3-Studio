import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_BASE_URL =
  'https://github.com/arronfan23/SMO-H3-Runtime/releases/download/runtime-v1';
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA256 hexadecimal digest`);
  }
}

function parseHuggingFaceResolveUrl(modelUrl) {
  const url = new URL(modelUrl);
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
  if (url.protocol !== 'https:' || url.hostname !== 'huggingface.co' || !match) {
    throw new Error(`Unsupported Hugging Face resolve URL: ${modelUrl}`);
  }

  return {
    owner: decodeURIComponent(match[1]),
    repo: decodeURIComponent(match[2]),
    revision: decodeURIComponent(match[3]),
    path: decodeURIComponent(match[4]),
  };
}

async function fetchRepositoryMetadata(location, fetchImpl) {
  const apiUrl =
    `https://huggingface.co/api/models/${encodeURIComponent(location.owner)}` +
    `/${encodeURIComponent(location.repo)}?blobs=true`;

  let response;
  try {
    response = await fetchImpl(apiUrl, { signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(
      `Hugging Face metadata network request failed for ${location.owner}/${location.repo}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `Hugging Face metadata request failed for ${location.owner}/${location.repo}: ` +
        `HTTP ${response.status}`,
    );
  }

  const metadata = await response.json();
  if (!Array.isArray(metadata.siblings)) {
    throw new Error(`Hugging Face metadata has no siblings for ${location.owner}/${location.repo}`);
  }
  return metadata;
}

async function validateModelFiles(modelFiles, fetchImpl) {
  if (!Array.isArray(modelFiles) || modelFiles.length !== 10) {
    throw new Error('The reviewed source manifest must contain exactly 10 model files');
  }

  const repositoryRequests = new Map();
  for (const [index, model] of modelFiles.entries()) {
    const location = parseHuggingFaceResolveUrl(model.url);
    if (!location.revision || !location.path) {
      throw new Error(`Model ${index + 1} has an incomplete resolve URL`);
    }
    assertPositiveInteger(model.size, `Model ${location.path} size`);
    assertSha256(model.sha256, `Model ${location.path} SHA256`);
    if (typeof model.source !== 'string' || model.source.trim().length === 0) {
      throw new Error(`Model ${location.path} must retain its original source`);
    }

    const repositoryKey = `${location.owner}/${location.repo}`;
    if (!repositoryRequests.has(repositoryKey)) {
      repositoryRequests.set(
        repositoryKey,
        fetchRepositoryMetadata(location, fetchImpl),
      );
    }
    const metadata = await repositoryRequests.get(repositoryKey);
    const sibling = metadata.siblings.find((entry) => entry.rfilename === location.path);
    if (!sibling) {
      throw new Error(`Hugging Face metadata is missing ${repositoryKey}/${location.path}`);
    }
    if (sibling.size !== model.size) {
      throw new Error(
        `Hugging Face size mismatch for ${repositoryKey}/${location.path}: ` +
          `expected ${model.size}, received ${sibling.size}`,
      );
    }
    const publishedSha256 = sibling.lfs?.oid ?? sibling.lfs?.sha256;
    if (
      typeof publishedSha256 !== 'string' ||
      publishedSha256.toLowerCase() !== model.sha256.toLowerCase()
    ) {
      throw new Error(`Hugging Face SHA256 mismatch for ${repositoryKey}/${location.path}`);
    }
  }
}

function buildRuntime(id, runtime, reviewedRuntime) {
  if (!runtime || runtime.id !== id || !reviewedRuntime) {
    throw new Error(`Package metadata is missing runtime ${id}`);
  }
  if (typeof reviewedRuntime.displayName !== 'string' || !reviewedRuntime.displayName.trim()) {
    throw new Error(`Reviewed runtime ${id} has no display name`);
  }
  assertPositiveInteger(runtime.archiveSize, `${id} archiveSize`);
  assertSha256(runtime.archiveSha256, `${id} archiveSha256`);
  assertPositiveInteger(runtime.estimatedExtractedBytes, `${id} estimatedExtractedBytes`);

  if (!Array.isArray(runtime.archiveParts) || runtime.archiveParts.length === 0) {
    throw new Error(`${id} has no archive parts`);
  }
  let archivePartsSize = 0;
  const archiveParts = runtime.archiveParts.map((part, index) => {
    if (
      typeof part.path !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(part.path) ||
      !part.path.endsWith(`.part${index + 1}`)
    ) {
      throw new Error(`${id} archive part ${index + 1} has an invalid filename`);
    }
    assertPositiveInteger(part.size, `${id} archive part ${index + 1} size`);
    assertSha256(part.sha256, `${id} archive part ${index + 1} SHA256`);
    archivePartsSize += part.size;
    return {
      url: `${RELEASE_BASE_URL}/${part.path}`,
      path: part.path,
      size: part.size,
      sha256: part.sha256,
    };
  });
  if (archivePartsSize !== runtime.archiveSize) {
    throw new Error(`${id} archive-part sizes do not add up to archiveSize`);
  }

  for (const field of ['pythonPath', 'launchScript', 'ffprobePath']) {
    if (typeof runtime[field] !== 'string' || !runtime[field]) {
      throw new Error(`${id} is missing ${field}`);
    }
  }

  return {
    id,
    displayName: reviewedRuntime.displayName,
    archiveParts,
    archiveSize: runtime.archiveSize,
    archiveSha256: runtime.archiveSha256,
    estimatedExtractedBytes: runtime.estimatedExtractedBytes,
    pythonPath: runtime.pythonPath,
    launchScript: runtime.launchScript,
    ffprobePath: runtime.ffprobePath,
  };
}

export async function buildEnvironmentManifest({
  packageMetadata,
  sourceManifest,
  fetchImpl = fetch,
}) {
  if (packageMetadata?.version !== 1 || sourceManifest?.version !== 1) {
    throw new Error('Package metadata and the reviewed source manifest must use version 1');
  }

  await validateModelFiles(sourceManifest.modelFiles, fetchImpl);
  return {
    version: 1,
    runtimes: {
      sm89: buildRuntime(
        'sm89',
        packageMetadata.runtimes?.sm89,
        sourceManifest.runtimes?.sm89,
      ),
      sm120: buildRuntime(
        'sm120',
        packageMetadata.runtimes?.sm120,
        sourceManifest.runtimes?.sm120,
      ),
    },
    modelFiles: sourceManifest.modelFiles.map((model) => ({
      url: model.url,
      path: model.path,
      size: model.size,
      sha256: model.sha256,
      source: model.source,
    })),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !['--package-metadata', '--source-manifest', '--output'].includes(flag) ||
      !value
    ) {
      throw new Error(
        'Usage: node scripts/build-environment-manifest.mjs ' +
          '--package-metadata <metadata.json> --source-manifest <selflift-spark.json> ' +
          '--output <manifest.json>',
      );
    }
    options[flag] = value;
  }
  if (!options['--package-metadata'] || !options['--source-manifest'] || !options['--output']) {
    throw new Error('All manifest input and output arguments are required');
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [packageMetadata, sourceManifest] = await Promise.all([
    readJson(options['--package-metadata']),
    readJson(options['--source-manifest']),
  ]);
  const manifest = await buildEnvironmentManifest({ packageMetadata, sourceManifest });
  const outputPath = resolve(options['--output']);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(outputPath);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
