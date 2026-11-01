import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Cpu, ExternalLink, Play, RefreshCw, RotateCcw, Save, Search, TestTube } from 'lucide-react';
import type { ComfyHealth } from '../shared/ipc';
import { DEFAULT_MODEL_DIRECTORY } from '../shared/generation-options';
import type { HardwareInfo, HardwareProfile, LlmProfileView, VideoMode } from '../shared/types';
import { errorMessage } from './ui';

type LlmStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'models'; models: string[] }
  | { kind: 'test'; latencyMs: number; summary: string }
  | { kind: 'error'; message: string };

const HARDWARE_PRESET_TEXT = {
  conservative: {
    label: "稳妥模式",
    scenario: "适用场景：显存不足 12 GiB，或内存不足 32 GiB；优先降低资源占用。",
  },
  "balanced-16gb": {
    label: "均衡模式",
    scenario: "适用场景：显存 12 至 20 GiB 且内存至少 32 GiB；兼顾画质与稳定性。",
  },
  "high-memory-candidate": {
    label: "高显存候选模式",
    scenario: "适用场景：显存至少 20 GiB 且内存至少 32 GiB；优先利用充足显存。",
  },
} as const;

const HARDWARE_MODEL_POLICY_TEXT = {
  int8: "使用 INT8 模型，减少显存占用",
  "bf16-if-present": "优先使用 BF16 模型；未安装时自动改用 INT8 模型",
} as const;

function formatGiB(value: number): string {
  return value.toFixed(1) + " GiB";
}

function formatResolution(megapixels: number): string {
  if (megapixels === 0.4) return "0.4 MP，较低清晰度，优先减少显存占用";
  if (megapixels === 0.7) return "0.7 MP，兼顾清晰度与显存占用";
  if (megapixels === 1) return "1.0 MP，较高清晰度，适合显存充足的设备";
  return megapixels.toFixed(1) + " MP";
}

function formatTiling(tiling: HardwareProfile["tiling"]): string {
  return tiling === "auto"
    ? "自动分块处理画面，降低单次生成的显存压力"
    : `手动分为 ${tiling} 块处理画面，降低显存峰值`;
}

