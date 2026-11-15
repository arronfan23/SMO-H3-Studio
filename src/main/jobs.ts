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
  terminal?: boolean;
  settled?: Promise<void>;
  settle?: () => void;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 15_000;

export class JobCoordinator {
  private readonly reservedIds = new Set<string>();
  private readonly completed: string[] = [];
  private readonly onEvent?: (event: JobEvent) => void;
  private readonly onEventError?: JobEventErrorHandler;
  private readonly closeTimeoutMs: number;
  private active: ActiveItem | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private closingItem: ActiveItem | null = null;

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

  enqueue(job: Job): Promise<void> {
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

  close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    const item = this.closingItem ?? this.active;
    if (item === null) {
      this.closePromise = Promise.resolve();
      return this.closePromise;
    }
    this.closingItem = item;
    const pending = this.performClose();
    this.closePromise = pending;
    void pending.catch(() => {
      if (this.closePromise === pending) this.closePromise = null;
    });
    return pending;
  }

  private async performClose(): Promise<void> {
    const item = this.closingItem!;
    if (item.job.cancel !== undefined && item.cancelPromise === undefined) {
      item.cancelPromise = (async () => {
        await item.job.cancel!();
      })();
    }

    if (item.cancelPromise !== undefined) item.cancelled = true;
    const cancellation = item.cancelPromise?.catch(() => undefined);
    const cleanup =
      cancellation === undefined
        ? item.settled!
        : Promise.all([cancellation, item.settled!]).then(() => undefined);
    await this.waitForClose(item, cleanup);
    if (item.terminal) {
      this.closingItem = null;
      return;
    }

    if (item.cancelPromise !== undefined) {
      const error = new Error('Generation cancelled');
      item.terminal = true;
      this.reservedIds.delete(item.job.id);
      this.emit({ id: item.job.id, status: 'failed', error });
      item.reject(error);
      this.closingItem = null;
    }
  }

  private async waitForClose(
    item: ActiveItem,
    cleanup: Promise<unknown>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `JobCoordinator close timed out waiting for job ${item.job.id} cleanup`,
              ),
            );
          }, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
    let outcome: { status: 'done' } | { status: 'failed'; error: unknown } | null =
      null;
    try {
      await item.job.run();
      if (!item.cancelled) {
        outcome = { status: 'done' };
      }
    } catch (error) {
      if (!item.cancelled) {
        outcome = { status: 'failed', error };
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
      if (outcome?.status === 'done') {
        this.completed.push(item.job.id);
        item.terminal = true;
        this.emit({ id: item.job.id, status: 'done' });
        item.resolve();
      } else if (outcome?.status === 'failed') {
        this.reservedIds.delete(item.job.id);
        item.terminal = true;
        this.emit({ id: item.job.id, status: 'failed', error: outcome.error });
        item.reject(outcome.error);
      }
      item.settle?.();
    }
  }
}
