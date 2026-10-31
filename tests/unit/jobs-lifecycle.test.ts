// @vitest-environment node

import { describe, expect, test, vi } from 'vitest';
import { JobCoordinator } from '../../src/main/jobs';

describe('JobCoordinator lifecycle', () => {
  test('close cancels the active job and empties the queue', async () => {
    const coordinator = new JobCoordinator();
    const events: string[] = [];

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        events.push('first-run');
        await new Promise(() => undefined);
      },
      cancel: async () => {
        events.push('first-cancel');
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.activeCount).toBe(1);

    await coordinator.close();

    expect(events).toContain('first-cancel');
    await expect(first).rejects.toThrow(/cancelled/i);
    expect(coordinator.activeCount).toBe(0);
  });

  test('close rejects queued jobs', async () => {
    const coordinator = new JobCoordinator();

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
    });

    const second = coordinator.enqueue({
      id: 'second',
      run: async () => undefined,
    });

    await coordinator.close();

    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow(/JobCoordinator is closed/i);
  });

  test('enqueue after close rejects immediately', async () => {
    const coordinator = new JobCoordinator();
    await coordinator.close();

    await expect(
      coordinator.enqueue({
        id: 'late',
        run: async () => undefined,
      }),
    ).rejects.toThrow(/closed/i);
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

  test('close times out a non-cancellable active job and rejects queued jobs', async () => {
    const coordinator = new JobCoordinator({ closeTimeoutMs: 50 });
    const events: string[] = [];

    const first = coordinator.enqueue({
      id: 'first',
      run: async () => {
        events.push('first-run');
        await new Promise(() => undefined);
      },
    });

    const second = coordinator.enqueue({
      id: 'second',
      run: async () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coordinator.activeCount).toBe(1);

    await coordinator.close();

    await expect(first).rejects.toThrow(/cancelled|closed/i);
    await expect(second).rejects.toThrow(/JobCoordinator is closed/i);
    expect(coordinator.activeCount).toBe(0);
    expect(events).toContain('first-run');
  });
});
