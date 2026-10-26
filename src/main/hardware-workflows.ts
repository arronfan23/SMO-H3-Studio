import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { HardwarePreset, HardwareProfile, VideoMode } from '../shared/types';
import { applyHardwareProfile } from './hardware';
import { defaultWorkflowsDirectory } from './paths';

const WORKFLOW_FILENAMES: Record<VideoMode, string> = {
  text: 'text-ref2va.json',
  audio: 'audio-digital-human.json',
};
const DEFAULT_PROFILES_DIRECTORY = 'G:\\SMO-H3-Data\\workflow-profiles';
const VALID_PRESETS: readonly HardwarePreset[] = [
  'conservative',
  'balanced-16gb',
  'high-memory-candidate',
];

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

const activeWorkflows = new Map<VideoMode, string>();

const workflowsDirectory = defaultWorkflowsDirectory();

function frozenWorkflowPath(mode: VideoMode): string {
  return join(workflowsDirectory, WORKFLOW_FILENAMES[mode]);
}

export function getActiveWorkflow(mode: VideoMode): string {
  return activeWorkflows.get(mode) ?? frozenWorkflowPath(mode);
}

function validatePreset(preset: unknown): asserts preset is HardwarePreset {
  if (
    typeof preset !== 'string' ||
    !VALID_PRESETS.includes(preset as HardwarePreset)
  ) {
    throw new Error(`Invalid hardware preset: ${String(preset)}`);
  }
}

function validateModelDirectory(modelDirectory: unknown): asserts modelDirectory is string {
  if (typeof modelDirectory !== 'string' || modelDirectory.trim().length === 0) {
    throw new Error('modelDirectory must not be empty');
  }
}

export async function applyHardwareWorkflow(
  input: ApplyHardwareWorkflowInput,
  options: HardwareWorkflowOptions = {},
): Promise<HardwareWorkflowResult> {
  const { mode, profile, confirmed, modelDirectory } = input;
  if (!confirmed) throw new Error('Hardware profile requires confirmation');
  validatePreset(profile.preset);
  validateModelDirectory(modelDirectory);

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

  activeWorkflows.set(mode, path);
  return { path, profile };
}

export function resetHardwareWorkflow(mode: VideoMode): string {
  activeWorkflows.delete(mode);
  return frozenWorkflowPath(mode);
}
