import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useActiveJob } from '../../src/renderer/useActiveJob';
import type { SmoApi } from '../../src/shared/ipc';

interface JobState {
  activeId: string | null;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn() };
});

const actualReact = await vi.importActual<typeof import('react')>('react');
const stateUpdates = vi.fn();
let observedSetters = new WeakMap<object, (...args: unknown[]) => void>();
let hidden = false;

function exposeGetState(getState: ReturnType<typeof vi.fn>): void {
  window.smo = { jobs: { getState } } as unknown as SmoApi;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function setHidden(next: boolean): Promise<void> {
  hidden = next;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useActiveJob', () => {
  test('polls every 500ms and exposes activeId, busy, and refresh', async () => {
    const getState = vi.fn().mockResolvedValue({ activeId: null });
    exposeGetState(getState);
    const { result } = renderHook(() => useActiveJob());

    expect(getState).toHaveBeenCalledTimes(1);
    await flushPromises();
    expect(result.current).toMatchObject({ activeId: null, busy: false });

    getState.mockResolvedValue({ activeId: 'one' });
    await act(async () => result.current.refresh());
    expect(getState).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ activeId: 'one', busy: true });

    await advanceTimers(499);
    expect(getState).toHaveBeenCalledTimes(2);
    await advanceTimers(1);
    expect(getState).toHaveBeenCalledTimes(3);

    getState.mockResolvedValue({ activeId: null });
    await advanceTimers(500);
    expect(getState).toHaveBeenCalledTimes(4);
    expect(result.current).toMatchObject({ activeId: null, busy: false });
  });

  test('stops polling while hidden and ignores an in-flight result', async () => {
    const request = deferred<JobState>();
    const getState = vi.fn()
      .mockReturnValueOnce(request.promise)
      .mockResolvedValue({ activeId: null });
    exposeGetState(getState);
    const { result } = renderHook(() => useActiveJob());

    expect(getState).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    const updateCount = stateUpdates.mock.calls.length;

    request.resolve({ activeId: 'hidden-late' });
    await flushPromises();
    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
    expect(result.current).toMatchObject({ activeId: null, busy: false });

    await advanceTimers(5_000);
    expect(getState).toHaveBeenCalledTimes(1);

    await setHidden(false);
    await flushPromises();
    expect(getState).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  test('accepts only the latest request when responses resolve out of order', async () => {
    const older = deferred<JobState>();
    const latest = deferred<JobState>();
    const getState = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(latest.promise);
    exposeGetState(getState);
    const { result } = renderHook(() => useActiveJob());

    let latestRefresh!: Promise<void>;
    act(() => {
      latestRefresh = result.current.refresh();
    });
    expect(getState).toHaveBeenCalledTimes(2);

    await act(async () => {
      latest.resolve({ activeId: 'latest' });
      await latestRefresh;
    });
    expect(result.current.activeId).toBe('latest');
    const updateCount = stateUpdates.mock.calls.length;

    older.resolve({ activeId: 'stale' });
    await flushPromises();

    expect(result.current.activeId).toBe('latest');
    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test('invalidates a pre-hide request after visibility resumes', async () => {
    const beforeHide = deferred<JobState>();
    const afterResume = deferred<JobState>();
    const getState = vi.fn()
      .mockReturnValueOnce(beforeHide.promise)
      .mockReturnValueOnce(afterResume.promise);
    exposeGetState(getState);
    const { result } = renderHook(() => useActiveJob());

    await setHidden(true);
    await setHidden(false);
    expect(getState).toHaveBeenCalledTimes(2);

    afterResume.resolve({ activeId: 'after-resume' });
    await flushPromises();
    expect(result.current.activeId).toBe('after-resume');
    const updateCount = stateUpdates.mock.calls.length;

    beforeHide.resolve({ activeId: 'before-hide' });
    await flushPromises();

    expect(result.current.activeId).toBe('after-resume');
    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
  });

  test('does not update state when an in-flight request settles after unmount', async () => {
    const request = deferred<JobState>();
    const getState = vi.fn(() => request.promise);
    exposeGetState(getState);
    const view = renderHook(() => useActiveJob());

    expect(getState).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    const updateCount = stateUpdates.mock.calls.length;

    request.resolve({ activeId: 'unmounted-late' });
    await flushPromises();

    expect(stateUpdates).toHaveBeenCalledTimes(updateCount);
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
