import { useEffect, useState } from 'react';
import { Check, Save, Search, TestTube } from 'lucide-react';
import type { SanmaoProfileView } from '../shared/sanmao';
import { errorMessage } from './ui';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

export function SanmaoSettings({
  onSaved,
}: {
  onSaved?: (profile: SanmaoProfileView | null) => void;
}) {
  const [profile, setProfile] = useState<SanmaoProfileView | null>(null);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [manualModel, setManualModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void window.smo.sanmao.getProfile().then((next) => {
      if (!current) return;
      setProfile(next);
      if (next) {
        setBaseUrl(next.baseUrl);
        setModel(next.model);
      }
    }).catch((loadError) => {
      if (current) setError(errorMessage(loadError));
    });
    return () => {
      current = false;
    };
  }, []);

  const reenterRequired = profile?.keyStatus === 'reenter-required';
  const canSave = baseUrl.trim().length > 0 && model.trim().length > 0 &&
    (!reenterRequired || apiKey.trim().length > 0);
  const canTest = canSave;
  const filteredModels = models.filter((candidate) =>
    candidate.toLowerCase().includes(modelSearch.trim().toLowerCase()),
  );
  const modelOptions = model.trim() && !models.includes(model.trim())
    ? [model.trim(), ...filteredModels]
    : filteredModels;
  const hasUnsavedChanges = profile !== null && (
    profile.baseUrl !== baseUrl.trim() ||
    profile.model !== model.trim() ||
    apiKey.trim().length > 0
  );

  const getModels = async (): Promise<void> => {
    if (!baseUrl.trim()) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const next = await window.smo.sanmao.listModels({
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setModels(next);
      setNotice(`已获取 ${next.length} 个模型`);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await window.smo.sanmao.saveProfile({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      const next = await window.smo.sanmao.getProfile();
      setProfile(next);
      setApiKey('');
      setNotice('已保存');
      onSaved?.(next);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const test = async (): Promise<void> => {
    if (!canTest) return;
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      await window.smo.sanmao.testConnection({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      setNotice('连接正常');
    } catch (testError) {
      setError(errorMessage(testError));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="sanmao-settings-form">
      <h3>{profile ? '三脚猫已配置' : '三脚猫未配置'}</h3>
      <div className="field">
        <label htmlFor="sanmao-base-url">三脚猫服务地址</label>
        <input
          id="sanmao-base-url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="sanmao-api-key">三脚猫 API 密钥</label>
        <input
          id="sanmao-api-key"
          type="password"
          value={apiKey}
          placeholder={profile ? '留空以保留已有密钥' : '首次配置必须填写'}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <div className="settings-actions">
        <button
          className="button button-secondary"
          type="button"
          disabled={loading || !baseUrl.trim()}
          onClick={() => void getModels()}
        >
          <Search size={16} aria-hidden="true" />
          {loading ? '正在获取…' : '获取模型'}
        </button>
      </div>
      {models.length > 0 && (
        <div className="field">
          <label htmlFor="sanmao-model-search">搜索模型</label>
          <input
            id="sanmao-model-search"
            value={modelSearch}
            onChange={(event) => setModelSearch(event.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="sanmao-model">三脚猫模型</label>
        {manualModel || models.length === 0 ? (
          <input
            id="sanmao-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        ) : (
          <select
            id="sanmao-model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            {model === '' && <option value="">请选择模型</option>}
            {modelOptions.map((candidate) => (
              <option key={candidate} value={candidate}>{candidate}</option>
            ))}
          </select>
        )}
      </div>
      {models.length > 0 && (
        <label className="checkbox-field" htmlFor="sanmao-manual-model">
          <input
            id="sanmao-manual-model"
            type="checkbox"
            checked={manualModel}
            onChange={(event) => setManualModel(event.target.checked)}
          />
          手动输入模型 ID
        </label>
      )}
      <div className="settings-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={!canSave || saving}
          onClick={() => void save()}
        >
          <Save size={16} aria-hidden="true" />
          {saving ? '正在保存…' : '保存三脚猫设置'}
        </button>
        <button
          className="button button-secondary"
          type="button"
          disabled={!canTest || testing}
          onClick={() => void test()}
        >
          <TestTube size={16} aria-hidden="true" />
          {testing ? '正在测试…' : '测试连接'}
        </button>
      </div>
      {profile && !hasUnsavedChanges && !reenterRequired && (
        <p className="form-notice form-notice-success" role="status">
          <Check size={14} aria-hidden="true" />已保存
        </p>
      )}
      {hasUnsavedChanges && <p className="form-notice" role="status">有未保存修改</p>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
