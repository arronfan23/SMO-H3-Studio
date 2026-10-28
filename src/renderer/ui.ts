import type { Work, WorkProgress, WorkStatus } from '../shared/types';

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
