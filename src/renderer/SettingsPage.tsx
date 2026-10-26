import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ComfyHealth } from '../shared/ipc';
import type { LlmProfile } from '../shared/types';
import { errorMessage } from './ui';

export function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<ComfyHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<LlmProfile | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) {
      return;
    }
    setLoading(true);
    const [healthResult, profileResult] = await Promise.allSettled([
      window.smo.comfy.health(),
      window.smo.llm.getProfile(),
    ]);
    if (!mountedRef.current) {
      return;
    }
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    setHealthError(healthResult.status === 'rejected' ? errorMessage(healthResult.reason) : null);
    setProfile(profileResult.status === 'fulfilled' ? profileResult.value : null);
    setProfileError(profileResult.status === 'rejected' ? errorMessage(profileResult.reason) : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

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
          </section>
          <section className="settings-section">
            <span className="page-kicker">文字润色</span>
            <h3>{profile ? '已配置 LLM' : '未配置 LLM'}</h3>
            {profileError && <p className="form-error" role="alert">{profileError}</p>}
            {profile && (
              <dl className="status-details">
                <dt>模型</dt><dd>{profile.model}</dd>
                <dt>服务地址</dt><dd>{profile.baseUrl}</dd>
              </dl>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
