import { type KeyboardEvent, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';
import type { Avatar } from '../shared/types';
import { AudioDigitalHumanForm } from './AudioDigitalHumanForm';
import { AvatarImage } from './AvatarImage';
import { TextToVideoForm } from './TextToVideoForm';
import { useActiveJob } from './useActiveJob';

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
  const [videoMode, setVideoMode] = useState<'text' | 'audio'>('text');
  const textModeTabRef = useRef<HTMLButtonElement | null>(null);
  const audioModeTabRef = useRef<HTMLButtonElement | null>(null);
  const { busy, refresh } = useActiveJob();

  const focusVideoMode = (nextMode: 'text' | 'audio'): void => {
    setVideoMode(nextMode);
    (nextMode === 'text' ? textModeTabRef : audioModeTabRef).current?.focus();
  };

  const handleVideoModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentMode =
      event.target === audioModeTabRef.current
        ? 'audio'
        : event.target === textModeTabRef.current
          ? 'text'
          : videoMode;
    let nextMode: 'text' | 'audio';
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        nextMode = currentMode === 'text' ? 'audio' : 'text';
        break;
      case 'Home':
        nextMode = 'text';
        break;
      case 'End':
        nextMode = 'audio';
        break;
      default:
        return;
    }
    event.preventDefault();
    focusVideoMode(nextMode);
  };

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
            <div
              className="tab-list mode-tabs"
              role="tablist"
              aria-label="制作模式"
              onKeyDown={handleVideoModeKeyDown}
            >
              <button
                ref={textModeTabRef}
                id="text-mode-tab"
                type="button"
                role="tab"
                aria-selected={videoMode === 'text'}
                aria-controls="text-mode-panel"
                tabIndex={videoMode === 'text' ? 0 : -1}
                onClick={() => setVideoMode('text')}
              >
                文字生视频
              </button>
              <button
                ref={audioModeTabRef}
                id="audio-mode-tab"
                type="button"
                role="tab"
                aria-selected={videoMode === 'audio'}
                aria-controls="audio-mode-panel"
                tabIndex={videoMode === 'audio' ? 0 : -1}
                onClick={() => setVideoMode('audio')}
              >
                音频数字人
              </button>
            </div>
            <div
              id="text-mode-panel"
              role="tabpanel"
              aria-labelledby="text-mode-tab"
              hidden={videoMode !== 'text'}
            >
              <TextToVideoForm
                avatarId={avatar.id}
                modelDirectory={modelDirectory}
                active={videoMode === 'text'}
                busy={busy}
                onJobStarted={refresh}
              />
            </div>
            <div
              id="audio-mode-panel"
              role="tabpanel"
              aria-labelledby="audio-mode-tab"
              hidden={videoMode !== 'audio'}
            >
              <AudioDigitalHumanForm
                avatarId={avatar.id}
                modelDirectory={modelDirectory}
                active={videoMode === 'audio'}
                pageActive={pageActive}
                busy={busy}
                onJobStarted={refresh}
              />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
