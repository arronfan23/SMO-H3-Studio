import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultWorkflowsDirectory(): string {
  const resourcesPath = (
    process as NodeJS.Process & { resourcesPath?: string }
  ).resourcesPath;
  if (resourcesPath) {
    const packagedRoot = join(resourcesPath, 'resources/workflows');
    if (existsSync(packagedRoot)) {
      return packagedRoot;
    }
  }
  return fileURLToPath(new URL('../../resources/workflows/', import.meta.url));
}
