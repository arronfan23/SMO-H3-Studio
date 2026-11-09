import type { WorkStatus } from '../shared/types';

export interface Job {
  id: string;
  run: () => Promise<void>;
  cancel?: () => void | Promise<void>;
}

export interface JobEvent {
  id: string;
  status: WorkStatus;
  error?: unknown;
}

export type JobEventErrorHandler = (error: unknown, event: JobEvent) => void;

function validateTimeout(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`JobCoordinator ${name} must be a finite positive number`);
  }
  return value;
}

export interface JobCoordinatorOptions {
  onEvent?: (event: JobEvent) => void;
  onEventError?: JobEventErrorHandler;
  closeTimeoutMs?: number;
}

export interface JobRecoveryRecord {
  id: string;
  status: WorkStatus;
}

interface ActiveItem {
  job: Job;
  resolve: () => void;
  reject: (reason?: unknown) => void;
  cancelPromise?: Promise<void>;
  cancelled?: boolean;
  settled?: Promise<void>;
  settle?: () => void;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

export class JobCoordinator {
  private readonly reservedIds = new Set<string>();
  private readonly completed: string[] = [];
  private readonly onEvent?: (event: JobEvent) => void;
  private readonly onEventError?: JobEventErrorHandler;
  private readonly closeTimeoutMs: number;
  private active: ActiveItem | null = null;
  private closed = false;

  constructor(options: JobCoordinatorOptions = {}) {
    this.onEvent = options.onEvent;
    this.onEventError = options.onEventError;
    this.closeTimeoutMs =
      options.closeTimeoutMs === undefined
        ? DEFAULT_CLOSE_TIMEOUT_MS
        : validateTimeout(options.closeTimeoutMs, 'closeTimeoutMs');
  }

  get activeId(): string | null {
    return this.active?.job.id ?? null;
  }

  get activeCount(): number {
    return this.active === null ? 0 : 1;
  }

  get completedIds(): readonly string[] {
    return [...this.completed];
  }

  async enqueue(job: Job): Promise<void> {
    if (job.id.trim().length === 0) {
      throw new Error('Job id must not be empty');
    }
    if (this.closed) {
      throw new Error('JobCoordinator is closed');
    }
    if (this.reservedIds.has(job.id)) {
      throw new Error(`Duplicate job id: ${job.id}`);
    }
    if (this.active !== null) {
      throw new Error('Another generation is already running');
    }
    this.reservedIds.add(job.id);

    let resolveJob!: () => void;
    let rejectJob!: (reason?: unknown) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const item: ActiveItem = { job, resolve: resolveJob, reject: rejectJob };
    item.settled = new Promise<void>((resolve) => {
      item.settle = resolve;
    });
    this.active = item;
    this.emit({ id: job.id, status: 'running' });
    void this.run(item);
    return completion;
  }

  cancelActive(): Promise<void> {
    const item = this.active;
    if (item === null || item.job.cancel === undefined) {
      return Promise.resolve();
    }
    if (item.cancelPromise === undefined) {
      item.cancelPromise = (async () => {
        await item.job.cancel!();
      })();
    }
    return item.cancelPromise;
  }

  cancel(id: string): Promise<void> {
    if (this.active?.job.id === id) {
      return this.cancelActive();
    }
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.active !== null) {
      const item = this.active;
      if (item.job.cancel !== undefined && item.cancelPromise === undefined) {
        item.cancelPromise = (async () => {
          await item.job.cancel!();
        })();
      }

      if (item.cancelPromise !== undefined) {
        item.cancelled = true;
        try {
          await item.cancelPromise;
        } catch {
          // The cancellation itself may fail; the job promise is still rejected as cancelled.
        }
        const error = new Error('Generation cancelled');
        this.reservedIds.delete(item.job.id);
        this.emit({ id: item.job.id, status: 'failed', error });
        item.reject(error);
        this.active = null;
      } else if (item.settled !== undefined) {
        const timeout = setTimeout(() => {
          if (this.active !== item || item.cancelled) {
            return;
          }
          item.cancelled = true;
          const error = new Error('Generation cancelled');
          this.reservedIds.delete(item.job.id);
          this.emit({ id: item.job.id, status: 'failed', error });
          item.reject(error);
          this.active = null;
          item.settle?.();
        }, this.closeTimeoutMs);
        await item.settled;
        clearTimeout(timeout);
      }
    }
  }

  recover(records: readonly JobRecoveryRecord[]): void {
    for (const record of records) {
      if (this.reservedIds.has(record.id)) {
        continue;
      }
      if (record.status === 'done') {
        this.reservedIds.add(record.id);
        this.completed.push(record.id);
      } else if (record.status === 'running' || record.status === 'pending') {
        this.emit({
          id: record.id,
          status: 'failed',
          error: new Error('Job interrupted by application restart'),
        });
      }
    }
  }

  private emit(event: JobEvent): void {
    try {
      this.onEvent?.(event);
    } catch (error) {
      try {
        this.onEventError?.(error, event);
      } catch {
        // Neither listener nor reporter failures may interrupt job cleanup.
      }
    }
  }

  private async run(item: ActiveItem): Promise<void> {
    try {
      await item.job.run();
      if (!item.cancelled) {
        this.completed.push(item.job.id);
        this.emit({ id: item.job.id, status: 'done' });
        item.resolve();
      }
    } catch (error) {
      if (!item.cancelled) {
        this.reservedIds.delete(item.job.id);
        this.emit({ id: item.job.id, status: 'failed', error });
        item.reject(error);
      }
    } finally {
      if (item.cancelPromise !== undefined) {
        try {
          await item.cancelPromise;
        } catch {
          // The cancelActive caller receives the cancellation error.
        }
      }
      if (this.active === item) {
        this.active = null;
      }
      item.settle?.();
    }
  }
}
