import { useRef, useState } from 'react';
import { Sparkles, Video } from 'lucide-react';
import { SKILL_NAMES, type SkillName } from '../shared/skills';
import { AUTO_SKILL_OPTION, SKILL_OPTIONS } from './skill-options';
import {
  DEFAULT_GENERATION_OPTIONS,
  buildHardwareProfile,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { GenerationOptions } from './GenerationOptions';
import { JobStatus } from './JobStatus';
import { StepNumberField } from './StepNumberField';
import { errorMessage } from './ui';
import { estimateNarrationDuration } from '../shared/duration';

type PromptTab = 'original' | 'polished';

function isValidTextDuration(value: number, explicit: boolean): boolean {
  return (
    Number.isFinite(value) &&
    value >= 4 &&
    value <= 15 &&
    (!explicit || Number.isInteger(value))
  );
}

export function TextToVideoForm({
  avatarId,
  modelDirectory,
  active = true,
  busy = false,
  onJobStarted,
}: {
  avatarId: string;
  modelDirectory: string;
  active?: boolean;
  busy?: boolean;
  onJobStarted?: () => Promise<boolean | void>;
}) {
  const [originalText, setOriginalText] = useState('');
  const [polishedText, setPolishedText] = useState('');
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

  const polish = async (): Promise<void> => {
    if (operationRef.current !== null) {
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
    operationRef.current = 'polish';
    setPolishing(true);
    setError(null);
    try {
      const result = await window.smo.llm.polish({
        text,
        duration: resolvedDuration,
        imageCount: 1,
        mode: 'ref2va',
        referenceLabels: ['<Picture 1>'],
        skill,
      });
      setPolishedText(result.text);
      setPolishedAutoDuration(duration === '' ? resolvedDuration : null);
      setActiveTab('polished');
    } catch (polishError) {
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
    if (operationRef.current !== null) {
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
        avatarId,
        prompt,
        duration: resolvedDuration,
        seed,
        steps,
      });
      setJobId(result.id);
      void onJobStarted?.();
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      if (operationRef.current === 'generation') {
        operationRef.current = null;
      }
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
      <div className="field">
        <label htmlFor="text-skill">视频风格（Skill）</label>
        <select
          id="text-skill"
          aria-describedby="text-skill-description"
          value={skill}
          onChange={(event) => setSkill(event.target.value as 'auto' | SkillName)}
        >
          <option value="auto">{AUTO_SKILL_OPTION.title}</option>
          {SKILL_NAMES.map((name) => (
            <option key={name} value={name}>{SKILL_OPTIONS[name].title}</option>
          ))}
        </select>
        <p id="text-skill-description" className="skill-description">{skillDescription}</p>
      </div>

      <GenerationOptions
        idPrefix="text"
        value={options}
        onChange={setOptions}
        disabled={submitting}
      />

      <div className="form-row">
        <div className="field">
          <label htmlFor="text-duration">视频时长（秒）</label>
          <input
            id="text-duration"
            type="number"
            min={4}
            max={15}
            step={1}
            value={duration}
            aria-describedby={duration === '' ? 'text-duration-hint' : undefined}
            onChange={(event) =>
              setDuration(event.target.value === '' ? '' : event.target.valueAsNumber)
            }
          />
          {duration === '' && (
            <p id="text-duration-hint" className="skill-description">
              留空自动：约 {resolveDuration(activeTab === 'polished')} 秒（含 2 秒收尾）
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="text-seed">随机种子</label>
          <input
            id="text-seed"
            type="number"
            min={0}
            step={1}
            value={seed}
            onChange={(event) => setSeed(event.target.valueAsNumber)}
          />
        </div>
      </div>

      <StepNumberField
        id="text-steps"
        label="采样步数"
        value={steps}
        recommended={8}
        min={1}
        max={100}
        disabled={submitting || busy}
        onChange={setSteps}
      />

      <div className="prompt-editor">
        <div className="tab-list" role="tablist" aria-label="提示词版本">
          <button
            id="original-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === 'original'}
            aria-controls="original-panel"
            onClick={() => setActiveTab('original')}
          >
            原文
          </button>
          <button
            id="polished-tab"
            type="button"
            role="tab"
            aria-selected={activeTab === 'polished'}
            aria-controls="polished-panel"
            disabled={polishedText.length === 0}
            onClick={() => setActiveTab('polished')}
          >
            润色结果
          </button>
        </div>
        {activeTab === 'original' ? (
          <div id="original-panel" role="tabpanel" aria-labelledby="original-tab">
            <label className="sr-only" htmlFor="original-text">原始文字</label>
            <textarea
              id="original-text"
              rows={7}
              value={originalText}
              onChange={(event) => setOriginalText(event.target.value)}
              placeholder="描述人物动作、镜头和画面氛围"
            />
          </div>
        ) : (
          <div id="polished-panel" role="tabpanel" aria-labelledby="polished-tab">
            <label className="sr-only" htmlFor="polished-text">润色结果</label>
            <textarea
              id="polished-text"
              rows={7}
              value={polishedText}
              onChange={(event) => setPolishedText(event.target.value)}
            />
          </div>
        )}
      </div>

      <button className="button button-secondary" type="button" onClick={() => void polish()} disabled={polishing || submitting || busy}>
        <Sparkles size={16} aria-hidden="true" />
        {polishing ? '正在润色…' : 'AI 润色'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={polishing || submitting || busy}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} />
    </form>
  );
}
