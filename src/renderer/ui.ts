import type { Work, WorkExecutionState, WorkProgress, WorkStage, WorkStatus } from '../shared/types';

export const WORK_STATUS_TEXT: Record<WorkStatus, string> = {
  pending: '等待中（pending）',
  running: '运行中（running）',
  done: '已完成（done）',
  failed: '失败（failed）',
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads validated frame progress from persisted work metadata. */
export function readWorkProgress(work: Work | null | undefined): WorkProgress | null {
  const progress = work?.metadata?.progress;
  if (progress === undefined || progress === null) {
    return null;
  }
  const { value, max } = progress;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    typeof max !== 'number' ||
    !Number.isFinite(max) ||
    max <= 0
  ) {
    return null;
  }
  return { value, max };
}

const WORK_STAGES: readonly WorkStage[] = [
  'local-queued',
  'uploading',
  'backend-queued',
  'executing',
  'sampling',
  'finalizing',
];

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Reads a validated execution stage snapshot from persisted work metadata. */
export function readWorkExecution(work: Work | null | undefined): WorkExecutionState | null {
  const execution = work?.metadata?.execution;
  if (execution === undefined || execution === null || typeof execution !== 'object') {
    return null;
  }
  const { stage, updatedAt, lastProgressAt, queuePosition } = execution;
  if (
    typeof stage !== 'string' ||
    !WORK_STAGES.includes(stage as WorkStage) ||
    !isValidIsoTimestamp(updatedAt) ||
    !isValidIsoTimestamp(lastProgressAt)
  ) {
    return null;
  }
  if (
    queuePosition !== undefined &&
    (typeof queuePosition !== 'number' ||
      !Number.isFinite(queuePosition) ||
      queuePosition < 0)
  ) {
    return null;
  }
  const state: WorkExecutionState = { stage: stage as WorkStage, updatedAt, lastProgressAt };
  if (queuePosition !== undefined) {
    state.queuePosition = queuePosition;
  }
  return state;
}

/** Formats an elapsed duration in Chinese, clamped to non-negative values. */
export function formatElapsedDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes} 分 ${seconds} 秒` : `${totalMinutes} 分钟`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`;
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

export function parentPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const backslash = trimmed.lastIndexOf('\\');
  const slash = trimmed.lastIndexOf('/');
  const lastSeparator = Math.max(backslash, slash);
  if (lastSeparator === -1) {
    return trimmed;
  }
  const name = trimmed.slice(lastSeparator + 1);
  if (name.length === 0) {
    return trimmed;
  }
  if (!name.includes('.')) {
    return trimmed;
  }
  const candidate = trimmed.slice(0, lastSeparator);
  if (/^[a-zA-Z]:$/.test(candidate)) {
    return candidate + '\\';
  }
  return candidate;
}
