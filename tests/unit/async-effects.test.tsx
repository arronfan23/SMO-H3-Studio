import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { SettingsPage } from '../../src/renderer/SettingsPage';
import type { SmoApi } from '../../src/shared/ipc';
import type { Avatar, HardwareInfo, HardwareProfile } from '../../src/shared/types';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn() };

});

const actualReact = await vi.importActual<typeof import('react')>('react');
const stateUpdates = vi.fn();
let observedSetters = new WeakMap<object, (...args: unknown[]) => void>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const hardwareInfo: HardwareInfo = {
  gpu: "Test GPU",
  vramGiB: 16,
  ramGiB: 64,
  driverVersion: "driver",
  cudaComputeCapability: "12.0",
  windowsVersion: "Windows 11",
  freeDiskGiB: 512,
};

const hardwareProfile: HardwareProfile = {
  preset: "balanced-16gb",
  modelPolicy: "int8",
  megapixels: 0.7,
  lowvram: true,
  tiling: "auto",
  requiresConfirmation: true,
};

function useHardwareApi(overrides: Partial<SmoApi["hardware"]> = {}): void {
  window.smo = {
    comfy: { health: async () => ({ system: {}, devices: [] }) },
    llm: { getProfile: async () => null },
    hardware: {
      detect: async () => hardwareInfo,
      recommend: async () => hardwareProfile,
      apply: async () => ({
        path: "G:\\SMO-H3-Data\\workflow-profiles\\balanced-16gb-text.json",
        profile: hardwareProfile,
      }),
      reset: async () => "G:\\resources\\workflows\\text-ref2va.json",
      ...overrides,
    },
  } as unknown as SmoApi;
}

async function renderDetectedHardware() {
  const view = render(<SettingsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "检测硬件" }));
  await screen.findByText(hardwareInfo.gpu);
  return view;
}

async function renderRecommendedHardware() {
  const view = await renderDetectedHardware();
  fireEvent.click(screen.getByRole("button", { name: "获取推荐" }));
  await screen.findByText(hardwareProfile.preset);
  return view;
}

beforeEach(() => {
  stateUpdates.mockClear();
  observedSetters = new WeakMap();
  (useState as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (initialState: unknown) => {
      const [value, setValue] = actualReact.useState(initialState);
      let observed = observedSetters.get(setValue);
      if (observed === undefined) {
        observed = (...args: unknown[]) => {
          stateUpdates(...args);
          setValue(...args);
        };
        observedSetters.set(setValue, observed);
      }
      return [value, observed];
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('async effects on unmounted components', () => {
  test('App does not update state when avatars:list settles after unmount', async () => {
    const request = deferred<Avatar[]>();
    window.smo = {
      avatars: { list: () => request.promise },
    } as unknown as SmoApi;
    const view = render(<App />);

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve([
      {
        id: 'avatar-1',
        name: 'Late avatar',
        photoPath: 'G:\\avatars\\late.png',
        createdAt: '2026-10-26T08:00:00.000Z',
      },
    ]);
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test('SettingsPage does not update state when health and profile settle after unmount', async () => {
    const health = deferred<{ system: Record<string, unknown>; devices: Record<string, unknown>[] }>();
    const profile = deferred<null>();
    window.smo = {
      comfy: { health: () => health.promise },
      llm: { getProfile: () => profile.promise },
    } as unknown as SmoApi;
    const view = render(<SettingsPage />);

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    health.resolve({ system: {}, devices: [] });
    profile.resolve(null);
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });
  test("SettingsPage does not update state when hardware detection settles after unmount", async () => {
    const detection = deferred<HardwareInfo>();
    window.smo = {
      comfy: { health: async () => ({ system: {}, devices: [] }) },
      llm: { getProfile: async () => null },
      hardware: { detect: () => detection.promise },
    } as unknown as SmoApi;
    const view = render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "检测硬件" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    detection.resolve({
      gpu: "Late GPU",
      vramGiB: 16,
      ramGiB: 64,
      driverVersion: "late-driver",
      cudaComputeCapability: "12.0",
      windowsVersion: "Windows 11",
      freeDiskGiB: 512,
    });
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test("SettingsPage does not update state when recommend settles after unmount", async () => {
    const request = deferred<HardwareProfile>();
    useHardwareApi({ recommend: () => request.promise });
    const view = await renderDetectedHardware();
    fireEvent.click(screen.getByRole("button", { name: "获取推荐" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve(hardwareProfile);
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test("SettingsPage does not update state when apply settles after unmount", async () => {
    const request = deferred<{ path: string; profile: HardwareProfile }>();
    useHardwareApi({ apply: () => request.promise });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = await renderRecommendedHardware();
    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve({ path: "G:\\late\\workflow.json", profile: hardwareProfile });
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test("SettingsPage does not update state when reset settles after unmount", async () => {
    const request = deferred<string>();
    useHardwareApi({ reset: () => request.promise });
    vi.stubGlobal("confirm", vi.fn(() => true));
    const view = render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "恢复默认" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve("G:\\resources\\workflows\\text-ref2va.json");
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test("SettingsPage does not update state when ComfyUI startup settles after unmount", async () => {
    const request = deferred<{ system: Record<string, unknown>; devices: Record<string, unknown>[] }>();
    window.smo = {
      comfy: {
        health: async () => {
          throw new Error("offline");
        },
        start: () => request.promise,
      },
      llm: { getProfile: async () => null },
    } as unknown as SmoApi;
    const view = render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "启动 ComfyUI" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve({ system: {}, devices: [] });
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test("SettingsPage does not update state when saving the LLM profile settles after unmount", async () => {
    const request = deferred<void>();
    window.smo = {
      comfy: { health: async () => ({ system: {}, devices: [] }) },
      llm: {
        getProfile: async () => ({
          baseUrl: "https://api.example.com/v1",
          model: "gpt-4o",
          keyStatus: "valid",
        }),
        saveProfile: () => request.promise,
      },
    } as unknown as SmoApi;
    const view = render(<SettingsPage />);
    fireEvent.change(await screen.findByLabelText("API 密钥"), {
      target: { value: "sk-late-save" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    view.unmount();
    const updateCount = stateUpdates.mock.calls.length;
    request.resolve(undefined);
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });
});
