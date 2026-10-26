import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HardwareProfile, VideoMode } from '../shared/types';
import { applyHardwareProfile } from './hardware';

const WORKFLOW_FILENAMES: Record<VideoMode, string> = {
  text: 'text-ref2va.json',
  audio: 'audio-digital-human.json',
};
const DEFAULT_PROFILES_DIRECTORY = 'G:\\SMO-H3-Data\\workflow-profiles';

type WorkflowGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;

export interface ApplyHardwareWorkflowInput {
  mode: VideoMode;
  profile: HardwareProfile;
  confirmed: boolean;
  modelDirectory: string;
}

export interface HardwareWorkflowOptions {
  profilesDirectory?: string;
}

export interface HardwareWorkflowResult {
  path: string;
  profile: HardwareProfile;
}

export const activeWorkflows: Partial<Record<VideoMode, string>> = {};

function defaultWorkflowsDirectory(): string {
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

const workflowsDirectory = defaultWorkflowsDirectory();

function frozenWorkflowPath(mode: VideoMode): string {
  return join(workflowsDirectory, WORKFLOW_FILENAMES[mode]);
}

export async function applyHardwareWorkflow(
  input: ApplyHardwareWorkflowInput,
  options: HardwareWorkflowOptions = {},
): Promise<HardwareWorkflowResult> {
  const { mode, profile, confirmed, modelDirectory } = input;
  if (!confirmed) throw new Error('Hardware profile requires confirmation');

  const graph = JSON.parse(
    await readFile(frozenWorkflowPath(mode), 'utf8'),
  ) as WorkflowGraph;
  const copy = applyHardwareProfile(graph, profile, true, modelDirectory);
  const path = join(
    options.profilesDirectory ?? DEFAULT_PROFILES_DIRECTORY,
    `${profile.preset}-${mode}.json`,
  );
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;

  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(copy, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }

  activeWorkflows[mode] = path;
  return { path, profile };
}

export function resetHardwareWorkflow(mode: VideoMode): string {
  delete activeWorkflows[mode];
  return frozenWorkflowPath(mode);
}
