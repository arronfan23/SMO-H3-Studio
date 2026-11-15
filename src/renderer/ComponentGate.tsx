import { CheckCircle2, Download, RotateCcw, X } from 'lucide-react';
import type { MediaComponentId, MediaComponentState } from '../shared/media-components';

const COMPONENT_NAMES: Record<MediaComponentId, string> = {
  speech: '语音组件',
  image: '图像组件',
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function ComponentGate({
  id,
  state,
  loading = false,
  error = null,
  operation = null,
  generationBusy = false,
  install,
  cancel,
  retry,
}: {
  id: MediaComponentId;
  state: MediaComponentState | null;
  loading?: boolean;
  error?: string | null;
  operation?: 'install' | 'cancel' | null;
  generationBusy?: boolean;
  install: (id: MediaComponentId) => Promise<void>;
  cancel: (id: MediaComponentId) => Promise<void>;
  retry: (id: MediaComponentId) => Promise<void>;
}) {
  const name = COMPONENT_NAMES[id];

  if (state === null) {
    return (
      <section className="component-gate" aria-label={`${name}状态`} aria-busy={loading}>
        <div className="component-gate-copy">
          <Download size={18} aria-hidden="true" />
          <div>
            <strong>{loading ? `正在检查${name}…` : `无法读取${name}状态`}</strong>
            <p>生成前需要确认本地组件已经就绪。</p>
          </div>
        </div>
        {error && <p className="form-error" role="alert">组件状态读取失败：{error}</p>}
        {!loading && (
          <div className="component-gate-actions">
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void retry(id)}
            >
              <RotateCcw size={16} aria-hidden="true" />
              重试检查
            </button>
          </div>
        )}
      </section>
    );
  }

  if (state.status === 'ready') {
    return (
      <div className="component-ready" role="status">
        <CheckCircle2 size={17} aria-hidden="true" />
        {name}已就绪
      </div>
    );
  }

  if (state.status === 'installing') {
    const hasTotal = state.totalBytes > 0;
    const percentage = hasTotal
      ? Math.min(100, Math.floor((state.downloadedBytes / state.totalBytes) * 100))
      : null;
    return (
      <section className="component-gate" aria-label={`${name}状态`} aria-busy="true">
        <div className="component-gate-copy">
          <Download size={18} aria-hidden="true" />
          <div>
            <strong>{operation === 'cancel' ? `正在取消${name}安装…` : `正在安装${name}…`}</strong>
            <p>下载完成后会自动校验本地文件。</p>
          </div>
        </div>
        <div className="component-progress-copy">
          <span>
            {hasTotal
              ? `${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`
              : '正在获取下载大小…'}
          </span>
          {percentage !== null && <span>{percentage}%</span>}
        </div>
        <progress
          className="component-progress"
          aria-label={`${name}安装进度`}
          max={hasTotal ? state.totalBytes : 1}
          value={hasTotal ? state.downloadedBytes : undefined}
        />
        {state.currentFile && <p className="component-current-file">{state.currentFile}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="component-gate-actions">
          <button
            className="button button-secondary"
            type="button"
            disabled={operation === 'cancel'}
            onClick={() => void cancel(id)}
          >
            <X size={16} aria-hidden="true" />
            {operation === 'cancel' ? '正在取消…' : '取消安装'}
          </button>
        </div>
      </section>
    );
  }

  const displayError = error ?? state.error;
  return (
    <section className="component-gate" aria-label={`${name}状态`}>
      <div className="component-gate-copy">
        <Download size={18} aria-hidden="true" />
        <div>
          <strong>{state.status === 'failed' ? `${name}安装失败` : `需要安装${name}`}</strong>
          <p>
            {state.totalBytes > 0
              ? `下载大小：${formatBytes(state.totalBytes)}`
              : '下载大小将在安装时显示'}
          </p>
        </div>
      </div>
      {displayError && <p className="form-error" role="alert">{displayError}</p>}
      {generationBusy && (
        <p className="component-hint">当前有生成任务，完成后才能安装。</p>
      )}
      <div className="component-gate-actions">
        <button
          className="button button-secondary"
          type="button"
          disabled={generationBusy || operation !== null}
          onClick={() => void install(id)}
        >
          {state.status === 'failed' ? (
            <RotateCcw size={16} aria-hidden="true" />
          ) : (
            <Download size={16} aria-hidden="true" />
          )}
          {operation === 'install'
            ? '正在安装…'
            : state.status === 'failed'
              ? '重试安装'
              : `安装${name}`}
        </button>
      </div>
    </section>
  );
}
