import type { WorkStatus } from '../shared/types';

export const WORK_STATUS_TEXT: Record<WorkStatus, string> = {
  pending: '等待中（pending）',
  running: '运行中（running）',
  done: '已完成（done）',
  failed: '失败（failed）',
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}
