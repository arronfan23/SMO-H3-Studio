import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import defaultManifest from '../../resources/environment/media-components.json';
import type {
  MediaComponentDefinition,
  MediaComponentFile,
  MediaComponentId,
  MediaComponentManifest,
  MediaComponentState,
} from '../shared/media-components';
import {
  downloadFile as defaultDownloadFile,
  type DownloadReceipt,
  modelDownloadUrls,
  runtimeDownloadUrls,
} from './download';
import type { ImageRuntimeInspection } from './environment-setup';

const WINDOWS_DEVICE_NAME_PATTERN =
  /^(?:CONIN\$|CONOUT\$|CON|PRN|AUX|NUL|COM[1-9\u00B9\u00B2\u00B3]|LPT[1-9\u00B9\u00B2\u00B3])(?:[ .]|$)/i;
const WINDOWS_ILLEGAL_CHARACTER_PATTERN = /[<>"|?*\x00-\x1F\x7F]/;

const httpsUrlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  },
  { message: 'URL must be a valid HTTPS URL without credentials' },
);

const relativePathSchema = z.string().refine(
  (value) => {
    if (
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('\\') ||
      value.includes(':') ||
      value.startsWith('/') ||
      WINDOWS_ILLEGAL_CHARACTER_PATTERN.test(value)
    ) {
      return false;
    }
    return value.split('/').every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !/[. ]$/.test(segment) &&
        !WINDOWS_DEVICE_NAME_PATTERN.test(segment),
    );
  },
  { message: 'Path must be a safe relative path without traversal' },
);

const byteSizeSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

function pathsCollide(first: string, second: string): boolean {
  const firstSegments = first.toLowerCase().split('/');
  const secondSegments = second.toLowerCase().split('/');
  const sharedLength = Math.min(firstSegments.length, secondSegments.length);
  return firstSegments
    .slice(0, sharedLength)
    .every((segment, index) => segment === secondSegments[index]);
}

function temporaryDownloadPaths(destination: string): string[] {
  return [
    `${destination}.part`,
    `${destination}.part.chunks.json`,
    `${destination}.part.chunks.json.tmp`,
    `${destination}.part.source`,
  ];
}

function occupiedPaths(path: string): string[] {
  return [path, ...temporaryDownloadPaths(path)];
}

async function clearTemporaryDownload(destination: string): Promise<void> {
  await Promise.all(
    temporaryDownloadPaths(destination).map((path) => rm(path, { force: true })),
  );
}

async function prepareDownloadSource(destination: string, url: string): Promise<void> {
  const sourcePath = `${destination}.part.source`;
  let previousSource: string | undefined;
  try {
    previousSource = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (previousSource !== url) await clearTemporaryDownload(destination);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(sourcePath, url, 'utf8');
}

function isDownloadHashMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Downloaded SHA256 does not match the expected SHA256'
  );
}

const mediaComponentFileSchema = z
  .object({
    url: httpsUrlSchema,
    path: relativePathSchema,
    size: byteSizeSchema,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'SHA256 must contain exactly 64 lowercase hexadecimal characters'),
    source: z.string().trim().min(1),
  })
  .strict();

