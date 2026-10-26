import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { HardwarePreset, HardwareProfile, VideoMode } from "../shared/types";
import { applyHardwareProfile } from "./hardware";
import { defaultWorkflowsDirectory } from "./paths";

const WORKFLOW_FILENAMES: Record<VideoMode, string> = {
  text: "text-ref2va.json",
  audio: "audio-digital-human.json",
};
const VIDEO_MODES: readonly VideoMode[] = ["text", "audio"];
const ACTIVE_WORKFLOW_FILENAME = "active-workflows.json";
const DEFAULT_PROFILES_DIRECTORY = "G:\\SMO-H3-Data\\workflow-profiles";
const VALID_PRESETS: readonly HardwarePreset[] = [
  "conservative",
  "balanced-16gb",
  "high-memory-candidate",
];

type WorkflowGraph = Record<
  string,
  { class_type: string; inputs: Record<string, unknown> }
>;
type PersistedActiveWorkflows = Partial<Record<VideoMode, string>>;

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
let mutationQueue: Promise<void> = Promise.resolve();

function frozenWorkflowPath(mode: VideoMode): string {
  return join(workflowsDirectory, WORKFLOW_FILENAMES[mode]);
}

function profilesDirectory(options: HardwareWorkflowOptions): string {
  return options.profilesDirectory ?? DEFAULT_PROFILES_DIRECTORY;
}

function withMutationLock<T>(mutation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(mutation, mutation);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function getActiveWorkflow(mode: VideoMode): string {
  return activeWorkflows.get(mode) ?? frozenWorkflowPath(mode);
}

function validatePreset(preset: unknown): asserts preset is HardwarePreset {
  if (
    typeof preset !== "string" ||
    !VALID_PRESETS.includes(preset as HardwarePreset)
  ) {
    throw new Error("Invalid hardware preset: " + String(preset));
  }
}

function validateModelDirectory(modelDirectory: unknown): asserts modelDirectory is string {
  if (typeof modelDirectory !== "string" || modelDirectory.trim().length === 0) {
    throw new Error("modelDirectory must not be empty");
  }
}

function isAllowedProfilePath(
  mode: VideoMode,
  path: string,
  directory: string,
): boolean {
  if (!isAbsolute(path)) return false;
  const relativePath = relative(resolve(directory), resolve(path));
  return VALID_PRESETS.some(
    (preset) => relativePath === preset + "-" + mode + ".json",
  );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function persistActiveWorkflows(directory: string): Promise<void> {
  const persisted: PersistedActiveWorkflows = {};
  for (const mode of VIDEO_MODES) {
    const path = activeWorkflows.get(mode);
    if (path !== undefined && isAllowedProfilePath(mode, path, directory)) {
      persisted[mode] = path;
    }
  }
  await writeJsonAtomic(join(directory, ACTIVE_WORKFLOW_FILENAME), persisted);
}

export function loadActiveWorkflows(
  options: HardwareWorkflowOptions = {},
): Promise<void> {
  const directory = profilesDirectory(options);
  return withMutationLock(async () => {
    activeWorkflows.clear();
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(directory, ACTIVE_WORKFLOW_FILENAME), "utf8"),
      );
    } catch {
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }

    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !VIDEO_MODES.includes(key as VideoMode),
      )
    ) {
      return;
    }

    const validated = new Map<VideoMode, string>();
    for (const mode of VIDEO_MODES) {
      const candidate = record[mode];
      if (candidate === undefined) continue;
      if (
        typeof candidate !== "string" ||
        !isAllowedProfilePath(mode, candidate, directory)
      ) {
        return;
      }
      try {
        if (!(await stat(candidate)).isFile()) return;
        validated.set(mode, candidate);
      } catch {
        return;
      }
    }
    for (const [mode, path] of validated) {
      activeWorkflows.set(mode, path);
    }
  });
}

export function applyHardwareWorkflow(
  input: ApplyHardwareWorkflowInput,
  options: HardwareWorkflowOptions = {},
): Promise<HardwareWorkflowResult> {
  return withMutationLock(async () => {
    const { mode, profile, confirmed, modelDirectory } = input;
    if (!confirmed) throw new Error("Hardware profile requires confirmation");
    validatePreset(profile.preset);
    validateModelDirectory(modelDirectory);

    const graph = JSON.parse(
      await readFile(frozenWorkflowPath(mode), "utf8"),
    ) as WorkflowGraph;
    const copy = applyHardwareProfile(graph, profile, true, modelDirectory);
    const directory = profilesDirectory(options);
    const path = join(directory, profile.preset + "-" + mode + ".json");
    await writeJsonAtomic(path, copy);

    const previous = activeWorkflows.get(mode);
    activeWorkflows.set(mode, path);
    try {
      await persistActiveWorkflows(directory);
    } catch (error) {
      if (previous === undefined) {
        activeWorkflows.delete(mode);
      } else {
        activeWorkflows.set(mode, previous);
      }
      throw error;
    }
    return { path, profile };
  });
}

export function resetHardwareWorkflow(mode: VideoMode): string {
  activeWorkflows.delete(mode);
  return frozenWorkflowPath(mode);
}

export function resetHardwareWorkflowWithPersistence(
  mode: VideoMode,
  options: HardwareWorkflowOptions = {},
): Promise<string> {
  const directory = profilesDirectory(options);
  return withMutationLock(async () => {
    const previous = activeWorkflows.get(mode);
    activeWorkflows.delete(mode);
    try {
      await persistActiveWorkflows(directory);
    } catch (error) {
      if (previous === undefined) {
        activeWorkflows.delete(mode);
      } else {
        activeWorkflows.set(mode, previous);
      }
      throw error;
    }
    return frozenWorkflowPath(mode);
  });
}
