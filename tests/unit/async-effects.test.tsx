import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../../src/renderer/App';
import { SettingsPage } from '../../src/renderer/SettingsPage';
import type { SmoApi } from '../../src/shared/ipc';
import type { Avatar } from '../../src/shared/types';

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
});
