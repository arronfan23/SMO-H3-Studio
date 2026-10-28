import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Work, WorkStatus } from '../shared/types';
import { errorMessage, readWorkProgress, WORK_STATUS_TEXT } from './ui';
import { WorkProgressBar } from './WorkProgressBar';

const POLL_INTERVAL_MS = 400;

interface JobSnapshot {
  jobId: string;
  work: Work | null;
  refreshError: string | null;
}

export function StatusBadge({ status }: { status: WorkStatus }) {
  return <span className={`status-badge status-${status}`}>{WORK_STATUS_TEXT[status]}</span>;
}

export function JobStatus({
  jobId,
  active = true,
  allowCancel = false,
}: {
  jobId: string | null;
  active?: boolean;
  allowCancel?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<JobSnapshot | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  useEffect(() => {
    if (jobId === null || !active) {
      return;
    }
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      let work: Work | null = null;
      try {
        const works = await window.smo.works.list();
        if (!mounted) {
          return;
        }
        work = works.find((candidate) => candidate.id === jobId) ?? null;
        setSnapshot({ jobId, work, refreshError: null });
      } catch (error) {
        if (!mounted) {
          return;
        }
        setSnapshot((current) => ({
          jobId,
          work: current?.jobId === jobId ? current.work : null,
          refreshError: errorMessage(error),
        }));
      }

      if (mounted && work?.status !== 'done' && work?.status !== 'failed') {
        timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
      }
    };

    void refresh();
    return () => {
      mounted = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [active, jobId]);

  if (jobId === null) {
    return null;
  }
  const current = snapshot?.jobId === jobId ? snapshot : null;
  const status = current?.work?.status ?? 'pending';

  const cancel = async (): Promise<void> => {
    setCanceling(true);
    setCancelError(null);
    try {
      await window.smo.jobs.cancel(jobId);
    } catch (error) {
      setCancelError(errorMessage(error));
    } finally {
      setCanceling(false);
    }
  };

  return (
    <section className="job-status" aria-live="polite" aria-label="任务状态">
      <div className="job-summary">
        <div>
          <span className="field-caption">任务 ID</span>
          <code>{jobId}</code>
        </div>
        <StatusBadge status={status} />
      </div>
      <WorkProgressBar
        status={status}
        progress={readWorkProgress(current?.work)}
        label={`生成进度 ${jobId}`}
      />
      {current?.work?.error && <p className="form-error" role="alert">{current.work.error}</p>}
      {current?.refreshError && (
        <p className="form-error" role="alert">状态更新失败：{current.refreshError}</p>
      )}
      {cancelError && <p className="form-error" role="alert">取消失败：{cancelError}</p>}
      {allowCancel && (status === 'pending' || status === 'running') && (
        <button className="button button-secondary" type="button" onClick={() => void cancel()} disabled={canceling}>
          <X size={16} aria-hidden="true" />
          {canceling ? '正在取消…' : '取消当前任务'}
        </button>
      )}
    </section>
  );
}
