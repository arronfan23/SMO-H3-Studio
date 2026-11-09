import { type KeyboardEvent, useRef, useState } from 'react';
import { Mic, UserPlus, Video } from 'lucide-react';
import type { Avatar } from '../shared/types';
import { AudioDigitalHumanForm } from './AudioDigitalHumanForm';
import { AvatarImage } from './AvatarImage';
import { SpeechForm } from './SpeechForm';
import { TextToVideoForm } from './TextToVideoForm';
import { useActiveJob } from './useActiveJob';

type StudioMode = 'speech' | 'image' | 'video';
type VisibleStudioMode = 'speech' | 'video';

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
  const [mode, setMode] = useState<StudioMode>('video');
  const [videoMode, setVideoMode] = useState<'text' | 'audio'>('text');
  const speechModeTabRef = useRef<HTMLButtonElement | null>(null);
  const videoModeTabRef = useRef<HTMLButtonElement | null>(null);
  const textModeTabRef = useRef<HTMLButtonElement | null>(null);
  const audioModeTabRef = useRef<HTMLButtonElement | null>(null);
  const { busy, refresh } = useActiveJob();

  const focusMode = (nextMode: VisibleStudioMode): void => {
    setMode(nextMode);
    (nextMode === 'speech' ? speechModeTabRef : videoModeTabRef).current?.focus();
  };

  const handleModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentMode = event.target === speechModeTabRef.current ? 'speech' : 'video';
    let nextMode: VisibleStudioMode;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight':
        nextMode = currentMode === 'speech' ? 'video' : 'speech';
        break;
      case 'Home':
        nextMode = 'speech';
        break;
      case 'End':
        nextMode = 'video';
        break;
      default:
        return;
    }
    event.preventDefault();
    focusMode(nextMode);
  };

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

  return (
    <div className="studio-page">
      <div
        className="tab-list main-mode-tabs"
        role="tablist"
        aria-label="主制作模式"
        onKeyDown={handleModeKeyDown}
      >
        <button
          ref={speechModeTabRef}
          id="speech-main-tab"
          type="button"
          role="tab"
          aria-selected={mode === 'speech'}
          aria-controls="speech-main-panel"
          tabIndex={mode === 'speech' ? 0 : -1}
          onClick={() => setMode('speech')}
        >
          <Mic size={17} aria-hidden="true" />
          语音
        </button>
        <button
          ref={videoModeTabRef}
          id="video-main-tab"
          type="button"
          role="tab"
          aria-selected={mode === 'video'}
          aria-controls="video-main-panel"
          tabIndex={mode === 'video' ? 0 : -1}
          onClick={() => setMode('video')}
        >
          <Video size={17} aria-hidden="true" />
          视频
        </button>
      </div>

      <div
        id="speech-main-panel"
        role="tabpanel"
        aria-labelledby="speech-main-tab"
        hidden={mode !== 'speech'}
      >
        <section className="production-controls speech-controls" aria-label="语音控制区">
          <SpeechForm
            active={mode === 'speech'}
            pageActive={pageActive}
            busy={busy}
            onJobStarted={refresh}
          />
        </section>
      </div>

      <div
        id="video-main-panel"
        role="tabpanel"
        aria-labelledby="video-main-tab"
        hidden={mode !== 'video'}
      >
        {error && <p className="form-error" role="alert">模特列表加载失败：{error}</p>}
        {loading ? (
          <div className="page-state">正在读取数字模特…</div>
        ) : avatar === null ? (
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
                  active={mode === 'video' && videoMode === 'text'}
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
                  active={mode === 'video' && videoMode === 'audio'}
                  pageActive={pageActive && mode === 'video'}
                  busy={busy}
                  onJobStarted={refresh}
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
