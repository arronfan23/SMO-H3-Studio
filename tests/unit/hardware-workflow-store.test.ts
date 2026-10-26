// @vitest-environment node

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ApplyHardwareWorkflowInput,
  HardwareWorkflowResult,
} from "../../src/main/hardware-workflows";
import * as hardwareWorkflows from "../../src/main/hardware-workflows";
import type { HardwareProfile, VideoMode } from "../../src/shared/types";

const INT8_UNET = "minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors";
const workflowsDirectory = fileURLToPath(
  new URL("../../resources/workflows/", import.meta.url),
);
const frozenTextPath = join(workflowsDirectory, "text-ref2va.json");
const temporaryDirectories: string[] = [];

interface WorkflowStore {
  getActiveWorkflow(mode: VideoMode): string;
  load(): Promise<void>;
  apply(input: ApplyHardwareWorkflowInput): Promise<HardwareWorkflowResult>;
  reset(mode: VideoMode): Promise<string>;
}

interface StoreOptions {
  profilesDirectory: string;
  logger?: { warn(message: string): void };
}

function createStore(options: StoreOptions): WorkflowStore {
  const Store = (
    hardwareWorkflows as unknown as {
      HardwareWorkflowStore?: new (options: StoreOptions) => WorkflowStore;
    }
  ).HardwareWorkflowStore;
  expect(Store).toBeTypeOf("function");
  return new (Store as new (options: StoreOptions) => WorkflowStore)(options);
}

function makeProfile(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    preset: "balanced-16gb",
    modelPolicy: "int8",
    megapixels: 0.7,
    lowvram: true,
    tiling: "auto",
    requiresConfirmation: true,
    ...overrides,
  };
}

async function makeHarness() {
  const directory = await mkdtemp(join(tmpdir(), "smo-h3-workflow-store-"));
  temporaryDirectories.push(directory);
  const modelDirectory = join(directory, "models");
  const profilesDirectory = join(directory, "workflow-profiles");
  await Promise.all([
    mkdir(modelDirectory, { recursive: true }),
    mkdir(profilesDirectory, { recursive: true }),
  ]);
  await writeFile(join(modelDirectory, INT8_UNET), "int8");
  return { directory, modelDirectory, profilesDirectory };
}

function applyInput(
  harness: { modelDirectory: string },
  overrides: Partial<HardwareProfile> = {},
): ApplyHardwareWorkflowInput {
  return {
    mode: "text",
    profile: makeProfile(overrides),
    confirmed: true,
    modelDirectory: harness.modelDirectory,
  };
}

async function sabotageActivePersistence(profilesDirectory: string): Promise<void> {
  const path = join(profilesDirectory, "active-workflows.json");
  await rm(path, { force: true });
  await mkdir(path);
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("HardwareWorkflowStore", () => {
  test("keeps active state and loads isolated between instances", async () => {
    const first = await makeHarness();
    const second = await makeHarness();
    const firstStore = createStore({ profilesDirectory: first.profilesDirectory });
    const secondStore = createStore({ profilesDirectory: second.profilesDirectory });

    const applied = await firstStore.apply(applyInput(first));
    await secondStore.load();

    expect(firstStore.getActiveWorkflow("text")).toBe(applied.path);
    expect(secondStore.getActiveWorkflow("text")).toBe(frozenTextPath);
  });

  test("persists relative filenames and resolves them after directory migration", async () => {
    const first = await makeHarness();
    const migrated = await makeHarness();
    const firstStore = createStore({ profilesDirectory: first.profilesDirectory });
    const applied = await firstStore.apply(applyInput(first));
    const filename = "balanced-16gb-text.json";

    expect(
      JSON.parse(
        await readFile(join(first.profilesDirectory, "active-workflows.json"), "utf8"),
      ),
    ).toEqual({ text: filename });
    await Promise.all([
      copyFile(applied.path, join(migrated.profilesDirectory, filename)),
      copyFile(
        join(first.profilesDirectory, "active-workflows.json"),
        join(migrated.profilesDirectory, "active-workflows.json"),
      ),
    ]);
    const migratedStore = createStore({ profilesDirectory: migrated.profilesDirectory });
    await migratedStore.load();

    expect(migratedStore.getActiveWorkflow("text")).toBe(
      join(migrated.profilesDirectory, filename),
    );
    expect(firstStore.getActiveWorkflow("text")).toBe(applied.path);
  });

  test("warns and restores frozen defaults for a mixed invalid configuration", async () => {
    const harness = await makeHarness();
    const warnings: string[] = [];
    const store = createStore({
      profilesDirectory: harness.profilesDirectory,
      logger: { warn: (message) => warnings.push(message) },
    });
    await store.apply(applyInput(harness));
    await writeFile(
      join(harness.profilesDirectory, "active-workflows.json"),
      JSON.stringify({ text: "balanced-16gb-text.json", audio: "../outside.json" }),
    );

    await store.load();

    expect(store.getActiveWorkflow("text")).toBe(frozenTextPath);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/active workflow/i);
  });

  test("restores the previous target file when active persistence fails", async () => {
    const harness = await makeHarness();
    const store = createStore({ profilesDirectory: harness.profilesDirectory });
    const applied = await store.apply(
      applyInput(harness, { preset: "conservative", megapixels: 0.4 }),
    );
    const previousCopy = await readFile(applied.path);
    await sabotageActivePersistence(harness.profilesDirectory);

    await expect(
      store.apply(applyInput(harness, { preset: "conservative", megapixels: 1 })),
    ).rejects.toThrow();

    expect(await readFile(applied.path)).toEqual(previousCopy);
    expect(store.getActiveWorkflow("text")).toBe(applied.path);
  });

  test("deletes a new target and restores previous active state after persistence failure", async () => {
    const harness = await makeHarness();
    const store = createStore({ profilesDirectory: harness.profilesDirectory });
    const previous = await store.apply(applyInput(harness));
    const newTarget = join(harness.profilesDirectory, "conservative-text.json");
    await sabotageActivePersistence(harness.profilesDirectory);

    await expect(
      store.apply(applyInput(harness, { preset: "conservative" })),
    ).rejects.toThrow();

    expect(store.getActiveWorkflow("text")).toBe(previous.path);
    await expect(readFile(newTarget)).rejects.toThrow();
  });

  test("restores active state when reset persistence fails", async () => {
    const harness = await makeHarness();
    const store = createStore({ profilesDirectory: harness.profilesDirectory });
    const applied = await store.apply(applyInput(harness));
    await sabotageActivePersistence(harness.profilesDirectory);

    await expect(store.reset("text")).rejects.toThrow();

    expect(store.getActiveWorkflow("text")).toBe(applied.path);
  });
});
