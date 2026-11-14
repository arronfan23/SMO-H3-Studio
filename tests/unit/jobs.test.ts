// @vitest-environment node

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test, vi } from 'vitest';
import { JobCoordinator, type JobEvent } from '../../src/main/jobs';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('JobCoordinator execution', () => {
  test('rejects a second job while one is active without emitting pending events', async () => {
    const events: JobEvent[] = [];
    const coordinator = new JobCoordinator({ onEvent: (event) => events.push(event) });
    const first = deferred<void>();
    const secondRun = vi.fn();

    void coordinator.enqueue({ id: 'one', run: () => first.promise });
    expect(() => coordinator.enqueue({ id: 'two', run: secondRun })).toThrow(
      'Another generation is already running',
    );
    expect(coordinator.activeId).toBe('one');
    expect(events.map((event) => event.status)).not.toContain('pending');
    expect(secondRun).not.toHaveBeenCalled();

    first.resolve();
    await vi.waitFor(() => expect(coordinator.activeCount).toBe(0));
    expect(coordinator.activeId).toBeNull();
    expect(coordinator.completedIds).toEqual(['one']);
    expect(coordinator.activeCount).toBe(0);
  });

  test('rejects duplicate active and completed ids', async () => {
    const coordinator = new JobCoordinator();
    const firstGate = deferred();
    const first = coordinator.enqueue({ id: 'a', run: () => firstGate.promise });

    expect(() => coordinator.enqueue({ id: 'a', run: async () => {} })).toThrow(
      /duplicate job id/i,
    );

    firstGate.resolve();
    await first;
    await coordinator.enqueue({ id: 'b', run: async () => {} });

    expect(() => coordinator.enqueue({ id: 'a', run: async () => {} })).toThrow(
      /duplicate job id/i,
    );
    expect(() => coordinator.enqueue({ id: 'b', run: async () => {} })).toThrow(
      /duplicate job id/i,
    );
  });

  test('passes a job error to its promise and accepts a later job after cleanup', async () => {
    const coordinator = new JobCoordinator();
    const failure = new Error('generation failed');
    const calls: string[] = [];

    const first = coordinator.enqueue({
      id: 'a',
      run: async () => {
        throw failure;
      },
    });
    await expect(first).rejects.toBe(failure);
    await coordinator.enqueue({
      id: 'b',
      run: async () => {
        calls.push('b ran');
      },
    });

    expect(calls).toEqual(['b ran']);
    expect(coordinator.completedIds).toEqual(['b']);
    expect(coordinator.activeCount).toBe(0);
  });

  test('emits running, done, and failed events in execution order', async () => {
    const events: JobEvent[] = [];
    const coordinator = new JobCoordinator({ onEvent: (event) => events.push(event) });
    const failure = new Error('failed job');

    await coordinator.enqueue({ id: 'done-job', run: async () => {} });
    await expect(
      coordinator.enqueue({
        id: 'failed-job',
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(events.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'done-job', status: 'running' },
      { id: 'done-job', status: 'done' },
      { id: 'failed-job', status: 'running' },
      { id: 'failed-job', status: 'failed' },
    ]);
    expect(events.at(-1)?.error).toBe(failure);
  });

  test.each(['done', 'failed'] as const)(
    'accepts the next job inside the %s callback',
    async (terminalStatus) => {
      const failure = new Error('first job failed');
      let nextCompletion: Promise<void> | undefined;
      let nextRuns = 0;
      const coordinator = new JobCoordinator({
        onEvent: (event) => {
          if (event.id === 'first' && event.status === terminalStatus) {
            nextCompletion = coordinator.enqueue({
              id: 'second',
              run: async () => {
                nextRuns += 1;
              },
            });
          }
        },
      });

      const first = coordinator.enqueue({
        id: 'first',
        run: async () => {
          if (terminalStatus === 'failed') throw failure;
        },
      });
      if (terminalStatus === 'failed') {
        await expect(first).rejects.toBe(failure);
      } else {
        await first;
      }

      expect(nextCompletion).toBeDefined();
      await expect(nextCompletion!).resolves.toBeUndefined();
      expect(nextRuns).toBe(1);
      expect(coordinator.completedIds).toEqual(
        terminalStatus === 'done' ? ['first', 'second'] : ['second'],
      );
      expect(coordinator.activeCount).toBe(0);
    },
  );

  test('waits for asynchronous cancellation before accepting another job', async () => {
    const coordinator = new JobCoordinator();
    const runGate = deferred();
    const cancelGate = deferred();
    const calls: string[] = [];
    let cancelCalls = 0;

    const first = coordinator.enqueue({
      id: 'a',
      run: () => runGate.promise,
      cancel: () => {
        cancelCalls += 1;
        calls.push('cancel started');
        return cancelGate.promise;
      },
    });
    const cancellation = coordinator.cancelActive();
    expect(cancelCalls).toBe(1);

    runGate.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['cancel started']);
    expect(coordinator.activeCount).toBe(1);
    expect(() =>
      coordinator.enqueue({
        id: 'b',
        run: async () => {
          calls.push('b started');
        },
      }),
    ).toThrow('Another generation is already running');
    expect(coordinator.activeId).toBe('a');

    cancelGate.resolve();
    await cancellation;
    await first;
    await coordinator.enqueue({
      id: 'b',
      run: async () => {
        calls.push('b started');
      },
    });

    expect(calls).toEqual(['cancel started', 'b started']);
    expect(coordinator.activeCount).toBe(0);
  });

  test('does not retain or cancel a job rejected while another is active', async () => {
    const events: JobEvent[] = [];
    const coordinator = new JobCoordinator({ onEvent: (event) => events.push(event) });
    const firstGate = deferred();
    let firstCancellations = 0;
    let secondJobRan = false;
    const first = coordinator.enqueue({
      id: 'first',
      run: () => firstGate.promise,
      cancel: () => {
        firstCancellations += 1;
      },
    });
    expect(() =>
      coordinator.enqueue({
        id: 'second',
        run: async () => {
          secondJobRan = true;
        },
      }),
    ).toThrow('Another generation is already running');

    await coordinator.cancel('second');

    expect(firstCancellations).toBe(0);
    expect(secondJobRan).toBe(false);
    expect(coordinator.activeCount).toBe(1);
    expect(coordinator.activeId).toBe('first');
    expect(events.some((event) => event.id === 'second')).toBe(false);

    firstGate.resolve();
    await first;
  });

  test('cancels the requested active job without touching a different active id', async () => {
    const coordinator = new JobCoordinator();
    const runGate = deferred();
    let cancellations = 0;
    const completion = coordinator.enqueue({
      id: 'active',
      run: () => runGate.promise,
      cancel: () => {
        cancellations += 1;
        runGate.resolve();
      },
    });

    await coordinator.cancel('another-job');
    expect(cancellations).toBe(0);
    await coordinator.cancel('active');
    await completion;

    expect(cancellations).toBe(1);
  });

  test('settles jobs and cleans up when the running event listener throws', async () => {
    const events: string[] = [];
    const coordinator = new JobCoordinator({
      onEvent: (event) => {
        events.push(`${event.id}:${event.status}`);
        if (event.status === 'running') {
          throw new Error(`listener failed for ${event.id}`);
        }
      },
    });

    const first = coordinator.enqueue({ id: 'a', run: async () => {} });
    const outcome = await Promise.race([
      first
        .then(() => coordinator.enqueue({ id: 'b', run: async () => {} }))
        .then(() => 'settled'),
      delay(50).then(() => 'stalled'),
    ]);

    expect(outcome).toBe('settled');
    expect(coordinator.completedIds).toEqual(['a', 'b']);
    expect(coordinator.activeCount).toBe(0);
    expect(events).toEqual([
      'a:running',
      'a:done',
      'b:running',
      'b:done',
    ]);
  });

  test('reports event listener failures with context and still settles each job', async () => {
    const writeFailure = new Error('SQLite work update failed');
    const reports: Array<{ error: unknown; event: JobEvent }> = [];
    const coordinator = new JobCoordinator({
      onEvent: (event) => {
        if (event.status === 'running') {
          throw writeFailure;
        }
      },
      onEventError: (error, event) => reports.push({ error, event }),
    });

    await coordinator.enqueue({ id: 'first', run: async () => {} });
    await coordinator.enqueue({ id: 'second', run: async () => {} });

    expect(reports).toEqual([
      { error: writeFailure, event: { id: 'first', status: 'running' } },
      { error: writeFailure, event: { id: 'second', status: 'running' } },
    ]);
    expect(coordinator.completedIds).toEqual(['first', 'second']);
    expect(coordinator.activeCount).toBe(0);
  });
});

