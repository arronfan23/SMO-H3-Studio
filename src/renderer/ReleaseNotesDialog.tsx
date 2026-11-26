import { useEffect, useState } from 'react';

export const SEEN_VERSION_STORAGE_KEY = 'smo-h3-studio:seen-version';

const RELEASE_NOTES: Record<string, string[]> = {
  '0.6.3': [
    '制作台支持自适应双栏，宽屏并排、窄屏自动堆叠。',
    '图片与视频在输出区完整缩放，保持原始比例。',
    '语音入口已合并到制作台，情绪与语气为可选项。',
    '旧作品保持兼容，可继续查看和使用已有结果。',
  ],
  '0.6.0': [
    '三脚猫支持多轮工具调用，可以实际读取文件、搜索和执行任务。',
    'SDK 会话支持持久保存与续聊，重启后仍可继续。',
    '新增工具执行状态和敏感操作权限确认。',
    '新增版本更新内容提示。',
  ],
};

export function ReleaseNotesDialog() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const request = window.smo.app?.getVersion() ?? Promise.resolve(null);
    void request.then((nextVersion) => {
      if (!current) return;
      if (nextVersion === null) return;
      if (window.localStorage.getItem(SEEN_VERSION_STORAGE_KEY) === nextVersion) return;
      setVersion(nextVersion);
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  if (version === null) return null;
  const notes = RELEASE_NOTES[version] ?? ['优化了稳定性与使用体验。'];
  const close = () => {
    window.localStorage.setItem(SEEN_VERSION_STORAGE_KEY, version);
    setVersion(null);
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="更新内容"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <div className="modal-card release-notes-card">
        <span className="release-notes-brand">SMO.H3 Studio</span>
        <h2>更新内容</h2>
        <p className="release-notes-version">版本 {version}</p>
        <ul className="release-notes-list">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
        <div className="modal-actions">
          <button
            type="button"
            className="button button-primary"
            autoFocus
            onClick={close}
          >
            开始使用
          </button>
        </div>
      </div>
    </div>
  );
}
