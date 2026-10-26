import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Avatar, Work } from '../shared/types';
import { StatusBadge } from './JobStatus';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage } from './ui';

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

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await window.smo.works.list();
      setWorks(result);
      setError(null);
    } catch (refreshError) {
      setError(errorMessage(refreshError));
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

  const avatarName = (id: string): string =>
    avatars.find((avatar) => avatar.id === id)?.name ?? '未知模特';

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
      {loading ? (
        <div className="page-state">正在读取作品…</div>
      ) : works.length === 0 ? (
        <div className="empty-state"><h3>还没有作品</h3><p>提交生成任务后，可在这里查看真实进度和输出。</p></div>
      ) : (
        <div className="works-list">
          {works.map((work) => (
            <article className="work-item" key={work.id}>
              <header className="work-header">
                <div>
                  <h3>{avatarName(work.avatarId)}</h3>
                  <p>{work.mode === 'text' ? '文字生视频' : '音频数字人'} · {new Date(work.createdAt).toLocaleString('zh-CN')}</p>
                </div>
                <StatusBadge status={work.status} />
              </header>
              <code className="work-id">{work.id}</code>
              {work.status === 'failed' && work.error && (
                <p className="form-error" role="alert">{work.error}</p>
              )}
              {work.status === 'done' && work.outputPath && <WorkVideo work={work} />}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