describe('JobCoordinator recovery', () => {
  test('fails recovered unfinished jobs and reserves completed ids without rerunning them', async () => {
    const events: JobEvent[] = [];
    const coordinator = new JobCoordinator({ onEvent: (event) => events.push(event) });
    let completedJobRan = false;

    coordinator.recover([
      { id: 'interrupted', status: 'running' },
      { id: 'finished', status: 'done' },
      { id: 'still-pending', status: 'pending' },
      { id: 'already-failed', status: 'failed' },
    ]);

    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.completedIds).toEqual(['finished']);
    expect(events.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'interrupted', status: 'failed' },
      { id: 'still-pending', status: 'failed' },
    ]);
    for (const event of events) {
      expect(event.error).toBeInstanceOf(Error);
      expect((event.error as Error).message).toMatch(/interrupted.*restart/i);
    }

    expect(() =>
      coordinator.enqueue({
        id: 'finished',
        run: async () => {
          completedJobRan = true;
        },
      }),
    ).toThrow(/duplicate job id/i);
    expect(completedJobRan).toBe(false);
  });

  test('marks recovered pending jobs as interrupted failures', () => {
    const events: JobEvent[] = [];
    const coordinator = new JobCoordinator({ onEvent: (event) => events.push(event) });

    coordinator.recover([{ id: 'pending-job', status: 'pending' }]);

    expect(events.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'pending-job', status: 'failed' },
    ]);
    expect(events[0].error).toBeInstanceOf(Error);
    expect((events[0].error as Error).message).toMatch(/interrupted.*restart/i);
    expect(coordinator.activeCount).toBe(0);
    expect(coordinator.completedIds).toEqual([]);
  });
});
