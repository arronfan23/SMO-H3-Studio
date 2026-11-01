import { act, cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JobStatus } from '../../src/renderer/JobStatus';
import { WorkProgressBar } from '../../src/renderer/WorkProgressBar';
import { WorksPage } from '../../src/renderer/WorksPage';
import { readWorkExecution } from '../../src/renderer/ui';
import type { SmoApi } from '../../src/shared/ipc';
import type { Work, WorkExecutionState, WorkStatus } from '../../src/shared/types';

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

function makeWork(status: WorkStatus, metadata: Work['metadata'] = null): Work {
  return {
    id: 'job-1',
    avatarId: 'avatar-1',
    mode: 'text',
    outputPath: null,
    status,
    createdAt: '2026-10-26T08:00:00.000Z',
    title: null,
    completedAt: null,
    promptId: null,
    metadata,
    error: status === 'failed' ? '任务失败详情' : null,
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
    works: { list, delete: vi.fn() },
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

describe('WorkProgressBar accessibility', () => {
  test('shows 50% with aria-valuenow while running with frame progress', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([
      makeWork('running', { progress: { value: 12, max: 24 } }),
    ]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    view.unmount();
  });

  test('shows 100% with aria-valuenow when done', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([makeWork('done')]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100%')).toBeInTheDocument();
    view.unmount();
  });

  test('pending without frame progress has no aria-valuenow and shows preparation text', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([makeWork('pending')]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('准备中…')).toBeInTheDocument();
    view.unmount();
  });

  test('failed keeps the last known progress', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([
      makeWork('failed', { progress: { value: 12, max: 24 } }),
    ]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(within(bar).getByText(/失败/)).toBeInTheDocument();
    view.unmount();
  });

  test('failed without progress has no aria-valuenow and shows an error state', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([makeWork('failed')]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByText('生成失败')).toBeInTheDocument();
    view.unmount();
  });

  test('renders real frame progress inside the works list', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    const view = render(<WorksPage avatars={[]} />);

    requests[0].resolve([
      makeWork('running', { progress: { value: 12, max: 24 } }),
    ]);
    await flushPromises();

    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    view.unmount();
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

const STAGE_NOW = Date.parse('2026-10-28T00:05:00.000Z');
const STAGE_START = '2026-10-28T00:00:00.000Z';

function makeExecution(overrides: Partial<WorkExecutionState> = {}): WorkExecutionState {
  return {
    stage: 'backend-queued',
    updatedAt: STAGE_START,
    lastProgressAt: STAGE_START,
    ...overrides,
  };
}

describe('readWorkExecution', () => {
  test('returns null when metadata or execution is missing', () => {
    expect(readWorkExecution(null)).toBeNull();
    expect(readWorkExecution(undefined)).toBeNull();
    expect(readWorkExecution(makeWork('running'))).toBeNull();
    expect(readWorkExecution(makeWork('running', {}))).toBeNull();
  });

  test('returns a validated execution snapshot for well-formed metadata', () => {
    const execution = makeExecution({ queuePosition: 3 });
    expect(readWorkExecution(makeWork('running', { execution }))).toEqual(execution);
  });

  test('returns null for corrupted execution data', () => {
    const work = makeWork('running');
    const corrupted = (execution: unknown): Work => ({
      ...work,
      metadata: { execution } as Work['metadata'],
    });
    expect(
      readWorkExecution(corrupted({ ...makeExecution(), stage: 'bogus' })),
    ).toBeNull();
    expect(
      readWorkExecution(corrupted({ ...makeExecution(), updatedAt: 'not-a-date' })),
    ).toBeNull();
    expect(
      readWorkExecution(corrupted({ ...makeExecution(), lastProgressAt: 42 })),
    ).toBeNull();
    expect(
      readWorkExecution(corrupted({ ...makeExecution(), queuePosition: -1 })),
    ).toBeNull();
    expect(readWorkExecution(corrupted('broken'))).toBeNull();
  });
});

describe('WorkProgressBar execution stages', () => {
  test('backend-queued shows queue position and elapsed time without a fake percent', () => {
    render(
      <WorkProgressBar
        status="running"
        progress={null}
        execution={makeExecution({ queuePosition: 1 })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.getByText(/等待 ComfyUI/)).toBeInTheDocument();
    expect(screen.getByText(/前方 1 个任务/)).toBeInTheDocument();
    expect(screen.getByText(/已用时间/)).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    const bar = screen.getByRole('progressbar');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveAttribute('aria-description', expect.stringContaining('等待 ComfyUI'));
  });

  test('executing shows the model loading stage text', () => {
    render(
      <WorkProgressBar
        status="running"
        progress={null}
        execution={makeExecution({ stage: 'executing' })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.getByText('正在加载模型并执行节点')).toBeInTheDocument();
  });

  test('sampling keeps the real frame percent alongside the stage text', () => {
    render(
      <WorkProgressBar
        status="running"
        progress={{ value: 12, max: 24 }}
        execution={makeExecution({ stage: 'sampling' })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/正在采样生成/)).toBeInTheDocument();
  });

  test('finalizing shows the output reading stage text', () => {
    render(
      <WorkProgressBar
        status="running"
        progress={null}
        execution={makeExecution({ stage: 'finalizing' })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.getByText('正在读取输出并收尾')).toBeInTheDocument();
  });

  test('warns after 15 minutes without new frames while pending or running', () => {
    const { unmount } = render(
      <WorkProgressBar
        status="pending"
        progress={null}
        execution={makeExecution({ lastProgressAt: STAGE_START })}
        createdAt={STAGE_START}
        now={STAGE_NOW + 10 * 60 * 1000}
      />,
    );
    expect(screen.getByText(/长时间没有新进展，可继续等待或取消/)).toBeInTheDocument();
    unmount();

    render(
      <WorkProgressBar
        status="running"
        progress={null}
        execution={makeExecution({ lastProgressAt: '2026-10-28T00:10:00.000Z' })}
        createdAt={STAGE_START}
        now={Date.parse('2026-10-28T00:25:00.000Z')}
      />,
    );
    expect(screen.getByText(/长时间没有新进展，可继续等待或取消/)).toBeInTheDocument();
  });

  test('does not warn for recent progress or finished works', () => {
    const { unmount } = render(
      <WorkProgressBar
        status="running"
        progress={null}
        execution={makeExecution({ lastProgressAt: '2026-10-28T00:01:00.000Z' })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.queryByText(/长时间没有新进展/)).not.toBeInTheDocument();
    unmount();

    render(
      <WorkProgressBar
        status="done"
        progress={null}
        execution={makeExecution({ stage: 'finalizing', lastProgressAt: STAGE_START })}
        createdAt={STAGE_START}
        now={STAGE_NOW + 30 * 60 * 1000}
      />,
    );
    expect(screen.queryByText(/长时间没有新进展/)).not.toBeInTheDocument();
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  test('keeps the legacy display when execution is missing or corrupted', () => {
    const { unmount } = render(
      <WorkProgressBar
        status="pending"
        progress={null}
        execution={null}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.getByText('准备中…')).toBeInTheDocument();
    expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument();
    unmount();

    render(
      <WorkProgressBar
        status="pending"
        progress={null}
        execution={readWorkExecution({
          ...makeWork('pending'),
          metadata: {
            execution: { stage: 'bogus', updatedAt: STAGE_START, lastProgressAt: STAGE_START },
          } as Work['metadata'],
        })}
        createdAt={STAGE_START}
        now={STAGE_NOW}
      />,
    );
    expect(screen.getByText('准备中…')).toBeInTheDocument();
  });
});

describe('JobStatus and WorksPage execution wiring', () => {
  test('JobStatus shows stage, queue position and elapsed time from work metadata', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    vi.setSystemTime(STAGE_NOW);
    const view = render(<JobStatus jobId="job-1" />);

    requests[0].resolve([
      makeWork('running', { execution: makeExecution({ queuePosition: 1 }) }),
    ]);
    await flushPromises();

    expect(screen.getByText(/等待 ComfyUI/)).toBeInTheDocument();
    expect(screen.getByText(/前方 1 个任务/)).toBeInTheDocument();
    expect(screen.getByText(/已用时间/)).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: '生成进度 job-1' });
    expect(bar).toHaveAttribute('aria-description', expect.stringContaining('等待 ComfyUI'));
    view.unmount();
  });

  test('WorksPage shows stage text and elapsed time for active works', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    vi.setSystemTime(STAGE_NOW);
    const view = render(<WorksPage avatars={[]} />);

    requests[0].resolve([
      makeWork('running', {
        progress: { value: 12, max: 24 },
        execution: makeExecution({ stage: 'sampling' }),
      }),
    ]);
    await flushPromises();

    expect(screen.getByText(/正在采样生成/)).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/已用时间/)).toBeInTheDocument();
    view.unmount();
  });

  test('WorksPage falls back to the legacy display for corrupted execution metadata', async () => {
    const { list, requests } = controlledWorks();
    exposeWorks(list);
    vi.setSystemTime(STAGE_NOW);
    const work = makeWork('running');
    const view = render(<WorksPage avatars={[]} />);

    requests[0].resolve([
      { ...work, metadata: { execution: { stage: 'bogus', updatedAt: 1 } } as Work['metadata'] },
    ]);
    await flushPromises();

    expect(screen.getByText('正在生成…')).toBeInTheDocument();
    view.unmount();
  });
});
