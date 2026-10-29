import type { WorkExecutionState, WorkProgress, WorkStage, WorkStatus } from '../shared/types';
import { formatElapsedDuration } from './ui';

const INDETERMINATE_TEXT: Record<WorkStatus, string> = {
  pending: '准备中…',
  running: '正在生成…',
  done: '已完成',
  failed: '生成失败',
};

/** Human-readable text for each real ComfyUI execution stage. */
export const STAGE_TEXT: Record<WorkStage, string> = {
  'local-queued': '本地排队中',
  uploading: '正在上传素材',
  'backend-queued': '等待 ComfyUI',
  executing: '正在加载模型并执行节点',
  sampling: '正在采样生成',
  finalizing: '正在读取输出并收尾',
};

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Shared progress bar for queued and running works. Real ComfyUI frame
 * progress renders as value/max percent; works without frame data render an
 * indeterminate bar with an explicit Chinese status text so state never
 * relies on color alone. When the work carries a real execution stage
 * snapshot, the stage, queue position and elapsed time render as text;
 * percentages are never fabricated and a stale warning appears after a long
 * silence.
 */
export function WorkProgressBar({
  status,
  progress,
  label,
  execution,
  createdAt,
  now,
}: {
  status: WorkStatus;
  progress?: WorkProgress | null;
  /** Accessible name; defaults to a generic label when the work id is unknown. */
  label?: string;
  /** Validated execution stage snapshot; pass null for works without one. */
  execution?: WorkExecutionState | null;
  /** Work creation timestamp; drives the elapsed-time text for active works. */
  createdAt?: string;
  /** Clock override for deterministic rendering; defaults to Date.now(). */
  now?: number;
}) {
  const nowMs = now ?? Date.now();
  const ratio =
    progress !== null && progress !== undefined && progress.max > 0
      ? Math.min(1, Math.max(0, progress.value / progress.max))
      : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);

  const active = status === 'pending' || status === 'running';
  const stageText = active && execution !== null && execution !== undefined
    ? STAGE_TEXT[execution.stage]
    : null;

  let valueNow: number | null;
  let text: string;
  if (status === 'done') {
    valueNow = 100;
    text = '100%';
  } else if (status === 'failed') {
    if (percent === null) {
      valueNow = null;
      text = INDETERMINATE_TEXT.failed;
    } else {
      valueNow = percent;
      text = `${percent}%（失败）`;
    }
  } else if (percent !== null) {
    valueNow = percent;
    text = `${percent}%`;
  } else if (stageText !== null) {
    valueNow = null;
    text = stageText;
  } else {
    valueNow = null;
    text = INDETERMINATE_TEXT[status];
  }

  const indeterminate = valueNow === null && status !== 'failed';

  const detailItems: string[] = [];
  if (stageText !== null && percent !== null) {
    detailItems.push(stageText);
  }
  if (active && execution?.queuePosition !== undefined && execution.queuePosition > 0) {
    detailItems.push(`前方 ${execution.queuePosition} 个任务`);
  }
  const createdMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  if (active && Number.isFinite(createdMs)) {
    detailItems.push(`已用时间 ${formatElapsedDuration(nowMs - createdMs)}`);
  }
  if (
    active &&
    execution !== null &&
    execution !== undefined &&
    nowMs - Date.parse(execution.lastProgressAt) >= STALE_THRESHOLD_MS
  ) {
    detailItems.push('长时间没有新进展，可继续等待或取消');
  }

  const ariaParts = stageText !== null ? [stageText, ...detailItems] : detailItems;
  // Only callers passing execution/createdAt get the reserved detail line, so
  // legacy usage keeps its original single-row layout.
  const showDetail = execution !== undefined || createdAt !== undefined;

  return (
    <div className="work-progress-container">
      <div
        className={`work-progress work-progress-${status}${indeterminate ? ' work-progress-indeterminate' : ''}`}
        role="progressbar"
        aria-label={label ?? '生成进度'}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(valueNow === null ? {} : { 'aria-valuenow': valueNow })}
        {...(ariaParts.length > 0 ? { 'aria-description': ariaParts.join('；') } : {})}
      >
        <span className="work-progress-track" aria-hidden="true">
          <span
            className="work-progress-fill"
            style={valueNow === null ? undefined : { width: `${valueNow}%` }}
          />
        </span>
        <span className="work-progress-text">{text}</span>
      </div>
      {showDetail && <span className="work-progress-detail">{detailItems.join(' · ')}</span>}
    </div>
  );
}
