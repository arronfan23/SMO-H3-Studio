import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { FileAudio, Sparkles, Video } from 'lucide-react';
import { SKILL_NAMES, type SkillName } from '../shared/skills';
import {
  DEFAULT_GENERATION_OPTIONS,
  buildHardwareProfile,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { GenerationOptions } from './GenerationOptions';
import { JobStatus } from './JobStatus';
import { AUTO_SKILL_OPTION, SKILL_OPTIONS } from './skill-options';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage, fileName } from './ui';

type PromptTab = 'original' | 'polished';

interface PolishContext {
  originalText: string;
  audioPath: string;
  trimStart: number;
  duration: number | '';
}

interface PendingPolish {
  id: number;
  context: PolishContext;
}

export function AudioDigitalHumanForm({
  avatarId,
  modelDirectory,
  active = true,
  pageActive = true,
}: {
  avatarId: string;
  modelDirectory: string;
  active?: boolean;
  pageActive?: boolean;
}) {
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioSeconds, setAudioSeconds] = useState<number | null>(null);
  const [originalText, setOriginalText] = useState('');
  const [polishedText, setPolishedText] = useState('');
  const [activeTab, setActiveTab] = useState<PromptTab>('original');
  const [skill, setSkill] = useState<'auto' | SkillName>('h3-prompt-writing');
  const [trimStart, setTrimStart] = useState(0);
  const [duration, setDuration] = useState<number | ''>(0);
  const [seed, setSeed] = useState(42);
  const [options, setOptions] = useState<GenerationOptionsValue>(
    DEFAULT_GENERATION_OPTIONS,
  );
  const [selecting, setSelecting] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { url: audioUrl, error: mediaError } = useMediaUrl(audioPath);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const originalTabRef = useRef<HTMLButtonElement | null>(null);
  const polishedTabRef = useRef<HTMLButtonElement | null>(null);
  const operationRef = useRef<'polish' | 'generation' | null>(null);
  const polishRequestIdRef = useRef(0);
  const pendingPolishRef = useRef<PendingPolish | null>(null);
  const currentPolishContextRef = useRef<PolishContext | null>(null);
  currentPolishContextRef.current =
    audioPath === null ? null : { originalText, audioPath, trimStart, duration };

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

  const selectAudio = async (): Promise<void> => {
    setSelecting(true);
    setError(null);
    try {
      const selected = await window.smo.files.selectAudio();
      if (selected !== null) {
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
      }
    } catch (selectError) {
      setError(errorMessage(selectError));
    } finally {
      setSelecting(false);
    }
  };

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
    const resolvedDuration = duration === '' ? audioSeconds - trimStart : duration;
    if (
      !Number.isFinite(resolvedDuration) ||
      resolvedDuration <= 0 ||
      trimStart + resolvedDuration > audioSeconds + 0.001
    ) {
      setError('截取范围不能超出实际音频时长。');
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
      Object.is(current.duration, request.context.duration)
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
      });
      setJobId(result.id);
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
      onSubmit={(event) => {
        event.preventDefault();
        void startGeneration();
      }}
    >
      <button className="button button-secondary" type="button" onClick={() => void selectAudio()} disabled={selecting}>
        <FileAudio size={16} aria-hidden="true" />
        {selecting ? '正在选择…' : '选择音频'}
      </button>
      {audioPath && (
        <div className="audio-file">
          <strong>{fileName(audioPath)}</strong>
          {audioSeconds !== null && <span>音频时长：{audioSeconds.toFixed(2)} 秒</span>}
        </div>
      )}
      {audioUrl && (
        <audio
          ref={audioRef}
          className="audio-preview"
          aria-label="所选音频"
          controls
          preload="metadata"
          src={audioUrl}
          onLoadedMetadata={(event) => {
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
      <button className="button button-secondary" type="button" onClick={() => void polish()} disabled={polishing || submitting}>
        <Sparkles size={16} aria-hidden="true" />
        {polishing ? '正在润色…' : 'AI 润色'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={polishing || submitting}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} allowCancel />
    </form>
  );
}
