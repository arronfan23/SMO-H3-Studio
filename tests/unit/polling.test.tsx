import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JobStatus } from '../../src/renderer/JobStatus';
import { WorksPage } from '../../src/renderer/WorksPage';
import type { SmoApi } from '../../src/shared/ipc';
import type { Work, WorkStatus } from '../../src/shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makeWork(status: WorkStatus): Work {
  return {
    id: 'job-1',
    avatarId: 'avatar-1',
    mode: 'text',
    outputPath: null,
    status,
    createdAt: '2026-10-26T08:00:00.000Z',
    promptId: null,
    metadata: null,
    error: status === 'failed' ? '生成失败' : null,
  };
}

async function advanceTimers(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushPromises(): Promise<void> {
  await advanceTimers(0);
}

function controlledWorks() {
  const requests: Deferred<Work[]>[] = [];
  const list = vi.fn(() => {
    const request = deferred<Work[]>();
    requests.push(request);
    return request.promise;
  });
  return { list, requests };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function exposeWorks(list: ReturnType<typeof vi.fn>): void {
  window.smo = {
    works: { list },
    jobs: { cancel: vi.fn() },
    files: { mediaUrl: vi.fn() },
  } as unknown as SmoApi;
}

describe('JobStatus polling lifecycle', () => {
  test('polls running work every 400ms and stops permanently after done', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    expect(list).toHaveBeenCalledTimes(1);
    requests[0].resolve([makeWork('running')]);
    await flushPromises();
    expect(screen.getByText('运行中（running）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    await advanceTimers(399);
    expect(list).toHaveBeenCalledTimes(1);
    await advanceTimers(1);
    expect(list).toHaveBeenCalledTimes(2);
    requests[1].resolve([makeWork('done')]);
    await flushPromises();

    expect(screen.getByText('已完成（done）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test('does not schedule another poll after failed', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([makeWork('failed')]);
    await flushPromises();

    expect(screen.getByText('失败（failed）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test('clears a scheduled poll when the component becomes inactive', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = render(<JobStatus jobId="job-1" active />);
    requests[0].resolve([makeWork('running')]);
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(<JobStatus jobId="job-1" active={false} />);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test('clears a scheduled poll on unmount', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = render(<JobStatus jobId="job-1" />);
    requests[0].resolve([makeWork('running')]);
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('does not reschedule when an in-flight request settles after unmount', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);
    expect(list).toHaveBeenCalledTimes(1);

    view.unmount();
    requests[0].resolve([makeWork('running')]);
    await flushPromises();

    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('WorksPage polling lifecycle', () => {
  test('polls running work every 500ms and stops permanently after done', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<WorksPage avatars={[]} />);

    expect(list).toHaveBeenCalledTimes(1);
    requests[0].resolve([makeWork('running')]);
    await flushPromises();
    expect(screen.getByText('运行中（running）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(1);

    await advanceTimers(499);
    expect(list).toHaveBeenCalledTimes(1);
    await advanceTimers(1);
    expect(list).toHaveBeenCalledTimes(2);
    requests[1].resolve([makeWork('done')]);
    await flushPromises();

    expect(screen.getByText('已完成（done）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  test('does not schedule another poll after failed', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<WorksPage avatars={[]} />);

    requests[0].resolve([makeWork('failed')]);
    await flushPromises();

    expect(screen.getByText('失败（failed）')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test('clears a scheduled poll on unmount', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const view = render(<WorksPage avatars={[]} />);
    requests[0].resolve([makeWork('running')]);
    await flushPromises();
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('does not reschedule when the initial request settles after unmount', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<WorksPage avatars={[]} />);
    expect(list).toHaveBeenCalledTimes(1);

    view.unmount();
    requests[0].resolve([makeWork('running')]);
    await flushPromises();

    expect(vi.getTimerCount()).toBe(0);
    await advanceTimers(5000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
