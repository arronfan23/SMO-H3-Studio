// @vitest-environment node

import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
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
  test('runs jobs in FIFO order with one active job and ordered completions', async () => {
    const coordinator = new JobCoordinator();
    const firstGate = deferred();
    const calls: string[] = [];

    const first = coordinator.enqueue({
      id: 'a',
      run: async () => {
        calls.push('start a');
        await firstGate.promise;
        calls.push('end a');
      },
    });
    const second = coordinator.enqueue({
      id: 'b',
      run: async () => {
        calls.push('start b');
        calls.push('end b');
      },
    });

    expect(coordinator.activeCount).toBe(1);
    expect(calls).toEqual(['start a']);

    firstGate.resolve();
    await Promise.all([first, second]);

    expect(calls).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(coordinator.completedIds).toEqual(['a', 'b']);
    expect(coordinator.activeCount).toBe(0);
  });

  test('rejects duplicate active, queued, and completed ids', async () => {
    const coordinator = new JobCoordinator();
    const firstGate = deferred();
    const first = coordinator.enqueue({ id: 'a', run: () => firstGate.promise });
    const second = coordinator.enqueue({ id: 'b', run: async () => {} });

    await expect(coordinator.enqueue({ id: 'a', run: async () => {} })).rejects.toThrow(
      /duplicate job id/i,
    );
    await expect(coordinator.enqueue({ id: 'b', run: async () => {} })).rejects.toThrow(
      /duplicate job id/i,
    );

    firstGate.resolve();
    await Promise.all([first, second]);

    await expect(coordinator.enqueue({ id: 'a', run: async () => {} })).rejects.toThrow(
      /duplicate job id/i,
    );
    await expect(coordinator.enqueue({ id: 'b', run: async () => {} })).rejects.toThrow(
      /duplicate job id/i,
    );
  });

  test('passes a job error to its promise and continues with the next job', async () => {
    const coordinator = new JobCoordinator();
    const failure = new Error('generation failed');
    const calls: string[] = [];

    const first = coordinator.enqueue({
      id: 'a',
      run: async () => {
        throw failure;
      },
    });
    const second = coordinator.enqueue({
      id: 'b',
      run: async () => {
        calls.push('b ran');
      },
    });

    await expect(first).rejects.toBe(failure);
    await second;

    expect(calls).toEqual(['b ran']);
    expect(coordinator.completedIds).toEqual(['b']);
    expect(coordinator.activeCount).toBe(0);
  });

  test('emits pending, running, done, and failed events in execution order', async () => {
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
      { id: 'done-job', status: 'pending' },
      { id: 'done-job', status: 'running' },
      { id: 'done-job', status: 'done' },
      { id: 'failed-job', status: 'pending' },
      { id: 'failed-job', status: 'running' },
      { id: 'failed-job', status: 'failed' },
    ]);
    expect(events.at(-1)?.error).toBe(failure);
  });

  test('waits for asynchronous cancellation before starting the next job', async () => {
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
    const second = coordinator.enqueue({
      id: 'b',
      run: async () => {
        calls.push('b started');
      },
    });

    const cancellation = coordinator.cancelActive();
    expect(cancelCalls).toBe(1);

    runGate.resolve();
    await first;
    expect(calls).toEqual(['cancel started']);
    expect(coordinator.activeCount).toBe(1);

    cancelGate.resolve();
    await cancellation;
    await second;

    expect(calls).toEqual(['cancel started', 'b started']);
    expect(coordinator.activeCount).toBe(0);
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
    const second = coordinator.enqueue({ id: 'b', run: async () => {} });
    const outcome = await Promise.race([
      Promise.all([first, second]).then(() => 'settled'),
      delay(50).then(() => 'stalled'),
    ]);

    expect(outcome).toBe('settled');
    expect(coordinator.completedIds).toEqual(['a', 'b']);
    expect(coordinator.activeCount).toBe(0);
    expect(events).toEqual([
      'a:pending',
      'a:running',
      'b:pending',
      'a:done',
      'b:running',
      'b:done',
    ]);
  });

  test('reports event listener failures with context and still settles the queue', async () => {
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

    const first = coordinator.enqueue({ id: 'first', run: async () => {} });
    const second = coordinator.enqueue({ id: 'second', run: async () => {} });
    await Promise.all([first, second]);

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

    await expect(
      coordinator.enqueue({
        id: 'finished',
        run: async () => {
          completedJobRan = true;
        },
      }),
    ).rejects.toThrow(/duplicate job id/i);
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
