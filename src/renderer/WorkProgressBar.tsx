import type { WorkProgress, WorkStatus } from '../shared/types';

const INDETERMINATE_TEXT: Record<WorkStatus, string> = {
  pending: '准备中…',
  running: '正在生成…',
  done: '已完成',
  failed: '生成失败',
};

/**
 * Shared progress bar for queued and running works. Real ComfyUI frame
 * progress renders as value/max percent; works without frame data render an
 * indeterminate bar with an explicit Chinese status text so state never
 * relies on color alone.
 */
export function WorkProgressBar({
  status,
  progress,
}: {
  status: WorkStatus;
  progress?: WorkProgress | null;
}) {
  const ratio =
    progress !== null && progress !== undefined && progress.max > 0
      ? Math.min(1, Math.max(0, progress.value / progress.max))
      : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);

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
  } else {
    valueNow = null;
    text = INDETERMINATE_TEXT[status];
  }

  const indeterminate = valueNow === null && status !== 'failed';

  return (
    <div
      className={`work-progress work-progress-${status}${indeterminate ? ' work-progress-indeterminate' : ''}`}
      role="progressbar"
      aria-label="生成进度"
      aria-valuemin={0}
      aria-valuemax={100}
      {...(valueNow === null ? {} : { 'aria-valuenow': valueNow })}
    >
      <span className="work-progress-track" aria-hidden="true">
        <span
          className="work-progress-fill"
          style={valueNow === null ? undefined : { width: `${valueNow}%` }}
        />
      </span>
      <span className="work-progress-text">{text}</span>
    </div>
  );
}
