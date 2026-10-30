import { Play, RotateCcw, Search, XCircle } from 'lucide-react';
import type {
  EnvironmentProfile,
  EnvironmentStage,
} from '../shared/environment';
import { fileName } from './ui';
import {
  isEnvironmentProfileAllowed,
  type EnvironmentController,
} from './useEnvironment';
import { WindowResizeHandles } from './WindowResizeHandles';
import { WindowTitlebar } from './WindowTitlebar';

const GIB = 1024 ** 3;

const STAGES: ReadonlyArray<{ id: EnvironmentStage; label: string }> = [
  { id: 'detect', label: '检测硬件' },
  { id: 'select', label: '选择配置' },
  { id: 'download-runtime', label: '下载运行时' },
  { id: 'extract', label: '解压运行时' },
  { id: 'download-models', label: '下载模型' },
  { id: 'verify', label: '校验文件' },
  { id: 'start', label: '启动 ComfyUI' },
  { id: 'ready', label: '环境就绪' },
];

const PROFILES: ReadonlyArray<{
  id: EnvironmentProfile;
  label: string;
}> = [
  { id: 'conservative', label: '保守（8 GB 兼容候选）' },
  { id: 'balanced-16gb', label: '均衡（至少 12 GB 显存）' },
  { id: 'high-memory-candidate', label: '高显存候选（至少 20 GB，未实测）' },
];

function formatGiB(bytes: number): string {
  return (bytes / GIB).toFixed(1);
}

interface EnvironmentWizardProps {
  environment: EnvironmentController;
}

