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

export interface HardwareWorkflowStoreOptions {
  profilesDirectory: string;
  workflowsDirectory?: string;
  logger?: Pick<Console, "warn">;
}

export interface HardwareWorkflowResult {
  path: string;
  profile: HardwareProfile;
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

function isAllowedProfileFilename(mode: VideoMode, value: string): boolean {
  return VALID_PRESETS.some(
    (preset) => value === preset + "-" + mode + ".json",
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporaryPath = path + "." + process.pid + "." + randomUUID() + ".tmp";
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, data, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n");
}

export class HardwareWorkflowStore {
  private readonly activeWorkflows = new Map<VideoMode, string>();
  private readonly profilesDirectory: string;
  private readonly workflowsDirectory: string;
  private readonly logger: Pick<Console, "warn">;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: HardwareWorkflowStoreOptions) {
    this.profilesDirectory = resolve(options.profilesDirectory);
    this.workflowsDirectory = options.workflowsDirectory ?? defaultWorkflowsDirectory();
    this.logger = options.logger ?? console;
  }

  getActiveWorkflow = (mode: VideoMode): string => {
    return this.activeWorkflows.get(mode) ?? this.frozenWorkflowPath(mode);
  };

  apply(input: ApplyHardwareWorkflowInput): Promise<HardwareWorkflowResult> {
    return this.withMutationLock(async () => {
      const { mode, profile, confirmed, modelDirectory } = input;
      if (!confirmed) throw new Error("Hardware profile requires confirmation");
      validatePreset(profile.preset);
      validateModelDirectory(modelDirectory);

      const graph = JSON.parse(
        await readFile(this.frozenWorkflowPath(mode), "utf8"),
      ) as WorkflowGraph;
      const copy = applyHardwareProfile(graph, profile, true, modelDirectory);
      const path = join(
        this.profilesDirectory,
        profile.preset + "-" + mode + ".json",
      );
      const previousTarget = await this.readTargetBackup(path);
      await writeJsonAtomic(path, copy);

      const previousActive = this.activeWorkflows.get(mode);
      this.activeWorkflows.set(mode, path);
      try {
        await this.persistActiveWorkflows();
      } catch (error) {
        this.restoreActiveWorkflow(mode, previousActive);
        try {
          await this.restoreTargetFile(path, previousTarget);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Hardware profile activation and target rollback both failed",
          );
        }
        throw error;
      }
      return { path, profile };
    });
  }

  reset(mode: VideoMode): Promise<string> {
    return this.withMutationLock(async () => {
      const previous = this.activeWorkflows.get(mode);
      this.activeWorkflows.delete(mode);
      try {
        await this.persistActiveWorkflows();
      } catch (error) {
        this.restoreActiveWorkflow(mode, previous);
        throw error;
      }
      return this.frozenWorkflowPath(mode);
    });
  }

  load(): Promise<void> {
    return this.withMutationLock(async () => {
      this.activeWorkflows.clear();
      let source: string;
      try {
        source = await readFile(
          join(this.profilesDirectory, ACTIVE_WORKFLOW_FILENAME),
          "utf8",
        );
      } catch (error) {
        if (errorCode(error) !== "ENOENT") {
          this.warnInvalidConfiguration(error);
        }
        return;
      }

      let value: unknown;
      try {
        value = JSON.parse(source);
      } catch (error) {
        this.warnInvalidConfiguration(error);
        return;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        this.warnInvalidConfiguration(new Error("Expected an object"));
        return;
      }

      const record = value as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (key) => !VIDEO_MODES.includes(key as VideoMode),
        )
      ) {
        this.warnInvalidConfiguration(new Error("Unsupported field"));
        return;
      }

      const validated = new Map<VideoMode, string>();
      for (const mode of VIDEO_MODES) {
        const candidate = record[mode];
        if (candidate === undefined) continue;
        if (
          typeof candidate !== "string" ||
          !isAllowedProfileFilename(mode, candidate)
        ) {
          this.warnInvalidConfiguration(new Error("Invalid workflow filename"));
          return;
        }
        const path = resolve(this.profilesDirectory, candidate);
        const relativePath = relative(this.profilesDirectory, path);
        if (relativePath !== candidate || isAbsolute(relativePath)) {
          this.warnInvalidConfiguration(new Error("Workflow path escapes its directory"));
          return;
        }
        try {
          if (!(await stat(path)).isFile()) {
            this.warnInvalidConfiguration(new Error("Workflow copy is not a file"));
            return;
          }
          validated.set(mode, path);
        } catch (error) {
          this.warnInvalidConfiguration(error);
          return;
        }
      }
      for (const [mode, path] of validated) {
        this.activeWorkflows.set(mode, path);
      }
    });
  }

  private frozenWorkflowPath(mode: VideoMode): string {
    return join(this.workflowsDirectory, WORKFLOW_FILENAMES[mode]);
  }

  private withMutationLock<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isAllowedProfilePath(mode: VideoMode, path: string): boolean {
    if (!isAbsolute(path)) return false;
    const relativePath = relative(this.profilesDirectory, resolve(path));
    return isAllowedProfileFilename(mode, relativePath);
  }

  private async persistActiveWorkflows(): Promise<void> {
    const persisted: PersistedActiveWorkflows = {};
    for (const mode of VIDEO_MODES) {
      const path = this.activeWorkflows.get(mode);
      if (path !== undefined && this.isAllowedProfilePath(mode, path)) {
        persisted[mode] = relative(this.profilesDirectory, path);
      }
    }
    await writeJsonAtomic(
      join(this.profilesDirectory, ACTIVE_WORKFLOW_FILENAME),
      persisted,
    );
  }

  private async readTargetBackup(path: string): Promise<Buffer | null> {
    try {
      return await readFile(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
  }

  private async restoreTargetFile(
    path: string,
    backup: Buffer | null,
  ): Promise<void> {
    if (backup === null) {
      await rm(path, { force: true });
      return;
    }
    await writeFileAtomic(path, backup);
  }

  private restoreActiveWorkflow(
    mode: VideoMode,
    previous: string | undefined,
  ): void {
    if (previous === undefined) {
      this.activeWorkflows.delete(mode);
    } else {
      this.activeWorkflows.set(mode, previous);
    }
  }

  private warnInvalidConfiguration(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      "[SMO.H3 Studio] Ignoring invalid active workflow configuration: " + detail,
    );
  }
}
