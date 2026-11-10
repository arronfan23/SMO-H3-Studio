import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Sparkles, Video } from 'lucide-react';
import { SKILL_NAMES, type SkillName } from '../shared/skills';
import {
  DEFAULT_GENERATION_OPTIONS,
  buildHardwareProfile,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { GenerationOptions } from './GenerationOptions';
import type { StudioIntent } from './App';
import { AudioInput } from './AudioInput';
import { AudioRecorder } from './AudioRecorder';
import { JobStatus } from './JobStatus';
import { StepNumberField } from './StepNumberField';
import { AUTO_SKILL_OPTION, SKILL_OPTIONS } from './skill-options';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage } from './ui';

type PromptTab = 'original' | 'polished';

interface PolishContext {
  originalText: string;
  audioPath: string;
  trimStart: number;
  duration: number | '';
  skill: 'auto' | SkillName;
}

interface PendingPolish {
  id: number;
  context: PolishContext;
}

function isHundredth(value: number): boolean {
  const hundredths = value * 100;
  return Math.abs(hundredths - Math.round(hundredths)) <= 1e-7;
}

export function AudioDigitalHumanForm({
  avatarId,
  modelDirectory,
  active = true,
  pageActive = true,
  busy = false,
  onJobStarted,
  intent = null,
}: {
  avatarId: string;
  modelDirectory: string;
  active?: boolean;
  pageActive?: boolean;
  busy?: boolean;
  onJobStarted?: () => Promise<boolean | void>;
  intent?: StudioIntent | null;
}) {
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioSeconds, setAudioSeconds] = useState<number | null>(null);
  const [audioRevision, setAudioRevision] = useState(0);
  const [audioIntentToken, setAudioIntentToken] = useState<number | null>(null);
  const [originalText, setOriginalText] = useState('');
  const [polishedText, setPolishedText] = useState('');
  const [activeTab, setActiveTab] = useState<PromptTab>('original');
  const [skill, setSkill] = useState<'auto' | SkillName>('h3-prompt-writing');
  const [trimStart, setTrimStart] = useState(0);
  const [duration, setDuration] = useState<number | ''>(0);
  const [seed, setSeed] = useState(42);
  const [steps, setSteps] = useState(6);
  const [options, setOptions] = useState<GenerationOptionsValue>(
    DEFAULT_GENERATION_OPTIONS,
  );
  const [polishing, setPolishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { url: audioUrl, error: mediaError } = useMediaUrl(audioPath, audioRevision);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioRevisionRef = useRef(0);
  const audioIntentTokenRef = useRef<number | null>(null);
  const handledIntentTokenRef = useRef<number | null>(null);
  const originalTabRef = useRef<HTMLButtonElement | null>(null);
  const polishedTabRef = useRef<HTMLButtonElement | null>(null);
  const operationRef = useRef<'polish' | 'generation' | null>(null);
  const polishRequestIdRef = useRef(0);
  const pendingPolishRef = useRef<PendingPolish | null>(null);
  const currentPolishContextRef = useRef<PolishContext | null>(null);
  currentPolishContextRef.current =
    audioPath === null ? null : { originalText, audioPath, trimStart, duration, skill };

  // Pause any playing preview when the panel or the whole studio page is hidden.
  useEffect(() => {
    if (!active || !pageActive) {
      audioRef.current?.pause();
    }
  }, [active, pageActive]);

  const remainingSeconds =
    audioSeconds !== null && Number.isFinite(trimStart) && trimStart >= 0
      ? audioSeconds - trimStart
      : null;

  const skillDescription =
    skill === 'auto'
      ? AUTO_SKILL_OPTION.description
      : SKILL_OPTIONS[skill].description;

  const handleAudioSelected = (selected: string | null, intentToken: number | null = null): void => {
    // The same path may be chosen again; invalidate its old element and events.
    audioRevisionRef.current += 1;
    audioIntentTokenRef.current = intentToken;
    setAudioRevision(audioRevisionRef.current);
    setAudioIntentToken(intentToken);
    polishRequestIdRef.current += 1;
    pendingPolishRef.current = null;
    if (operationRef.current === 'polish') {
      operationRef.current = null;
    }
    setPolishing(false);
    setAudioPath(selected);
    setAudioSeconds(null);
    setDuration(0);
    setTrimStart(0);
  };

  useEffect(() => {
    if (intent === null) {
      return;
    }
    const handledToken = handledIntentTokenRef.current;
    if (handledToken !== null && intent.token <= handledToken) {
      return;
    }
    handledIntentTokenRef.current = intent.token;
    if (busy || submitting || recordingBusy || operationRef.current === 'generation') {
      setError('生成任务进行中，完成后才能更换语音作品。');
      return;
    }
    setError(null);
    handleAudioSelected(intent.audioPath, intent.token);
  }, [busy, intent, recordingBusy, submitting]);

  const resolveValidClip = (text: string): { audioPath: string; duration: number } | null => {
    if (audioPath === null || audioSeconds === null) {
      setError('请选择音频并等待时长读取完成。');
      return null;
    }
    if (text.length === 0) {
      setError('请填写动作/画面提示词。');
      return null;
    }
    if (!Number.isFinite(trimStart) || trimStart < 0) {
      setError('起始截取时间必须是非负数字。');
      return null;
    }
    if (trimStart >= audioSeconds) {
      setError('截取范围不能超出实际音频时长。');
      return null;
    }
    if (!isHundredth(trimStart)) {
      setError('起始截取时间必须按 0.01 秒步进。');
      return null;
    }
    const resolvedDuration = duration === '' ? audioSeconds - trimStart : duration;
    if (
      !Number.isFinite(resolvedDuration) ||
      resolvedDuration <= 0 ||
      trimStart + resolvedDuration > audioSeconds + 0.001
    ) {
      setError('截取范围不能超出实际音频时长。');
      return null;
    }
    if (resolvedDuration < 0.01 || (duration !== '' && !isHundredth(resolvedDuration))) {
      setError('截取时长必须至少为 0.01 秒，并按 0.01 秒步进。');
      return null;
    }
    return { audioPath, duration: resolvedDuration };
  };

  const isCurrentPolish = (request: PendingPolish): boolean => {
    const current = currentPolishContextRef.current;
    return (
      pendingPolishRef.current?.id === request.id &&
      current !== null &&
      current.originalText === request.context.originalText &&
      current.audioPath === request.context.audioPath &&
      Object.is(current.trimStart, request.context.trimStart) &&
      Object.is(current.duration, request.context.duration) &&
      current.skill === request.context.skill
    );
  };

  const polish = async (): Promise<void> => {
    if (operationRef.current !== null) {
      return;
    }
    const text = originalText.trim();
    const clip = resolveValidClip(text);
    if (clip === null) {
      return;
    }

    const request: PendingPolish = {
      id: ++polishRequestIdRef.current,
      context: {
        originalText,
        audioPath: clip.audioPath,
        trimStart,
        duration,
        skill,
      },
    };
    pendingPolishRef.current = request;
    operationRef.current = 'polish';
    setPolishing(true);
    setError(null);
    try {
      const result = await window.smo.llm.polish({
        text,
        duration: clip.duration,
        imageCount: 1,
        mode: 'ref2va',
        referenceLabels: ['<Picture 1>', '<Audio 1>'],
        skill,
      });
      if (!isCurrentPolish(request)) {
        return;
      }
      setPolishedText(result.text);
      setActiveTab('polished');
    } catch (polishError) {
      if (!isCurrentPolish(request)) {
        return;
      }
      setActiveTab('original');
      setError(errorMessage(polishError));
    } finally {
      if (pendingPolishRef.current?.id === request.id) {
        pendingPolishRef.current = null;
        if (operationRef.current === 'polish') {
          operationRef.current = null;
        }
        setPolishing(false);
      }
    }
  };

  const startGeneration = async (): Promise<void> => {
    if (operationRef.current !== null) {
      return;
    }
    const prompt = (activeTab === 'polished' ? polishedText : originalText).trim();
    const clip = resolveValidClip(prompt);
    if (clip === null) {
      return;
    }
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) {
      setError('采样步数必须是 1–100 之间的整数。');
      return;
    }
    if (!Number.isInteger(seed) || seed < 0) {
      setError('随机种子必须是非负整数。');
      return;
    }

    operationRef.current = 'generation';
    setSubmitting(true);
    setError(null);
    setJobId(null);
    try {
      await window.smo.hardware.apply({
        mode: 'audio',
        profile: buildHardwareProfile(options),
        confirmed: true,
        modelDirectory,
      });
      const result = await window.smo.jobs.start({
        mode: 'audio',
        avatarId,
        prompt,
        audioPath: clip.audioPath,
        trimStart,
        duration: clip.duration,
        seed,
        steps,
      });
      setJobId(result.id);
      void onJobStarted?.();
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      operationRef.current = null;
      setSubmitting(false);
    }
  };

  const focusPromptTab = (tab: PromptTab): void => {
    setActiveTab(tab);
    (tab === 'original' ? originalTabRef : polishedTabRef).current?.focus();
  };

  const handlePromptTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const availableTabs: PromptTab[] =
      polishedText.length > 0 ? ['original', 'polished'] : ['original'];
    const currentTab: PromptTab =
      event.target === polishedTabRef.current ? 'polished' : 'original';
    const currentIndex = availableTabs.indexOf(currentTab);
    if (currentIndex < 0) {
      return;
    }

    let nextIndex: number;
    switch (event.key) {
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length;
        break;
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % availableTabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = availableTabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusPromptTab(availableTabs[nextIndex]);
  };

  return (
    <form
      className="generation-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void startGeneration();
      }}
    >
      <AudioInput
        key={audioIntentToken ?? 'manual'}
        path={audioPath}
        disabled={submitting || busy || recordingBusy}
        onSelected={handleAudioSelected}
        onError={setError}
      />
      <AudioRecorder
        active={active && pageActive}
        disabled={submitting || busy}
        hasAudio={audioPath !== null}
        onBusyChange={setRecordingBusy}
        onRecorded={handleAudioSelected}
        onError={setError}
      />
      {audioPath && audioSeconds !== null && (
        <p className="audio-duration">音频时长：{audioSeconds.toFixed(2)} 秒</p>
      )}
      {audioUrl && (
        <audio
          key={`${audioPath}:${audioRevision}`}
          ref={audioRef}
          className="audio-preview"
          aria-label="所选音频"
          controls
          preload="metadata"
          src={audioUrl}
          onLoadedMetadata={(event) => {
            if (
              audioRevision !== audioRevisionRef.current ||
              audioIntentToken !== audioIntentTokenRef.current
            ) {
              return;
            }
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) {
              setAudioSeconds(seconds);
              setDuration(seconds);
            } else {
              setError('无法读取有效的音频时长。');
            }
          }}
        />
      )}
      {mediaError && <p className="form-error" role="alert">{mediaError}</p>}

      <div className="field">
        <label htmlFor="audio-skill">视频风格（Skill）</label>
        <select
          id="audio-skill"
          aria-describedby="audio-skill-description"
          value={skill}
          onChange={(event) => setSkill(event.target.value as 'auto' | SkillName)}
        >
          <option value="auto">{AUTO_SKILL_OPTION.title}</option>
          {SKILL_NAMES.map((name) => (
            <option key={name} value={name}>{SKILL_OPTIONS[name].title}</option>
          ))}
        </select>
        <p id="audio-skill-description" className="skill-description">{skillDescription}</p>
      </div>

      <GenerationOptions
        idPrefix="audio"
        value={options}
        onChange={setOptions}
        disabled={submitting}
      />

      <div className="prompt-editor">
        <div
          className="tab-list"
          role="tablist"
          aria-label="音频提示词版本"
          onKeyDown={handlePromptTabKeyDown}
        >
          <button
            ref={originalTabRef}
            id="audio-original-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === 'original'}
            aria-controls="audio-original-panel"
            tabIndex={activeTab === 'original' ? 0 : -1}
            onClick={() => setActiveTab('original')}
          >
            原文
          </button>
          <button
            ref={polishedTabRef}
            id="audio-polished-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === 'polished'}
            aria-controls="audio-polished-panel"
            tabIndex={activeTab === 'polished' ? 0 : -1}
            disabled={polishedText.length === 0}
            onClick={() => setActiveTab('polished')}
          >
            润色结果
          </button>
        </div>
        {activeTab === 'original' ? (
          <div id="audio-original-panel" role="tabpanel" aria-labelledby="audio-original-tab">
            <label className="sr-only" htmlFor="audio-prompt">动作/画面提示词</label>
            <textarea
              id="audio-prompt"
              rows={7}
              value={originalText}
              onChange={(event) => setOriginalText(event.target.value)}
              placeholder="描述说话时的表情、动作和镜头"
            />
          </div>
        ) : (
          <div id="audio-polished-panel" role="tabpanel" aria-labelledby="audio-polished-tab">
            <label className="sr-only" htmlFor="audio-polished-text">润色结果</label>
            <textarea
              id="audio-polished-text"
              rows={7}
              value={polishedText}
              onChange={(event) => {
                const value = event.target.value;
                setPolishedText(value);
                if (value.length === 0) {
                  focusPromptTab('original');
                }
              }}
            />
          </div>
        )}
      </div>
      <div className="form-row form-row-three">
        <div className="field">
          <label htmlFor="audio-trim">起始截取（秒）</label>
          <input
            id="audio-trim"
            type="number"
            min={0}
            step={0.01}
            value={Number.isNaN(trimStart) ? '' : trimStart}
            onChange={(event) => setTrimStart(event.target.valueAsNumber)}
          />
        </div>
        <div className="field">
          <label htmlFor="audio-duration">截取时长（秒）</label>
          <input
            id="audio-duration"
            type="number"
            min={0.01}
            step={0.01}
            value={duration}
            aria-describedby={
              duration === '' && audioSeconds !== null ? 'audio-duration-hint' : undefined
            }
            onChange={(event) =>
              setDuration(event.target.value === '' ? '' : event.target.valueAsNumber)
            }
          />
          {duration === '' && audioSeconds !== null && (
            <p id="audio-duration-hint" className="skill-description">
              {remainingSeconds !== null &&
              Number.isFinite(remainingSeconds) &&
              remainingSeconds > 0
                ? `留空自动：使用剩余 ${remainingSeconds.toFixed(2)} 秒`
                : '留空自动：使用剩余音频时长'}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="audio-seed">随机种子</label>
          <input
            id="audio-seed"
            type="number"
            min={0}
            step={1}
            value={seed}
            onChange={(event) => setSeed(event.target.valueAsNumber)}
          />
        </div>
      </div>
      <StepNumberField
        id="audio-steps"
        label="采样步数"
        value={steps}
        recommended={6}
        min={1}
        max={100}
        disabled={submitting || busy || recordingBusy}
        onChange={setSteps}
      />
      <button className="button button-secondary" type="button" onClick={() => void polish()} disabled={polishing || submitting || busy || recordingBusy}>
        <Sparkles size={16} aria-hidden="true" />
        {polishing ? '正在润色…' : 'AI 润色'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={polishing || submitting || busy || recordingBusy}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} allowCancel />
    </form>
  );
}
