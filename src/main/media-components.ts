import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import defaultManifest from '../../resources/environment/media-components.json';
import type {
  MediaComponentDefinition,
  MediaComponentFile,
  MediaComponentId,
  MediaComponentManifest,
  MediaComponentState,
} from '../shared/media-components';
import { downloadFile as defaultDownloadFile } from './download';

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

function occupiedPaths(path: string): string[] {
  return [
    path,
    `${path}.part`,
    `${path}.part.chunks.json`,
    `${path}.part.chunks.json.tmp`,
  ];
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

export function parseMediaComponentManifest(input: unknown): MediaComponentManifest {
  return mediaComponentManifestSchema.parse(input);
}

export interface MediaComponentServiceOptions {
  dataDirectory: string;
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
  private readonly manifest: MediaComponentManifest;
  private readonly states: Record<MediaComponentId, MediaComponentState>;
  private readonly flights = new Map<MediaComponentId, InstallFlight>();

  constructor(private readonly options: MediaComponentServiceOptions) {
    this.manifest = parseMediaComponentManifest(options.manifest ?? defaultManifest);
    this.states = {
      speech: initialState('speech', this.manifest.components.speech),
      image: initialState('image', this.manifest.components.image),
    };
  }

  getState(id: MediaComponentId): MediaComponentState {
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

  private destination(id: MediaComponentId, file: MediaComponentFile): string {
    const root = resolve(this.options.dataDirectory, 'components', id, 'models');
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
    component: MediaComponentDefinition,
    flight: InstallFlight,
  ): Promise<MediaComponentState> {
    const { id, files, totalBytes } = component;
    const { signal } = flight.controller;
    let completedBytes = 0;
    let displayedBytes = 0;

    for (const file of files) {
      signal.throwIfAborted();
      const destination = this.destination(id, file);
      this.setState(id, { currentFile: file.path });
      const receipt = await (this.options.downloadFile ?? defaultDownloadFile)({
        url: file.url,
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
      completedBytes += receipt.bytes;
      displayedBytes = Math.max(displayedBytes, Math.min(totalBytes, completedBytes));
      this.setState(id, {
        downloadedBytes: displayedBytes,
        currentFile: file.path,
      });
    }

    signal.throwIfAborted();
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
