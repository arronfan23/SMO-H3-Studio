import { useRef, useState } from 'react';
import { Sparkles, UserPlus, Video } from 'lucide-react';
import { SKILL_NAMES, type SkillName } from '../shared/skills';
import type { Avatar } from '../shared/types';
import { AUTO_SKILL_OPTION, SKILL_OPTIONS } from './skill-options';
import {
  DEFAULT_GENERATION_OPTIONS,
  buildHardwareProfile,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { GenerationOptions } from './GenerationOptions';
import { JobStatus } from './JobStatus';
import { ReferenceImagePicker } from './ReferenceImagePicker';
import { StepNumberField } from './StepNumberField';
import { errorMessage } from './ui';
import { estimateNarrationDuration } from '../shared/duration';

type PromptTab = 'original' | 'polished';
type TextToVideoMode = 'text' | 'reference';

function isValidTextDuration(value: number, explicit: boolean): boolean {
  return (
    Number.isFinite(value) &&
    value >= 4 &&
    value <= 15 &&
    (!explicit || Number.isInteger(value))
  );
}

export function TextToVideoForm({
  avatar,
  mode,
  modelDirectory,
  active = true,
  busy = false,
  isGenerationPending = false,
  generationPendingRef,
  onGenerationPendingChange,
  onJobStarted,
}: {
  avatar: Avatar | null;
  mode: TextToVideoMode;
  modelDirectory: string;
  active?: boolean;
  busy?: boolean;
  isGenerationPending?: boolean;
  generationPendingRef?: { current: boolean };
  onGenerationPendingChange?: (pending: boolean) => void;
  onJobStarted?: () => Promise<boolean | void>;
}) {
  const idPrefix = mode === 'reference' ? 'reference' : 'text';
  const promptIdPrefix = mode === 'reference' ? 'reference-' : '';
  const originalTabId = `${promptIdPrefix}original-tab`;
  const originalPanelId = `${promptIdPrefix}original-panel`;
  const originalTextId = `${promptIdPrefix}original-text`;
  const polishedTabId = `${promptIdPrefix}polished-tab`;
  const polishedPanelId = `${promptIdPrefix}polished-panel`;
  const polishedTextId = `${promptIdPrefix}polished-text`;
  const [originalText, setOriginalText] = useState('');
  const [polishedText, setPolishedText] = useState('');
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<PromptTab>('original');
  const [skill, setSkill] = useState<'auto' | SkillName>('h3-prompt-writing');
  const [duration, setDuration] = useState<number | ''>(8);
  const [polishedAutoDuration, setPolishedAutoDuration] = useState<number | null>(null);
  const [seed, setSeed] = useState(42);
  const [steps, setSteps] = useState(8);
  const [options, setOptions] = useState<GenerationOptionsValue>(
    DEFAULT_GENERATION_OPTIONS,
  );
  const [polishing, setPolishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const operationRef = useRef<'polish' | 'generation' | null>(null);
  const polishRevisionRef = useRef(0);

  const skillDescription =
    skill === 'auto'
      ? AUTO_SKILL_OPTION.description
      : SKILL_OPTIONS[skill].description;

  const resolveDuration = (forPolishedPrompt: boolean): number => {
    if (duration !== '') {
      return duration;
    }
    if (forPolishedPrompt && polishedAutoDuration !== null) {
      return polishedAutoDuration;
    }
    return estimateNarrationDuration(originalText);
  };

  const requireReferenceImages = (action: '润色' | '生成'): boolean => {
    if (mode !== 'reference' || referenceImagePaths.length > 0) {
      return true;
    }
    setError(`请至少添加 1 张参考图后再${action}。`);
    return false;
  };

  const changeReferenceImages = (paths: string[]): void => {
    polishRevisionRef.current += 1;
    setPolishedText('');
    setPolishedAutoDuration(null);
    setActiveTab('original');
    setReferenceImagePaths(paths);
    setError(null);
  };

  const addCurrentAvatar = (): void => {
    if (
      avatar === null ||
      operationRef.current !== null ||
      busy ||
      isGenerationPending ||
      generationPendingRef?.current === true
    ) {
      return;
    }
    if (referenceImagePaths.length >= 9) {
      setError('最多 9 张参考图，无法添加当前模特。');
      return;
    }
    if (referenceImagePaths.includes(avatar.photoPath)) {
      setError('当前模特已在参考图中，未重复添加。');
      return;
    }
    changeReferenceImages([...referenceImagePaths, avatar.photoPath]);
  };

  const polish = async (): Promise<void> => {
    if (operationRef.current !== null) {
      return;
    }
    if (!requireReferenceImages('润色')) {
      return;
    }
    const text = originalText.trim();
    if (text.length === 0) {
      setError('请先填写原始文字。');
      return;
    }
    const resolvedDuration = resolveDuration(false);
    if (!isValidTextDuration(resolvedDuration, duration !== '')) {
      setError('视频时长必须在 4–15 秒之间。');
      return;
    }
    const polishRevision = polishRevisionRef.current;
    operationRef.current = 'polish';
    setPolishing(true);
    setError(null);
    try {
      const imageCount = mode === 'reference' ? referenceImagePaths.length : 0;
      const result = await window.smo.llm.polish({
        text,
        duration: resolvedDuration,
        imageCount,
        mode: mode === 'reference' ? 'ref2va' : 't2va',
        referenceLabels: Array.from(
          { length: imageCount },
          (_, index) => `<Picture ${index + 1}>`,
        ),
        skill,
      });
      if (polishRevision !== polishRevisionRef.current) {
        return;
      }
      setPolishedText(result.text);
      setPolishedAutoDuration(duration === '' ? resolvedDuration : null);
      setActiveTab('polished');
    } catch (polishError) {
      if (polishRevision !== polishRevisionRef.current) {
        return;
      }
      setActiveTab('original');
      setError(errorMessage(polishError));
    } finally {
      if (operationRef.current === 'polish') {
        operationRef.current = null;
      }
      setPolishing(false);
    }
  };

  const startGeneration = async (): Promise<void> => {
    if (
      operationRef.current !== null ||
      isGenerationPending ||
      generationPendingRef?.current === true
    ) {
      return;
    }
    if (!requireReferenceImages('生成')) {
      return;
    }
    const prompt = (activeTab === 'polished' ? polishedText : originalText).trim();
    if (prompt.length === 0) {
      setError('请填写用于生成的文字。');
      return;
    }
    const resolvedDuration = resolveDuration(activeTab === 'polished');
    if (!isValidTextDuration(resolvedDuration, duration !== '')) {
      setError('视频时长必须在 4–15 秒之间。');
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
    onGenerationPendingChange?.(true);
    setSubmitting(true);
    setError(null);
    setJobId(null);
    try {
      await window.smo.hardware.apply({
        mode: 'text',
        profile: buildHardwareProfile(options),
        confirmed: true,
        modelDirectory,
      });
      const result = await window.smo.jobs.start({
        mode: 'text',
        avatarId: mode === 'reference' ? avatar?.id ?? null : null,
        prompt,
        duration: resolvedDuration,
        seed,
        steps,
        referenceImagePaths: mode === 'reference' ? [...referenceImagePaths] : [],
      });
      setJobId(result.id);
      void onJobStarted?.();
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      if (operationRef.current === 'generation') {
        operationRef.current = null;
      }
      onGenerationPendingChange?.(false);
      setSubmitting(false);
    }
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
      {mode === 'reference' && (
        <div className="field">
          {/* Late authorization must still call onChange so it can invalidate this polish. */}
          <fieldset
            className="reference-image-fieldset"
            disabled={polishing || submitting || busy || isGenerationPending}
            onDropCapture={(event) => {
              if (polishing) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <ReferenceImagePicker
              paths={referenceImagePaths}
              max={9}
              disabled={submitting || busy || isGenerationPending}
              onChange={changeReferenceImages}
              onError={setError}
            />
          </fieldset>
          {avatar !== null && (
            <button
              className="button button-secondary"
              type="button"
              disabled={polishing || submitting || busy || isGenerationPending}
              onClick={addCurrentAvatar}
            >
              <UserPlus size={16} aria-hidden="true" />
              使用当前模特
            </button>
          )}
        </div>
      )}

      <div className="field">
        <label htmlFor={`${idPrefix}-skill`}>视频风格（Skill）</label>
        <select
          id={`${idPrefix}-skill`}
          aria-describedby={`${idPrefix}-skill-description`}
          value={skill}
          onChange={(event) => setSkill(event.target.value as 'auto' | SkillName)}
        >
          <option value="auto">{AUTO_SKILL_OPTION.title}</option>
          {SKILL_NAMES.map((name) => (
            <option key={name} value={name}>{SKILL_OPTIONS[name].title}</option>
          ))}
        </select>
        <p id={`${idPrefix}-skill-description`} className="skill-description">{skillDescription}</p>
      </div>

      <GenerationOptions
        idPrefix={idPrefix}
        value={options}
        onChange={setOptions}
        disabled={submitting}
      />

      <div className="form-row">
        <div className="field">
          <label htmlFor={`${idPrefix}-duration`}>视频时长（秒）</label>
          <input
            id={`${idPrefix}-duration`}
            type="number"
            min={4}
            max={15}
            step={1}
            value={duration}
            aria-describedby={duration === '' ? `${idPrefix}-duration-hint` : undefined}
            onChange={(event) =>
              setDuration(event.target.value === '' ? '' : event.target.valueAsNumber)
            }
          />
          {duration === '' && (
            <p id={`${idPrefix}-duration-hint`} className="skill-description">
              留空自动：约 {resolveDuration(activeTab === 'polished')} 秒（含 2 秒收尾）
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-seed`}>随机种子</label>
          <input
            id={`${idPrefix}-seed`}
            type="number"
            min={0}
            step={1}
            value={seed}
            onChange={(event) => setSeed(event.target.valueAsNumber)}
          />
        </div>
      </div>

      <StepNumberField
        id={`${idPrefix}-steps`}
        label="采样步数"
        value={steps}
        recommended={8}
        min={1}
        max={100}
        disabled={submitting || busy || isGenerationPending}
        onChange={setSteps}
      />

      <div className="prompt-editor">
        <div className="tab-list" role="tablist" aria-label="提示词版本">
          <button
            id={originalTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === 'original'}
            aria-controls={originalPanelId}
            onClick={() => setActiveTab('original')}
          >
            原文
          </button>
          <button
            id={polishedTabId}
            type="button"
            role="tab"
            aria-selected={activeTab === 'polished'}
            aria-controls={polishedPanelId}
            disabled={polishedText.length === 0}
            onClick={() => setActiveTab('polished')}
          >
            润色结果
          </button>
        </div>
        {activeTab === 'original' ? (
          <div id={originalPanelId} role="tabpanel" aria-labelledby={originalTabId}>
            <label className="sr-only" htmlFor={originalTextId}>原始文字</label>
            <textarea
              id={originalTextId}
              rows={7}
              value={originalText}
              onChange={(event) => setOriginalText(event.target.value)}
              placeholder="描述人物动作、镜头和画面氛围"
            />
          </div>
        ) : (
          <div id={polishedPanelId} role="tabpanel" aria-labelledby={polishedTabId}>
            <label className="sr-only" htmlFor={polishedTextId}>润色结果</label>
            <textarea
              id={polishedTextId}
              rows={7}
              value={polishedText}
              onChange={(event) => setPolishedText(event.target.value)}
            />
          </div>
        )}
      </div>

      <button className="button button-secondary" type="button" onClick={() => void polish()} disabled={polishing || submitting || busy || isGenerationPending}>
        <Sparkles size={16} aria-hidden="true" />
        {polishing ? '正在润色…' : 'AI 润色'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={polishing || submitting || busy || isGenerationPending}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} />
    </form>
  );
}
