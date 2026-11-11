import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Mic, UserPlus, Video } from 'lucide-react';
import type { Avatar } from '../shared/types';
import type { StudioIntent, StudioMode } from './App';
import { AudioDigitalHumanForm } from './AudioDigitalHumanForm';
import { AvatarImage } from './AvatarImage';
import { ImageForm } from './ImageForm';
import { SpeechForm } from './SpeechForm';
import { TextToVideoForm } from './TextToVideoForm';
import { useActiveJob } from './useActiveJob';

const STUDIO_MODES: readonly StudioMode[] = ['speech', 'image', 'video'];
type VideoSubmode = 'text' | 'reference' | 'audio';
const VIDEO_SUBMODES: readonly VideoSubmode[] = ['text', 'reference', 'audio'];

export function StudioPage({
  avatar,
  loading,
  error,
  modelDirectory,
  onCreateAvatar,
  pageActive = true,
  intent = null,
  mode: controlledMode,
  onModeChange,
}: {
  avatar: Avatar | null;
  loading: boolean;
  error: string | null;
  modelDirectory: string;
  onCreateAvatar: () => void;
  pageActive?: boolean;
  intent?: StudioIntent | null;
  mode?: StudioMode;
  onModeChange?: (mode: StudioMode) => void;
}) {
  const [internalMode, setInternalMode] = useState<StudioMode>('video');
  const mode = controlledMode ?? internalMode;
  const [videoMode, setVideoMode] = useState<VideoSubmode>('text');
  const speechModeTabRef = useRef<HTMLButtonElement | null>(null);
  const imageModeTabRef = useRef<HTMLButtonElement | null>(null);
  const videoModeTabRef = useRef<HTMLButtonElement | null>(null);
  const textModeTabRef = useRef<HTMLButtonElement | null>(null);
  const referenceModeTabRef = useRef<HTMLButtonElement | null>(null);
  const audioModeTabRef = useRef<HTMLButtonElement | null>(null);
  const handledIntentTokenRef = useRef<number | null>(null);
  const pendingIntentFocusTokenRef = useRef<number | null>(null);
  const { busy, syncRevision, refresh } = useActiveJob();
  const generationPendingRef = useRef(false);
  const [isGenerationPending, setIsGenerationPending] = useState(false);

  const onGenerationPendingChange = useCallback((pending: boolean): void => {
    generationPendingRef.current = pending;
    setIsGenerationPending(pending);
  }, []);
  const syncRevisionRef = useRef(syncRevision);
  const handoffRevisionRef = useRef<number | null>(null);
  syncRevisionRef.current = syncRevision;

  useEffect(() => {
    const handoffRevision = handoffRevisionRef.current;
    if (handoffRevision === null || syncRevision <= handoffRevision) {
      return;
    }
    handoffRevisionRef.current = null;
    onGenerationPendingChange(false);
  }, [onGenerationPendingChange, syncRevision]);

  const onJobStarted = useCallback((): Promise<boolean> => {
    handoffRevisionRef.current = syncRevisionRef.current;
    return refresh();
  }, [refresh]);

  const setMode = useCallback((nextMode: StudioMode): void => {
    if (controlledMode === undefined) {
      setInternalMode(nextMode);
    }
    onModeChange?.(nextMode);
  }, [controlledMode, onModeChange]);

  useEffect(() => {
    if (intent === null) {
      return;
    }
    const handledToken = handledIntentTokenRef.current;
    if (handledToken !== null && intent.token <= handledToken) {
      return;
    }
    handledIntentTokenRef.current = intent.token;
    pendingIntentFocusTokenRef.current = intent.token;
    setMode(intent.mode);
    setVideoMode(intent.videoMode);
  }, [intent, setMode]);

  useEffect(() => {
    if (
      intent === null ||
      pendingIntentFocusTokenRef.current !== intent.token ||
      mode !== intent.mode ||
      videoMode !== intent.videoMode
    ) {
      return;
    }
    const audioTab = audioModeTabRef.current;
    if (audioTab === null) {
      return;
    }
    audioTab.focus();
    pendingIntentFocusTokenRef.current = null;
  }, [avatar, loading, intent, mode, videoMode]);

  const focusMode = (nextMode: StudioMode): void => {
    setMode(nextMode);
    const refs = {
      speech: speechModeTabRef,
      image: imageModeTabRef,
      video: videoModeTabRef,
    };
    refs[nextMode].current?.focus();
  };

  const handleModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentMode = event.target === speechModeTabRef.current
      ? 'speech'
      : event.target === imageModeTabRef.current
        ? 'image'
        : event.target === videoModeTabRef.current
          ? 'video'
          : mode;
    const currentIndex = STUDIO_MODES.indexOf(currentMode);
    let nextMode: StudioMode;
    switch (event.key) {
      case 'ArrowLeft':
        nextMode = STUDIO_MODES[(currentIndex - 1 + STUDIO_MODES.length) % STUDIO_MODES.length];
        break;
      case 'ArrowRight':
        nextMode = STUDIO_MODES[(currentIndex + 1) % STUDIO_MODES.length];
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

  const focusVideoMode = (nextMode: VideoSubmode): void => {
    setVideoMode(nextMode);
    const refs = {
      text: textModeTabRef,
      reference: referenceModeTabRef,
      audio: audioModeTabRef,
    };
    refs[nextMode].current?.focus();
  };

  const handleVideoModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentMode = event.target === referenceModeTabRef.current
      ? 'reference'
      : event.target === audioModeTabRef.current
        ? 'audio'
        : event.target === textModeTabRef.current
          ? 'text'
          : videoMode;
    const currentIndex = VIDEO_SUBMODES.indexOf(currentMode);
    let nextMode: VideoSubmode;
    switch (event.key) {
      case 'ArrowLeft':
        nextMode = VIDEO_SUBMODES[
          (currentIndex - 1 + VIDEO_SUBMODES.length) % VIDEO_SUBMODES.length
        ];
        break;
      case 'ArrowRight':
        nextMode = VIDEO_SUBMODES[(currentIndex + 1) % VIDEO_SUBMODES.length];
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
      {controlledMode === undefined && (
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
            ref={imageModeTabRef}
            id="image-main-tab"
            type="button"
            role="tab"
            aria-selected={mode === 'image'}
            aria-controls="image-main-panel"
            tabIndex={mode === 'image' ? 0 : -1}
            onClick={() => setMode('image')}
          >
            <ImageIcon size={17} aria-hidden="true" />
            图像
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
      )}

      <section
        id="speech-main-panel"
        role={controlledMode === undefined ? 'tabpanel' : undefined}
        aria-label={controlledMode === undefined ? undefined : '语音制作'}
        aria-labelledby={controlledMode === undefined ? 'speech-main-tab' : undefined}
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
      </section>

      <section
        id="image-main-panel"
        role={controlledMode === undefined ? 'tabpanel' : undefined}
        aria-label={controlledMode === undefined ? undefined : '图像制作'}
        aria-labelledby={controlledMode === undefined ? 'image-main-tab' : undefined}
        hidden={mode !== 'image'}
      >
        <section className="production-controls image-controls" aria-label="图像控制区">
          <ImageForm
            active={mode === 'image'}
            pageActive={pageActive}
            busy={busy}
            syncRevision={syncRevision}
            onJobStarted={refresh}
          />
        </section>
      </section>

      <section
        id="video-main-panel"
        role={controlledMode === undefined ? 'tabpanel' : undefined}
        aria-label={controlledMode === undefined ? undefined : '视频制作'}
        aria-labelledby={controlledMode === undefined ? 'video-main-tab' : undefined}
        hidden={mode !== 'video'}
      >
        {error && <p className="form-error" role="alert">模特列表加载失败：{error}</p>}
        {loading ? (
          <div className="page-state">正在读取数字模特…</div>
        ) : (
          <div className={`studio-layout${avatar === null ? ' studio-layout-without-avatar' : ''}`}>
            {avatar !== null && (
              <section className="person-preview" aria-label="当前人物预览">
                <div className="section-heading">
                  <span>当前模特</span>
                  <h2>{avatar.name}</h2>
                </div>
                <AvatarImage avatar={avatar} />
                {videoMode === 'audio' && (
                  <p className="reference-label">参考人物：&lt;Picture 1&gt;</p>
                )}
              </section>
            )}
            <section className="production-controls" aria-label="制作控制区">
              <div
                className="tab-list mode-tabs video-mode-tabs"
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
                  disabled={isGenerationPending}
                  tabIndex={videoMode === 'text' ? 0 : -1}
                  onClick={() => setVideoMode('text')}
                >
                  文生视频
                </button>
                <button
                  ref={referenceModeTabRef}
                  id="reference-mode-tab"
                  type="button"
                  role="tab"
                  aria-selected={videoMode === 'reference'}
                  aria-controls="reference-mode-panel"
                  disabled={isGenerationPending}
                  tabIndex={videoMode === 'reference' ? 0 : -1}
                  onClick={() => setVideoMode('reference')}
                >
                  图片生视频
                </button>
                <button
                  ref={audioModeTabRef}
                  id="audio-mode-tab"
                  type="button"
                  role="tab"
                  aria-selected={videoMode === 'audio'}
                  aria-controls="audio-mode-panel"
                  disabled={isGenerationPending}
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
                  avatar={avatar}
                  mode="text"
                  modelDirectory={modelDirectory}
                  active={mode === 'video' && videoMode === 'text'}
                  busy={busy}
                  isGenerationPending={isGenerationPending}
                  generationPendingRef={generationPendingRef}
                  onGenerationPendingChange={onGenerationPendingChange}
                  onJobStarted={onJobStarted}
                />
              </div>
              <div
                id="reference-mode-panel"
                role="tabpanel"
                aria-labelledby="reference-mode-tab"
                hidden={videoMode !== 'reference'}
              >
                <TextToVideoForm
                  avatar={avatar}
                  mode="reference"
                  modelDirectory={modelDirectory}
                  active={mode === 'video' && videoMode === 'reference'}
                  busy={busy}
                  isGenerationPending={isGenerationPending}
                  generationPendingRef={generationPendingRef}
                  onGenerationPendingChange={onGenerationPendingChange}
                  onJobStarted={onJobStarted}
                />
              </div>
              <div
                id="audio-mode-panel"
                role="tabpanel"
                aria-labelledby="audio-mode-tab"
                hidden={videoMode !== 'audio'}
              >
                {avatar === null ? (
                  <section className="empty-state">
                    <UserPlus size={32} aria-hidden="true" />
                    <h2>还没有数字模特</h2>
                    <p>先添加一张人物照片，再开始制作音频数字人视频。</p>
                    <button className="button button-primary" type="button" onClick={onCreateAvatar}>
                      新建数字模特
                    </button>
                  </section>
                ) : (
                  <AudioDigitalHumanForm
                    avatarId={avatar.id}
                    modelDirectory={modelDirectory}
                    active={mode === 'video' && videoMode === 'audio'}
                    pageActive={pageActive && mode === 'video'}
                    busy={busy}
                    isGenerationPending={isGenerationPending}
                    generationPendingRef={generationPendingRef}
                    onGenerationPendingChange={onGenerationPendingChange}
                    onJobStarted={onJobStarted}
                    intent={intent}
                  />
                )}
              </div>
            </section>
          </div>
        )}
      </section>
    </div>
  );
}