export function EnvironmentWizard({ environment }: EnvironmentWizardProps) {
  const {
    state,
    profile,
    installRoot,
    error,
    busy,
    setProfile,
    setInstallRoot,
    detect,
    start,
    retry,
    cancel,
  } = environment;
  const hardware = state?.hardware ?? null;
  const selection = state?.selection ?? null;
  const stageIndex = STAGES.findIndex((stage) => stage.id === state?.stage);
  const currentStage = STAGES[stageIndex] ?? STAGES[0];
  const progress = state?.progress ?? { downloadedBytes: 0, totalBytes: 0 };
  const hasTotal = progress.totalBytes > 0;
  const percentage = hasTotal
    ? Math.min(100, Math.floor((progress.downloadedBytes / progress.totalBytes) * 100))
    : 0;
  const shouldRetry = state?.config != null;
  const message = error ?? state?.error ?? null;
  const canStart =
    state !== null &&
    !busy &&
    hardware !== null &&
    installRoot.trim().length > 0 &&
    isEnvironmentProfileAllowed(profile, hardware);

  return (
    <div className="app-frame">
      <WindowTitlebar />
      <WindowResizeHandles />
      <main className="environment-wizard">
        <div className="environment-content">
          <header className="environment-header">
            <div className="environment-brand">
              <img src="./brand/icon.png" alt="SMO.H3 Studio 标志" width="52" height="52" />
              <div>
                <h1>SMO.H3 Studio</h1>
                <h2>首次环境配置</h2>
              </div>
            </div>
            <span className="environment-stage-kicker">本地 H3 运行环境</span>
          </header>

          {message && <p className="form-error environment-error" role="alert">{message}</p>}

          {state === null ? (
            <p className="environment-loading" role="status" aria-live="polite">
              正在读取环境状态…
            </p>
          ) : (
            <>
              <section className="environment-section" aria-label="硬件摘要">
                <div className="environment-section-heading">
                  <h3>硬件摘要</h3>
                  {busy && state.stage === 'detect' && <span>正在自动检测…</span>}
                </div>
                <dl className="environment-hardware">
                  <div><dt>GPU</dt><dd>{hardware?.gpu ?? '尚未检测'}</dd></div>
                  <div><dt>显存</dt><dd>{hardware ? `${hardware.vramGiB} GiB` : '—'}</dd></div>
                  <div><dt>内存</dt><dd>{hardware ? `${hardware.ramGiB} GiB` : '—'}</dd></div>
                  <div><dt>CUDA CC</dt><dd>{hardware?.cudaComputeCapability || '—'}</dd></div>
                  <div><dt>空闲磁盘</dt><dd>{hardware ? `${hardware.freeDiskGiB} GiB` : '—'}</dd></div>
                </dl>
                <div className="environment-compatibility">
                  <p>最低兼容候选：RTX 30 系、8 GB 显存、32 GB 内存。</p>
                  <p>RTX 30/40 系使用 SM89；RTX 50 系使用 SM120。</p>
                  <p>RTX 30 系与 8 GB 显存仅为兼容候选，不保证生成性能。</p>
                </div>
              </section>

              <section className="environment-section" aria-label="安装配置">
                <div className="environment-section-heading">
                  <h3>安装配置</h3>
                  {selection && <span>预计需要 {formatGiB(selection.requiredBytes)} GiB</span>}
                </div>
                {selection && (
                  <p className="environment-runtime">{selection.runtime.displayName}</p>
                )}
                <div className="environment-fields">
                  <div className="field">
                    <label htmlFor="environment-profile">性能档位</label>
                    <select
                      id="environment-profile"
                      value={profile}
                      disabled={busy}
                      onChange={(event) => setProfile(event.target.value as EnvironmentProfile)}
                    >
                      {PROFILES.map((option) => (
                        <option
                          key={option.id}
                          value={option.id}
                          disabled={!isEnvironmentProfileAllowed(option.id, hardware)}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="environment-install-root">安装目录</label>
                    <input
                      id="environment-install-root"
                      value={installRoot}
                      disabled={busy}
                      onChange={(event) => setInstallRoot(event.target.value)}
                    />
                  </div>
                </div>
                <div className="environment-actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={!canStart}
                    onClick={() => void (shouldRetry ? retry() : start())}
                  >
                    {shouldRetry ? <RotateCcw size={17} aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
                    <span>{shouldRetry ? '重试安装' : '开始安装'}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || installRoot.trim().length === 0}
                    onClick={() => void detect()}
                  >
                    <Search size={17} aria-hidden="true" />
                    <span>重新检测</span>
                  </button>
                  {busy && (
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => void cancel()}
                    >
                      <XCircle size={17} aria-hidden="true" />
                      <span>取消安装</span>
                    </button>
                  )}
                </div>
              </section>

              <section className="environment-section" aria-label="安装状态">
                <div className="environment-stage-status" role="status" aria-live="polite">
                  <span>当前阶段</span>
                  <strong>{currentStage.label}</strong>
                </div>
                <ol className="environment-stages" aria-label="安装阶段">
                  {STAGES.map((stage, index) => {
                    const current = index === stageIndex;
                    const complete = state.stage === 'ready' || index < stageIndex;
                    return (
                      <li
                        key={stage.id}
                        className={current ? 'environment-stage-current' : complete ? 'environment-stage-complete' : ''}
                        aria-current={current ? 'step' : undefined}
                      >
                        {stage.label}
                      </li>
                    );
                  })}
                </ol>
                <div className="environment-progress-copy" aria-live="polite">
                  {hasTotal ? (
                    <>
                      <span>{formatGiB(progress.downloadedBytes)} / {formatGiB(progress.totalBytes)} GiB</span>
                      <strong>{percentage}%</strong>
                    </>
                  ) : (
                    <span>等待可计算的下载进度</span>
                  )}
                </div>
                <progress
                  className={hasTotal ? 'environment-progress' : 'environment-progress environment-progress-indeterminate'}
                  aria-label="安装进度"
                  max={hasTotal ? progress.totalBytes : 1}
                  value={hasTotal ? progress.downloadedBytes : undefined}
                />
                <p className="environment-current-file">
                  {progress.currentFile ? `当前文件：${fileName(progress.currentFile)}` : '当前文件：—'}
                </p>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
