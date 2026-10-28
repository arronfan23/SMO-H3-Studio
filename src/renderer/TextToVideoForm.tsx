import { useState } from 'react';
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
import { errorMessage } from './ui';

type PromptTab = 'original' | 'polished';

export function TextToVideoForm({
  avatarId,
  modelDirectory,
  active = true,
}: {
  avatarId: string;
  modelDirectory: string;
  active?: boolean;
}) {
  const [originalText, setOriginalText] = useState('');
  const [polishedText, setPolishedText] = useState('');
  const [activeTab, setActiveTab] = useState<PromptTab>('original');
  const [skill, setSkill] = useState<'auto' | SkillName>('auto');
  const [duration, setDuration] = useState(8);
  const [seed, setSeed] = useState(42);
  const [options, setOptions] = useState<GenerationOptionsValue>(
    DEFAULT_GENERATION_OPTIONS,
  );
  const [polishing, setPolishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const skillDescription =
    skill === 'auto'
      ? AUTO_SKILL_OPTION.description
      : SKILL_OPTIONS[skill].description;

  const polish = async (): Promise<void> => {
    const text = originalText.trim();
    if (text.length === 0) {
      setError('请先填写原始文字。');
      return;
    }
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
      setError('视频时长必须在 4–15 秒之间。');
      return;
    }
    setPolishing(true);
    setError(null);
    try {
      const result = await window.smo.llm.polish({
        text,
        duration,
        imageCount: 1,
        mode: 'ref2va',
        referenceLabels: ['<Picture 1>'],
        skill,
      });
      setPolishedText(result.text);
      setActiveTab('polished');
    } catch (polishError) {
      setActiveTab('original');
      setError(errorMessage(polishError));
    } finally {
      setPolishing(false);
    }
  };

  const startGeneration = async (): Promise<void> => {
    const prompt = (activeTab === 'polished' ? polishedText : originalText).trim();
    if (prompt.length === 0) {
      setError('请填写用于生成的文字。');
      return;
    }
    if (!Number.isFinite(duration) || duration < 4 || duration > 15) {
      setError('视频时长必须在 4–15 秒之间。');
      return;
    }
    if (!Number.isInteger(seed) || seed < 0) {
      setError('随机种子必须是非负整数。');
      return;
    }

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
        duration,
        seed,
        subtitles: options.subtitles,
      });
      setJobId(result.id);
    } catch (startError) {
      setError(errorMessage(startError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="generation-form"
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
            onChange={(event) => setDuration(event.target.valueAsNumber)}
          />
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

      <button className="button button-secondary" type="button" onClick={() => void polish()} disabled={polishing}>
        <Sparkles size={16} aria-hidden="true" />
        {polishing ? '正在润色…' : 'AI 润色'}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={submitting}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} />
    </form>
  );
}
