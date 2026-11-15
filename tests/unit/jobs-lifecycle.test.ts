// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import { JobCoordinator } from '../../src/main/jobs';

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

describe('JobCoordinator lifecycle', () => {
  test('close publishes cancellation only after the active run finally cleanup', async () => {
    const coordinator = new JobCoordinator({
      onEvent: (event) => events.push(event.status),
    });
    const events: string[] = [];
    const cleanup = deferred<void>();
    let rejectRun!: (reason: Error) => void;

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        events.push('first-run');
        try {
          await new Promise<void>((_resolve, reject) => {
            rejectRun = reject;
          });
        } finally {
          await cleanup.promise;
          events.push('first-finally');
        }
      },
      cancel: async () => {
        events.push('first-cancel');
        rejectRun(new Error('stop active run'));
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.activeCount).toBe(1);

    const closing = coordinator.close();
    await vi.waitFor(() => expect(events).toContain('first-cancel'));
    const eventsBeforeCleanup = [...events];
    cleanup.resolve();
    await closing;

    await expect(first).rejects.toThrow(/cancelled/i);
    expect(eventsBeforeCleanup).not.toContain('failed');
    expect(events).toEqual([
      'running',
      'first-run',
      'first-cancel',
      'first-finally',
      'failed',
    ]);
    expect(coordinator.activeCount).toBe(0);
  });

  test('close only settles the active job after a second job was rejected', async () => {
    const coordinator = new JobCoordinator();

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    expect(() =>
      coordinator.enqueue({
        id: 'second',
        run: async () => undefined,
      }),
    ).toThrow('Another generation is already running');

    await coordinator.close();

    await expect(first).resolves.toBeUndefined();
    expect(coordinator.activeCount).toBe(0);
  });

  test('enqueue after close throws synchronously', async () => {
    const coordinator = new JobCoordinator();
    await coordinator.close();

    let result: Promise<void> | undefined;
    try {
      expect(() => {
        result = coordinator.enqueue({
          id: 'late',
          run: async () => undefined,
        });
      }).toThrow(/closed/i);
    } finally {
      await result?.catch(() => undefined);
    }
  });

  test('close can be awaited multiple times', async () => {
    const coordinator = new JobCoordinator();
    await coordinator.close();
    await coordinator.close();
  });

  test('natural completion before close timeout is not overwritten', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const coordinator = new JobCoordinator({ closeTimeoutMs: 50 });

    let finishRun!: () => void;
    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        await new Promise<void>((resolve) => {
          finishRun = resolve;
        });
      },
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(coordinator.activeCount).toBe(1);

    const closePromise = coordinator.close();
    await vi.advanceTimersByTimeAsync(40);

    finishRun();
    await closePromise;

    await expect(first).resolves.toBeUndefined();
    expect(coordinator.completedIds).toContain('first');

    vi.useRealTimers();
  });

  test('default close timeout expires at 15000ms and remains retryable', async () => {
    vi.useFakeTimers();
    const coordinator = new JobCoordinator();
    const cleanup = deferred<void>();
    let rejectRun!: (reason: Error) => void;
    const first = coordinator.enqueue({
      id: 'speech-cleanup',
      run: async () => {
        try {
          await new Promise<void>((_resolve, reject) => {
            rejectRun = reject;
          });
        } finally {
          await cleanup.promise;
        }
      },
      cancel: async () => {
        rejectRun(new Error('stop active speech job'));
      },
    });
    const firstOutcome = first.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);

    const closing = coordinator.close();
    let closeSettled = false;
    void closing.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(closeSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(closing).rejects.toThrow(/timed out|timeout/i);
      expect(coordinator.activeCount).toBe(1);

      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(coordinator.activeCount).toBe(0);
      await coordinator.close();
      expect(await firstOutcome).toMatchObject({
        message: expect.stringMatching(/cancel/i),
      });
    } finally {
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await coordinator.close().catch(() => undefined);
      vi.useRealTimers();
    }

  });

  test('close timeout preserves the active job and can finish cleanup on a later close', async () => {
    const events: string[] = [];
    const coordinator = new JobCoordinator({
      closeTimeoutMs: 50,
      onEvent: (event) => events.push(event.status),
    });
    const cleanup = deferred<void>();
    let rejectRun!: (reason: Error) => void;

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        events.push('first-run');
        try {
          await new Promise<void>((_resolve, reject) => {
            rejectRun = reject;
          });
        } finally {
          await cleanup.promise;
          events.push('first-finally');
        }
      },
      cancel: async () => {
        rejectRun(new Error('stop active run'));
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.activeCount).toBe(1);

    const firstClose = coordinator.close();
    const concurrentClose = coordinator.close();
    const concurrentCloseShared = concurrentClose === firstClose;
    void concurrentClose.catch(() => undefined);
    const firstCloseResult = await firstClose.then(
      () => null,
      (error: unknown) => error,
    );
    const activeCountAtTimeout = coordinator.activeCount;
    const eventsAtTimeout = [...events];
    cleanup.resolve();
    await vi.waitFor(() => expect(coordinator.activeCount).toBe(0));
    expect(events).not.toContain('failed');
    await coordinator.close();

    await expect(first).rejects.toThrow(/cancelled|closed/i);
    const successfulClose = coordinator.close();
    await successfulClose;
    expect(coordinator.close()).toBe(successfulClose);
    expect(concurrentCloseShared).toBe(true);
    expect(firstCloseResult).toBeInstanceOf(Error);
    expect(String(firstCloseResult)).toMatch(/timed out|timeout/i);
    expect(activeCountAtTimeout).toBe(1);
    expect(eventsAtTimeout).not.toContain('failed');
    expect(events.filter((event) => event === 'failed')).toHaveLength(1);
    expect(coordinator.activeCount).toBe(0);
    expect(events).toContain('first-finally');
  });
});
