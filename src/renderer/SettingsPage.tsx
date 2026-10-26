import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, RefreshCw, Save, Search, TestTube } from 'lucide-react';
import type { ComfyHealth } from '../shared/ipc';
import type { LlmProfile } from '../shared/types';
import { errorMessage } from './ui';

type LlmStatus =
  | { kind: 'idle' }
  | { kind: 'loading'; message: string }
  | { kind: 'models'; models: string[] }
  | { kind: 'test'; latencyMs: number; summary: string }
  | { kind: 'error'; message: string };

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<ComfyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<LlmProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus>({ kind: 'idle' });
  const [modelSearch, setModelSearch] = useState('');
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

  const canSave = baseUrl.trim().length > 0 && model.trim().length > 0;

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
      setProfile({ baseUrl: baseUrl.trim(), model: model.trim() });
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
    if (!canSave) {
      return;
    }
    setLlmStatus({ kind: 'loading', message: '正在获取模型列表…' });
    try {
      const models = await window.smo.llm.listModels({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
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
            <button
              className="button button-secondary"
              type="button"
              onClick={() => void window.smo.comfy.open()}
            >
              <ExternalLink size={16} aria-hidden="true" />
              打开 ComfyUI
            </button>
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
                placeholder={profile ? '留空以保留已有密钥' : '首次配置必须填写'}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
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
                disabled={!canSave}
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