const mediaComponentDefinitionSchema = z
  .object({
    id: z.enum(['speech', 'image']),
    target: z.enum(['component', 'comfy-models']).default('component'),
    revisions: z.record(
      z.string().trim().min(1),
      z.string().regex(/^[a-f0-9]{40}$/, 'Revision must be a full commit SHA'),
    ),
    files: z.array(mediaComponentFileSchema).min(1),
    totalBytes: byteSizeSchema,
  })
  .strict()
  .superRefine((component, context) => {
    const sources = new Set(component.files.map((file) => file.source));
    for (const source of sources) {
      if (!Object.hasOwn(component.revisions, source)) {
        context.addIssue({
          code: 'custom',
          message: `Missing revision for media source: ${source}`,
          path: ['revisions', source],
        });
      }
    }
    for (const source of Object.keys(component.revisions)) {
      if (!sources.has(source)) {
        context.addIssue({
          code: 'custom',
          message: `Revision has no media files: ${source}`,
          path: ['revisions', source],
        });
      }
    }

    let totalBytes = 0;
    const paths = new Map<string, number>();
    const occupied: Array<{ path: string; index: number }> = [];
    for (const [index, file] of component.files.entries()) {
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes)) {
        context.addIssue({
          code: 'custom',
          message: 'Component total bytes must be a safe integer',
          path: ['files'],
        });
        break;
      }

      const normalizedPath = file.path.toLowerCase();
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate media component path: ${file.path}`,
          path: ['files', index, 'path'],
        });
      } else {
        for (const path of occupiedPaths(file.path)) {
          const collision = occupied.find((candidate) =>
            pathsCollide(candidate.path, path),
          );
          if (collision) {
            context.addIssue({
              code: 'custom',
              message:
                `Media component file or temporary-path collision: ` +
                `${component.files[collision.index].path} and ${file.path}`,
              path: ['files', index, 'path'],
            });
            break;
          }
        }
      }
      paths.set(normalizedPath, index);
      occupied.push(...occupiedPaths(file.path).map((path) => ({ path, index })));
    }
    if (Number.isSafeInteger(totalBytes) && totalBytes !== component.totalBytes) {
      context.addIssue({
        code: 'custom',
        message: 'Component totalBytes must equal the sum of file sizes',
        path: ['totalBytes'],
      });
    }
  });

export const mediaComponentManifestSchema = z
  .object({
    version: z.literal(1),
    components: z
      .object({
        speech: mediaComponentDefinitionSchema.optional(),
        image: mediaComponentDefinitionSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const id of ['speech', 'image'] as const) {
      const component = manifest.components[id];
      if (component && component.id !== id) {
        context.addIssue({
          code: 'custom',
          message: `Media component ${id} must have a matching id`,
          path: ['components', id, 'id'],
        });
      }
    }
  });

export function parseMediaComponentManifest(input: unknown): ParsedMediaComponentManifest {
  return mediaComponentManifestSchema.parse(input) as ParsedMediaComponentManifest;
}

export type MediaComponentTarget = 'component' | 'comfy-models';
export type TargetedMediaComponentDefinition = MediaComponentDefinition & {
  target: MediaComponentTarget;
};
export type ParsedMediaComponentManifest = Omit<MediaComponentManifest, 'components'> & {
  components: Partial<Record<MediaComponentId, TargetedMediaComponentDefinition>>;
};

export interface MediaComponentServiceOptions {
  dataDirectory: string;
  modelDirectory?: string | (() => string);
  inspectImageRuntime?: () => ImageRuntimeInspection | Promise<ImageRuntimeInspection>;
  manifest?: unknown;
  downloadFile?: typeof defaultDownloadFile;
}

interface InstallFlight {
  controller: AbortController;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialState(
  id: MediaComponentId,
  component: MediaComponentDefinition | undefined,
): MediaComponentState {
  return {
    id,
    status: 'missing',
    downloadedBytes: 0,
    totalBytes: component?.totalBytes ?? 0,
    currentFile: null,
    error: null,
    active: false,
  };
}

export class MediaComponentService {
  private readonly manifest: ParsedMediaComponentManifest;
  private readonly states: Record<MediaComponentId, MediaComponentState>;
  private readonly flights = new Map<MediaComponentId, InstallFlight>();
  private readyModelDirectory: string | undefined;

  constructor(private readonly options: MediaComponentServiceOptions) {
    this.manifest = parseMediaComponentManifest(options.manifest ?? defaultManifest);
    this.states = {
      speech: initialState('speech', this.manifest.components.speech),
      image: initialState('image', this.manifest.components.image),
    };
  }

  getState(id: MediaComponentId): MediaComponentState {
    const component = this.manifest.components[id];
    if (
      id === 'image' &&
      component?.target === 'comfy-models' &&
      this.states[id].status === 'ready'
    ) {
      const currentModelDirectory = this.currentModelDirectory();
      if (
        this.readyModelDirectory === undefined ||
        !currentModelDirectory ||
        this.modelDirectoryKey(currentModelDirectory) !== this.readyModelDirectory
      ) {
        this.readyModelDirectory = undefined;
        this.setState(id, {
          status: 'missing',
          downloadedBytes: 0,
          currentFile: null,
          error: null,
          active: false,
        });
      }
    }
    return { ...this.states[id] };
  }

  install(id: MediaComponentId): Promise<MediaComponentState> {
    if (this.flights.has(id)) {
      return Promise.reject(new Error(`Media component ${id} is already installing`));
    }
    const component = this.manifest.components[id];
    if (!component) {
      return Promise.reject(new Error(`Media component ${id} is unavailable in the manifest`));
    }

    const flight = { controller: new AbortController() };
    this.flights.set(id, flight);
    if (id === 'image') this.readyModelDirectory = undefined;
    this.setState(id, {
      status: 'installing',
      downloadedBytes: 0,
      currentFile: null,
      error: null,
      active: true,
    });

    return this.runInstall(component, flight)
      .catch((error: unknown) => {
        if (flight.controller.signal.aborted) {
          this.setState(id, {
            status: 'missing',
            currentFile: null,
            error: null,
            active: false,
          });
        } else {
          this.setState(id, {
            status: 'failed',
            currentFile: null,
            error: errorMessage(error),
            active: false,
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.flights.get(id) === flight) this.flights.delete(id);
      });
  }

  cancel(id: MediaComponentId): void {
    const flight = this.flights.get(id);
    flight?.controller.abort(new Error(`Media component ${id} installation cancelled`));
  }

  private setState(id: MediaComponentId, state: Partial<MediaComponentState>): void {
    this.states[id] = { ...this.states[id], ...state, id };
  }

  private currentModelDirectory(): string | undefined {
    const configured = this.options.modelDirectory;
    return typeof configured === 'function' ? configured() : configured;
  }

  private modelDirectoryKey(modelDirectory: string): string {
    return resolve(modelDirectory).toLowerCase();
  }

  private requireInstallModelDirectory(
    component: TargetedMediaComponentDefinition,
  ): string | undefined {
    if (component.target !== 'comfy-models') return undefined;
    const modelDirectory = this.currentModelDirectory();
    if (!modelDirectory || basename(modelDirectory) !== 'diffusion_models') {
      throw new Error(
        'modelDirectory must end with diffusion_models for comfy-models media components',
      );
    }
    return modelDirectory;
  }

  private async inspectRuntime(
    component: TargetedMediaComponentDefinition,
    signal: AbortSignal,
  ): Promise<void> {
    if (component.id !== 'image') return;
    const inspect = this.options.inspectImageRuntime;
    if (!inspect) {
      throw new Error('Image runtime inspection is required before the component can be ready');
    }
    signal.throwIfAborted();
    const inspection = await inspect();
    signal.throwIfAborted();
    if (inspection.missingNodes.length > 0) {
      throw new Error(inspection.error ?? '运行时需要支持 Qwen Image 2.1');
    }
  }

  private destination(
    component: TargetedMediaComponentDefinition,
    file: MediaComponentFile,
    modelDirectory: string | undefined,
  ): string {
    let root: string;
    if (component.target === 'comfy-models') {
      if (!modelDirectory) throw new Error('Image installation model root was not captured');
      root = resolve(dirname(modelDirectory));
    } else {
      root = resolve(this.options.dataDirectory, 'components', component.id, 'models');
    }
    const destination = resolve(root, ...file.path.split('/'));
    const child = relative(root, destination);
    if (
      child.length === 0 ||
      child === '..' ||
      child.startsWith(`..${sep}`) ||
      isAbsolute(child)
    ) {
      throw new Error(`Media component path escapes its installation directory: ${file.path}`);
    }
    return destination;
  }

  private async runInstall(
    component: TargetedMediaComponentDefinition,
    flight: InstallFlight,
  ): Promise<MediaComponentState> {
    const { id, files, totalBytes } = component;
    const { signal } = flight.controller;
    const modelDirectory = this.requireInstallModelDirectory(component);
    await this.inspectRuntime(component, signal);
    let completedBytes = 0;
    let displayedBytes = 0;

    for (const file of files) {
      signal.throwIfAborted();
      const destination = this.destination(component, file, modelDirectory);
      this.setState(id, { currentFile: file.path });
      const hostname = new URL(file.url).hostname;
      const sources =
        hostname === 'huggingface.co'
          ? modelDownloadUrls(file)
          : hostname === 'github.com'
            ? runtimeDownloadUrls(file.url)
            : [file.url];
      let receipt: DownloadReceipt | undefined;
      for (const [sourceIndex, url] of sources.entries()) {
        signal.throwIfAborted();
        try {
          await prepareDownloadSource(destination, url);
          receipt = await (this.options.downloadFile ?? defaultDownloadFile)({
            url,
            destination,
            expectedSize: file.size,
            expectedSha256: file.sha256,
            signal,
            onProgress: (progress) => {
              displayedBytes = Math.max(
                displayedBytes,
                Math.min(totalBytes, completedBytes + progress.downloadedBytes),
              );
              this.setState(id, {
                downloadedBytes: displayedBytes,
                totalBytes,
                currentFile: file.path,
              });
            },
          });
          await clearTemporaryDownload(destination);
          break;
        } catch (error) {
          if (signal.aborted) throw error;
          const finalSource = sourceIndex === sources.length - 1;
          if (!finalSource || isDownloadHashMismatch(error)) {
            // A part can only be resumed by the exact source that wrote it.
            await clearTemporaryDownload(destination);
          }
          if (finalSource) throw error;
        }
      }
      if (!receipt) throw new Error(`No download source available for ${file.path}`);
      completedBytes += receipt.bytes;
      displayedBytes = Math.max(displayedBytes, Math.min(totalBytes, completedBytes));
      this.setState(id, {
        downloadedBytes: displayedBytes,
        currentFile: file.path,
      });
    }

    signal.throwIfAborted();
    // Reload ComfyUI's cached model choices after image files are in place.
    await this.inspectRuntime(component, signal);
    if (component.id === 'image') {
      this.readyModelDirectory = modelDirectory
        ? this.modelDirectoryKey(modelDirectory)
        : undefined;
    }
    this.setState(id, {
      status: 'ready',
      downloadedBytes: totalBytes,
      currentFile: null,
      error: null,
      active: false,
    });
    return this.getState(id);
  }
}
