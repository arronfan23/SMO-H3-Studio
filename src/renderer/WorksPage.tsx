import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Play, RefreshCw, RotateCcw } from 'lucide-react';
import type { Avatar, VideoMode, Work, WorkStatus } from '../shared/types';
import { StatusBadge } from './JobStatus';
import { WorkProgressBar } from './WorkProgressBar';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage, parentPath, readWorkProgress } from './ui';

const FILTERS: { id: 'all' | VideoMode | WorkStatus; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'text', label: '文字生视频' },
  { id: 'audio', label: '音频数字人' },
  { id: 'pending', label: '等待中' },
  { id: 'running', label: '运行中' },
  { id: 'done', label: '已完成' },
  { id: 'failed', label: '失败' },
];

function WorkVideo({ work }: { work: Work }) {
  const { url, error } = useMediaUrl(work.outputPath);
  if (error) {
    return <p className="form-error" role="alert">视频读取失败：{error}</p>;
  }
  if (url === null) {
    return <div className="video-placeholder">正在读取视频…</div>;
  }
  return <video aria-label={`作品视频 ${work.id}`} controls preload="metadata" src={url} />;
}

export function WorksPage({ avatars }: { avatars: Avatar[] }) {
  const [works, setWorks] = useState<Work[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<'all' | VideoMode | WorkStatus>('all');
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [retryError, setRetryError] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.smo.works.list();
      if (!mountedRef.current) {
        return;
      }
      setWorks(result);
      setError(null);
    } catch (refreshError) {
      if (mountedRef.current) {
        setError(errorMessage(refreshError));
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    void refresh().finally(() => {
      if (active) {
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!works.some((work) => work.status === 'pending' || work.status === 'running')) {
      return;
    }
    const timer = setTimeout(() => void refresh(), 500);
    return () => clearTimeout(timer);
  }, [refresh, works]);

  const filteredWorks = useMemo(() => {
    if (activeFilter === 'all') {
      return works;
    }
    if (activeFilter === 'text' || activeFilter === 'audio') {
      return works.filter((work) => work.mode === activeFilter);
    }
    return works.filter((work) => work.status === activeFilter);
  }, [works, activeFilter]);

  const avatarName = (id: string): string =>
    avatars.find((avatar) => avatar.id === id)?.name ?? '未知模特';

  const retry = async (work: Work): Promise<void> => {
    setRetrying((current) => new Set(current).add(work.id));
    setRetryError((current) => ({ ...current, [work.id]: '' }));
    try {
      await window.smo.jobs.retry(work.id);
      if (!mountedRef.current) {
        return;
      }
      await refresh();
    } catch (retryError) {
      if (mountedRef.current) {
        setRetryError((current) => ({ ...current, [work.id]: errorMessage(retryError) }));
      }
    } finally {
      if (mountedRef.current) {
        setRetrying((current) => {
          const next = new Set(current);
          next.delete(work.id);
          return next;
        });
      }
    }
  };

  const openOutputFolder = async (work: Work): Promise<void> => {
    if (work.outputPath === null) {
      return;
    }
    try {
      await window.smo.files.openFolder(parentPath(work.outputPath));
    } catch (openError) {
      if (mountedRef.current) {
        setRetryError((current) => ({ ...current, [work.id]: errorMessage(openError) }));
      }
    }
  };

  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <span className="page-kicker">生成记录</span>
          <h2>我的作品</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void refresh()}>
          <RefreshCw size={16} aria-hidden="true" />
          刷新
        </button>
      </header>
      {error && <p className="form-error" role="alert">作品列表更新失败：{error}</p>}
      <div className="works-filters" role="group" aria-label="作品筛选">
        {FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={activeFilter === filter.id ? 'button button-primary' : 'button button-secondary'}
            onClick={() => setActiveFilter(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="page-state">正在读取作品…</div>
      ) : filteredWorks.length === 0 ? (
        <div className="empty-state"><h3>还没有作品</h3><p>提交生成任务后，可在这里查看真实进度和输出。</p></div>
      ) : (
        <div className="works-list">
          {filteredWorks.map((work) => (
            <article className="work-item" key={work.id}>
              <header className="work-header">
                <div>
                  <h3>{avatarName(work.avatarId)}</h3>
                  <p>{work.mode === 'text' ? '文字生视频' : '音频数字人'} · {new Date(work.createdAt).toLocaleString('zh-CN')}</p>
                </div>
                <StatusBadge status={work.status} />
              </header>
              <code className="work-id">{work.id}</code>
              <WorkProgressBar status={work.status} progress={readWorkProgress(work)} />
              {work.status === 'failed' && work.error && (
                <p className="form-error" role="alert">{work.error}</p>
              )}
              {retryError[work.id] && <p className="form-error" role="alert">{retryError[work.id]}</p>}
              {work.status === 'done' && work.outputPath && <WorkVideo work={work} />}
              <div className="work-actions">
                {work.status === 'failed' && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={retrying.has(work.id)}
                    onClick={() => void retry(work)}
                  >
                    <RotateCcw size={16} aria-hidden="true" />
                    {retrying.has(work.id) ? '正在重试…' : '重试'}
                  </button>
                )}
                {work.status === 'done' && work.outputPath && (
                  <>
                    <button
                      className="button button-secondary"
                      type="button"
                      onClick={() => void openOutputFolder(work)}
                    >
                      <FolderOpen size={16} aria-hidden="true" />
                      打开目录
                    </button>
                    <button
                      className="button button-icon"
                      type="button"
                      onClick={() => void window.smo.comfy.open()}
                      aria-label="打开 ComfyUI"
                    >
                      <ExternalLink size={16} aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