export function SettingsPage({
  modelDirectory: controlledDirectory,
  onModelDirectoryChange,
}: {
  modelDirectory?: string;
  onModelDirectoryChange?: (directory: string) => void;
} = {}) {
  const [localDirectory, setLocalDirectory] = useState(DEFAULT_MODEL_DIRECTORY);
  const modelDirectory = controlledDirectory ?? localDirectory;
  const setModelDirectory = onModelDirectoryChange ?? setLocalDirectory;
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<ComfyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [startingComfy, setStartingComfy] = useState(false);
  const [profile, setProfile] = useState<LlmProfileView | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({ kind: 'idle' });
  const [modelSearch, setModelSearch] = useState('');
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null);
  const [recommendation, setRecommendation] = useState<HardwareProfile | null>(null);
  const [hardwareMode, setHardwareMode] = useState<VideoMode>("text");
  const [hardwareAction, setHardwareAction] = useState<
    "detect" | "recommend" | "apply" | "reset" | null
  >(null);
  const [hardwareError, setHardwareError] = useState<string | null>(null);
  const [hardwareResult, setHardwareResult] = useState<{
    kind: "applied" | "reset";
    path: string;
  } | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    setLoading(true);
    setLlmStatus({ kind: 'idle' });
    const [healthResult, profileResult] = await Promise.allSettled([
      window.smo.comfy.health(),
      window.smo.llm.getProfile(),
    ]);
    if (!mountedRef.current) {
      return;
    }
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    setHealthError(healthResult.status === 'rejected' ? errorMessage(healthResult.reason) : null);

    const loadedProfile = profileResult.status === 'fulfilled' ? profileResult.value : null;
    setProfile(loadedProfile);
    setProfileError(profileResult.status === 'rejected' ? errorMessage(profileResult.reason) : null);
    setBaseUrl(loadedProfile?.baseUrl ?? '');
    setModel(loadedProfile?.model ?? '');
    setApiKey('');
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  const reenterRequired =
    profile !== null && profile.keyStatus === 'reenter-required';
  const matchesSavedProfile =
    profile !== null &&
    baseUrl.trim() === profile.baseUrl &&
    model.trim() === profile.model;
  const hasUnsavedChanges =
    profile !== null && (!matchesSavedProfile || apiKey.trim().length > 0);
  const canListModels = baseUrl.trim().length > 0;
  const canSave =
    canListModels &&
    model.trim().length > 0 &&
    (!reenterRequired || apiKey.trim().length > 0);

  const save = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setSaving(true);
    setProfileError(null);
    setLlmStatus({ kind: 'idle' });
    try {
      await window.smo.llm.saveProfile({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      if (!mountedRef.current) {
        return;
      }
      setProfile({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        keyStatus: 'valid',
      });
      setApiKey('');
    } catch (error) {
      if (mountedRef.current) {
        setProfileError(errorMessage(error));
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  };

  const listModels = async (): Promise<void> => {
    if (!canListModels) {
      return;
    }
    setLlmStatus({ kind: 'loading', message: '正在获取模型列表…' });
    try {
      const trimmedModel = model.trim();
      const models = await window.smo.llm.listModels({
        baseUrl: baseUrl.trim(),
        ...(trimmedModel.length > 0 ? { model: trimmedModel } : {}),
        apiKey: apiKey.trim(),
      });
      if (mountedRef.current) {
        setLlmStatus({ kind: 'models', models });
      }
    } catch (error) {
      if (mountedRef.current) {
        setLlmStatus({ kind: 'error', message: errorMessage(error) });
      }
    }
  };

  const startComfy = async (): Promise<void> => {
    if (!mountedRef.current || startingComfy) {
      return;
    }
    setStartingComfy(true);
    try {
      const stats = await window.smo.comfy.start();
      if (!mountedRef.current) {
        return;
      }
      setHealth(stats);
      setHealthError(null);
    } catch (error) {
      if (!mountedRef.current) {
        return;
      }
      setHealth(null);
      setHealthError(errorMessage(error));
    } finally {
      if (mountedRef.current) {
        setStartingComfy(false);
      }
    }
  };

  const testModel = async (): Promise<void> => {
    if (!canSave) {
      return;
    }
    setLlmStatus({ kind: 'loading', message: '正在测试模型…' });
    try {
      const result = await window.smo.llm.testModel({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      if (mountedRef.current) {
        setLlmStatus({ kind: 'test', latencyMs: result.latencyMs, summary: result.summary });
      }
    } catch (error) {
      if (mountedRef.current) {
        setLlmStatus({ kind: 'error', message: errorMessage(error) });
      }
    }
  };

  const detectHardware = async (): Promise<void> => {
    if (!mountedRef.current || hardwareAction !== null) return;
    setHardwareAction("detect");
    setHardwareError(null);
    setHardwareResult(null);
    setHardwareInfo(null);
    setRecommendation(null);
    try {
      const info = await window.smo.hardware.detect();
      if (!mountedRef.current) return;
      setHardwareInfo(info);
      const profile = await window.smo.hardware.recommend({
        gpu: info.gpu,
        vramGiB: info.vramGiB,
        ramGiB: info.ramGiB,
      });
      if (mountedRef.current) setRecommendation(profile);
    } catch (error) {
      if (!mountedRef.current) return;
      setRecommendation(null);
      setHardwareError(errorMessage(error));
    } finally {
      if (mountedRef.current) setHardwareAction(null);
    }
  };

  const recommendHardware = async (): Promise<void> => {
    const info = hardwareInfo;
    if (!mountedRef.current || info === null || hardwareAction !== null) return;
    setHardwareAction("recommend");
    setHardwareError(null);
    setHardwareResult(null);
    try {
      const profile = await window.smo.hardware.recommend({
        gpu: info.gpu,
        vramGiB: info.vramGiB,
        ramGiB: info.ramGiB,
      });
      if (mountedRef.current) setRecommendation(profile);
    } catch (error) {
      if (!mountedRef.current) return;
      setRecommendation(null);
      setHardwareError(errorMessage(error));
    } finally {
      if (mountedRef.current) setHardwareAction(null);
    }
  };

  const applyHardwareRecommendation = async (): Promise<void> => {
    const profile = recommendation;
    const directory = modelDirectory.trim();
    if (
      !mountedRef.current ||
      profile === null ||
      hardwareAction !== null ||
      directory.length === 0
    ) {
      return;
    }
    const mode = hardwareMode;
    const confirmed = window.confirm(
      "确认将“" + HARDWARE_PRESET_TEXT[profile.preset].label + "”应用到 " + mode + " 工作流？原工作流不会被修改。",
    );
    if (!confirmed || !mountedRef.current) return;
    setHardwareAction("apply");
    setHardwareError(null);
    setHardwareResult(null);
    try {
      const result = await window.smo.hardware.apply({
        mode,
        profile,
        confirmed: true,
        modelDirectory: directory,
      });
      if (mountedRef.current) {
        setHardwareResult({ kind: "applied", path: result.path });
      }
    } catch (error) {
      if (mountedRef.current) setHardwareError(errorMessage(error));
    } finally {
      if (mountedRef.current) setHardwareAction(null);
    }
  };

  const resetHardware = async (): Promise<void> => {
    if (!mountedRef.current || hardwareAction !== null) return;
    const mode = hardwareMode;
    const confirmed = window.confirm(
      "确认恢复 " + mode + " 模式的冻结默认工作流？当前激活配置将被清除。",
    );
    if (!confirmed || !mountedRef.current) return;
    setHardwareAction("reset");
    setHardwareError(null);
    setHardwareResult(null);
    try {
      const path = await window.smo.hardware.reset(mode);
      if (mountedRef.current) setHardwareResult({ kind: "reset", path });
    } catch (error) {
      if (mountedRef.current) setHardwareError(errorMessage(error));
    } finally {
      if (mountedRef.current) setHardwareAction(null);
    }
  };

  const selectModel = (value: string): void => {
    setModel(value);
    setLlmStatus({ kind: 'idle' });
  };

  const filteredModels =
    llmStatus.kind === 'models'
      ? llmStatus.models.filter((candidate) =>
          candidate.toLowerCase().includes(modelSearch.toLowerCase()),
        )
      : [];

  return (
    <div className="standard-page">
      <header className="page-header">
        <div>
          <span className="page-kicker">运行状态</span>
          <h2>设置</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={16} aria-hidden="true" />
          重新检测
        </button>
      </header>
      {loading ? (
        <div className="page-state">正在检测服务与配置…</div>
      ) : (
        <div className="settings-grid">
          <section className="settings-section">
            <span className="page-kicker">硬件与工作流</span>
            <h3>硬件配置</h3>
            <div className="settings-actions">
              <button
                className="button button-secondary"
                type="button"
                disabled={hardwareAction !== null}
                onClick={() => void detectHardware()}
              >
                <Cpu size={16} aria-hidden="true" />
                {hardwareAction === "detect" ? "正在检测…" : "检测硬件"}
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={hardwareInfo === null || hardwareAction !== null}
                onClick={() => void recommendHardware()}
              >
                <Search size={16} aria-hidden="true" />
                {hardwareAction === "recommend" ? "正在推荐…" : "获取推荐"}
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={hardwareAction !== null}
                onClick={() => void resetHardware()}
              >
                <RotateCcw size={16} aria-hidden="true" />
                {hardwareAction === "reset" ? "正在恢复…" : "恢复默认"}
              </button>
            </div>
            <p className="form-notice">
              应用推荐或恢复默认后，将在下一次生成时生效，不影响正在运行的任务和已有作品。
            </p>
            {hardwareError && <p className="form-error" role="alert">{hardwareError}</p>}
            {hardwareInfo && (
              <dl className="status-details">
                <dt>GPU</dt><dd>{hardwareInfo.gpu}</dd>
                <dt>显存</dt><dd>{formatGiB(hardwareInfo.vramGiB)}</dd>
                <dt>内存</dt><dd>{formatGiB(hardwareInfo.ramGiB)}</dd>
                <dt>驱动</dt><dd>{hardwareInfo.driverVersion}</dd>
                <dt>CUDA</dt><dd>{hardwareInfo.cudaComputeCapability}</dd>
                <dt>Windows</dt><dd>{hardwareInfo.windowsVersion}</dd>
                <dt>空闲磁盘</dt><dd>{formatGiB(hardwareInfo.freeDiskGiB)}</dd>
              </dl>
            )}
            <div className="field">
              <label htmlFor="hardware-mode">应用模式</label>
              <select
                id="hardware-mode"
                value={hardwareMode}
                disabled={hardwareAction !== null}
                onChange={(event) => {
                  setHardwareMode(event.target.value as VideoMode);
                  setHardwareResult(null);
                  setHardwareError(null);
                }}
              >
                <option value="text">文本生视频</option>
                <option value="audio">音频数字人</option>
              </select>
            </div>
            {recommendation && (
              <div>
                <dl className="status-details">
                  <dt>配置方案</dt><dd>{HARDWARE_PRESET_TEXT[recommendation.preset].label}</dd>
                  <dt>模型策略</dt><dd>{HARDWARE_MODEL_POLICY_TEXT[recommendation.modelPolicy]}</dd>
                  <dt>显存策略</dt><dd>{recommendation.lowvram ? "节省显存模式，降低占用但可能稍慢" : "标准显存模式，适合显存充足的设备"}</dd>
                  <dt>分辨率</dt><dd>{formatResolution(recommendation.megapixels)}</dd>
                  <dt>平铺方式</dt><dd>{formatTiling(recommendation.tiling)}</dd>
                </dl>
                <p className="form-notice">
                  {HARDWARE_PRESET_TEXT[recommendation.preset].scenario}
                </p>
                {recommendation.preset === "high-memory-candidate" && (
                  <p className="form-notice">高显存候选配置，尚未实测。</p>
                )}
                <div className="field">
                  <label htmlFor="hardware-model-directory">模型目录</label>
                  <input
                    id="hardware-model-directory"
                    value={modelDirectory}
                    disabled={hardwareAction !== null}
                    onChange={(event) => setModelDirectory(event.target.value)}
                  />
                </div>
                <div className="settings-actions">
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={hardwareAction !== null || modelDirectory.trim().length === 0}
                    onClick={() => void applyHardwareRecommendation()}
                  >
                    <Check size={16} aria-hidden="true" />
                    {hardwareAction === "apply" ? "正在应用…" : "应用推荐"}
                  </button>
                </div>
              </div>
            )}
            {hardwareResult && (
              <p className="form-notice" role="status">
                {hardwareResult.kind === "applied" ? "已应用工作流副本：" : "已恢复默认工作流："}
                {hardwareResult.path}
              </p>
            )}
          </section>
          <section className="settings-section">
            <span className="page-kicker">生成服务</span>
            <h3>{health ? 'ComfyUI 连接正常' : 'ComfyUI 不可用'}</h3>
            {healthError && <p className="form-error" role="alert">{healthError}</p>}
            {health && (
              <dl className="status-details">
                {typeof health.system.os === 'string' && <><dt>系统</dt><dd>{health.system.os}</dd></>}
                {health.devices.map((device, index) =>
                  typeof device.name === 'string' ? (
                    <div className="device-row" key={`${device.name}-${index}`}>
                      <dt>设备 {index + 1}</dt>
                      <dd>{device.name}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            )}
            {health ? (
              <button
                className="button button-secondary"
                type="button"
                onClick={() => void window.smo.comfy.open()}
              >
                <ExternalLink size={16} aria-hidden="true" />
                打开 ComfyUI
              </button>
            ) : (
              <button
                className="button button-secondary"
                type="button"
                disabled={startingComfy}
                onClick={() => void startComfy()}
              >
                <Play size={16} aria-hidden="true" />
                {startingComfy ? '正在启动…' : '启动 ComfyUI'}
              </button>
            )}
          </section>
          <section className="settings-section">
            <span className="page-kicker">文字润色</span>
            <h3>{profile ? '已配置 LLM' : '未配置 LLM'}</h3>
            {profileError && <p className="form-error" role="alert">{profileError}</p>}
            <div className="field">
              <label htmlFor="llm-base-url">服务地址</label>
              <input
                id="llm-base-url"
                value={baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="llm-model">模型</label>
              <input
                id="llm-model"
                value={model}
                placeholder="gpt-4o"
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="llm-api-key">API 密钥</label>
              <input
                id="llm-api-key"
                type="password"
                value={apiKey}
                placeholder={
                  reenterRequired
                    ? '密钥无法读取，请重新输入'
                    : profile
                      ? '留空以保留已有密钥'
                      : '首次配置必须填写'
                }
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            {reenterRequired && (
              <p className="form-error" role="alert">
                密钥无法读取，需要重新输入密钥后才能保存或测试。
              </p>
            )}
            <div className="settings-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={!canSave || saving}
                onClick={() => void save()}
              >
                <Save size={16} aria-hidden="true" />
                {saving ? '正在保存…' : '保存设置'}
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={!canListModels}
                onClick={() => void listModels()}
              >
                <Search size={16} aria-hidden="true" />
                获取模型
              </button>
              <button
                className="button button-secondary"
                type="button"
                disabled={!canSave}
                onClick={() => void testModel()}
              >
                <TestTube size={16} aria-hidden="true" />
                测试模型
              </button>
            </div>
            {profile !== null && !reenterRequired && !hasUnsavedChanges && (
              <p className="form-notice form-notice-success" role="status">
                <Check size={14} aria-hidden="true" />
                已保存
              </p>
            )}
            {hasUnsavedChanges && (
              <p className="form-notice" role="status">有未保存修改</p>
            )}
            {llmStatus.kind === 'loading' && <p className="form-notice" role="status">{llmStatus.message}</p>}
            {llmStatus.kind === 'models' && (
              <div className="model-list">
                <div className="field">
                  <label htmlFor="llm-model-search">搜索模型</label>
                  <input
                    id="llm-model-search"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                  />
                </div>
                {filteredModels.length === 0 ? (
                  <p className="form-notice">没有匹配的模型</p>
                ) : (
                  <ul className="model-options" role="listbox" aria-label="可用模型">
                    {filteredModels.map((candidate) => (
                      <li key={candidate} role="option">
                        <button
                          className="button button-text"
                          type="button"
                          onClick={() => selectModel(candidate)}
                        >
                          {candidate === model && <Check size={14} aria-hidden="true" />}
                          {candidate}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {llmStatus.kind === 'test' && (
              <p className="form-notice" role="status">
                测试通过，延迟 {llmStatus.latencyMs} ms，回复：{llmStatus.summary}
              </p>
            )}
            {llmStatus.kind === 'error' && <p className="form-error" role="alert">{llmStatus.message}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
