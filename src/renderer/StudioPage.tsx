import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { Avatar } from '../shared/types';
import { AudioDigitalHumanForm } from './AudioDigitalHumanForm';
import { AvatarImage } from './AvatarImage';
import { TextToVideoForm } from './TextToVideoForm';

export function StudioPage({
  avatar,
  loading,
  error,
  modelDirectory,
  onCreateAvatar,
  pageActive = true,
}: {
  avatar: Avatar | null;
  loading: boolean;
  error: string | null;
  modelDirectory: string;
  onCreateAvatar: () => void;
  pageActive?: boolean;
}) {
  const [mode, setMode] = useState<'text' | 'audio'>('text');

  if (loading) {
    return <div className="page-state">正在读取数字模特…</div>;
  }

  return (
    <div className="studio-page">
      {error && <p className="form-error" role="alert">模特列表加载失败：{error}</p>}
      {avatar === null ? (
        <section className="empty-state">
          <UserPlus size={32} aria-hidden="true" />
          <h2>还没有数字模特</h2>
          <p>先添加一张人物照片，再开始制作视频。</p>
          <button className="button button-primary" type="button" onClick={onCreateAvatar}>
            新建数字模特
          </button>
        </section>
      ) : (
        <div className="studio-layout">
          <section className="person-preview" aria-label="当前人物预览">
            <div className="section-heading">
              <span>当前模特</span>
              <h2>{avatar.name}</h2>
            </div>
            <AvatarImage avatar={avatar} />
            <p className="reference-label">参考人物：&lt;Picture 1&gt;</p>
          </section>
          <section className="production-controls" aria-label="制作控制区">
            <div className="tab-list mode-tabs" role="tablist" aria-label="制作模式">
              <button
                id="text-mode-tab"
                type="button"
                role="tab"
                aria-selected={mode === 'text'}
                aria-controls="text-mode-panel"
                onClick={() => setMode('text')}
              >
                文字生视频
              </button>
              <button
                id="audio-mode-tab"
                type="button"
                role="tab"
                aria-selected={mode === 'audio'}
                aria-controls="audio-mode-panel"
                onClick={() => setMode('audio')}
              >
                音频数字人
              </button>
            </div>
            <div
              id="text-mode-panel"
              role="tabpanel"
              aria-labelledby="text-mode-tab"
              hidden={mode !== 'text'}
            >
              <TextToVideoForm
                avatarId={avatar.id}
                modelDirectory={modelDirectory}
                active={mode === 'text'}
              />
            </div>
            <div
              id="audio-mode-panel"
              role="tabpanel"
              aria-labelledby="audio-mode-tab"
              hidden={mode !== 'audio'}
            >
              <AudioDigitalHumanForm
                avatarId={avatar.id}
                modelDirectory={modelDirectory}
                active={mode === 'audio'}
                pageActive={pageActive}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
