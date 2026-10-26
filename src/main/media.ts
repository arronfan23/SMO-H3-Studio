import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Protocol, ProtocolResponse } from 'electron';

export const MEDIA_SCHEME = 'smo-media';

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.mp4',
  '.webm',
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
]);

export interface MediaRegistryOptions {
  avatarsDirectory: string;
  inputDirectory: string;
  outputDirectory: string;
}

export type MediaProtocolRegistrar = Pick<Protocol, 'registerFileProtocol'>;
export type MediaSchemeRegistrar = Pick<Protocol, 'registerSchemesAsPrivileged'>;

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath.length > 0 &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

export class MediaRegistry {
  private readonly roots: string[];
  private readonly selectedFiles = new Set<string>();
  private readonly selectedImages = new Set<string>();
  private readonly pathsByToken = new Map<string, string>();
  private readonly tokensByPath = new Map<string, string>();

  constructor(options: MediaRegistryOptions) {
    this.roots = [
      options.avatarsDirectory,
      options.inputDirectory,
      options.outputDirectory,
    ].map((path) => resolve(path));
  }

  async authorizeSelectedFile(filePath: string): Promise<void> {
    this.selectedFiles.add(await this.realMediaFile(filePath));
  }

  async authorizeSelectedImage(filePath: string): Promise<void> {
    const canonicalPath = await this.realMediaFile(filePath);
    this.selectedFiles.add(canonicalPath);
    this.selectedImages.add(canonicalPath);
  }

  async isSelectedImage(filePath: string): Promise<boolean> {
    try {
      return this.selectedImages.has(await this.realMediaFile(filePath));
    } catch {
      return false;
    }
  }

  async createMediaUrl(filePath: string): Promise<string> {
    const canonicalPath = await this.realMediaFile(filePath);
    if (!this.selectedFiles.has(canonicalPath) && !(await this.isManaged(canonicalPath))) {
      throw new Error('Media file is not allowed');
    }

    const existingToken = this.tokensByPath.get(canonicalPath);
    if (existingToken !== undefined) {
      return `${MEDIA_SCHEME}://media/${existingToken}`;
    }
    const token = randomUUID();
    this.tokensByPath.set(canonicalPath, token);
    this.pathsByToken.set(token, canonicalPath);
    return `${MEDIA_SCHEME}://media/${token}`;
  }

  resolveMediaUrl(value: string): string | null {
    try {
      const url = new URL(value);
      if (
        url.protocol !== `${MEDIA_SCHEME}:` ||
        url.host !== 'media' ||
        url.username.length > 0 ||
        url.password.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0
      ) {
        return null;
      }
      const token = url.pathname.slice(1);
      return token.length > 0 && !token.includes('/')
        ? (this.pathsByToken.get(token) ?? null)
        : null;
    } catch {
      return null;
    }
  }

  private async realMediaFile(filePath: string): Promise<string> {
    if (filePath.trim().length === 0 || !isAbsolute(filePath)) {
      throw new Error('Media path must be absolute');
    }
    const extension = extname(filePath).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported media extension: ${extension || '(none)'}`);
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(filePath);
      if (!(await stat(canonicalPath)).isFile()) {
        throw new Error('Media path is not a file');
      }
    } catch {
      throw new Error('Media file does not exist or is not a file');
    }
    return canonicalPath;
  }

  private async isManaged(candidate: string): Promise<boolean> {
    for (const root of this.roots) {
      try {
        if (isWithin(await realpath(root), candidate)) {
          return true;
        }
      } catch {
        // A missing managed directory cannot authorize a file.
      }
    }
    return false;
  }
}

export function registerMediaProtocol(
  registry: MediaRegistry,
  registrar: MediaProtocolRegistrar,
): boolean {
  return registrar.registerFileProtocol(
    MEDIA_SCHEME,
    (request, callback: (response: string | ProtocolResponse) => void) => {
      const path = registry.resolveMediaUrl(request.url);
      callback(path === null ? { error: -6 } : { path });
    },
  );
}

export function registerPrivilegedMediaScheme(registrar: MediaSchemeRegistrar): void {
  registrar.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}
