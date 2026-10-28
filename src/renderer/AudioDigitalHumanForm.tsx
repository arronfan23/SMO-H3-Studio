import { useState } from 'react';
import { FileAudio, Video } from 'lucide-react';
import {
  DEFAULT_GENERATION_OPTIONS,
  DEFAULT_MODEL_DIRECTORY,
  buildHardwareProfile,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { GenerationOptions } from './GenerationOptions';
import { JobStatus } from './JobStatus';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage, fileName } from './ui';

export function AudioDigitalHumanForm({
  avatarId,
  active = true,
}: {
  avatarId: string;
  active?: boolean;
}) {
  const [audioPath, setAudioPath] = useState<string | null>(null);
  const [audioSeconds, setAudioSeconds] = useState<number | null>(null);
  const [prompt, setPrompt] = useState('');
  const [trimStart, setTrimStart] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seed, setSeed] = useState(42);
  const [options, setOptions] = useState<GenerationOptionsValue>(
    DEFAULT_GENERATION_OPTIONS,
  );
  const [selecting, setSelecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { url: audioUrl, error: mediaError } = useMediaUrl(audioPath);

  const selectAudio = async (): Promise<void> => {
    setSelecting(true);
    setError(null);
    try {
      const selected = await window.smo.files.selectAudio();
      if (selected !== null) {
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

  const startGeneration = async (): Promise<void> => {
    const normalizedPrompt = prompt.trim();
    if (audioPath === null || audioSeconds === null) {
      setError('请选择音频并等待时长读取完成。');
      return;
    }
    if (normalizedPrompt.length === 0) {
      setError('请填写动作/画面提示词。');
      return;
    }
    if (!Number.isFinite(trimStart) || trimStart < 0) {
      setError('起始截取时间必须是非负数字。');
      return;
    }
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      trimStart + duration > audioSeconds
    ) {
      setError('截取范围不能超出实际音频时长。');
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
        mode: 'audio',
        profile: buildHardwareProfile(options),
        confirmed: true,
        modelDirectory: DEFAULT_MODEL_DIRECTORY,
      });
      const result = await window.smo.jobs.start({
        mode: 'audio',
        avatarId,
        prompt: normalizedPrompt,
        audioPath,
        trimStart,
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

      <GenerationOptions
        idPrefix="audio"
        value={options}
        onChange={setOptions}
        disabled={submitting}
      />

      <div className="field">
        <label htmlFor="audio-prompt">动作/画面提示词</label>
        <textarea
          id="audio-prompt"
          rows={5}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="描述说话时的表情、动作和镜头"
        />
      </div>
      <div className="form-row form-row-three">
        <div className="field">
          <label htmlFor="audio-trim">起始截取（秒）</label>
          <input
            id="audio-trim"
            type="number"
            min={0}
            step={0.01}
            value={trimStart}
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
            onChange={(event) => setDuration(event.target.valueAsNumber)}
          />
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
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-generate" type="submit" disabled={submitting}>
        <Video size={17} aria-hidden="true" />
        {submitting ? '正在提交…' : '生成视频'}
      </button>
      <JobStatus jobId={jobId} active={active} allowCancel />
    </form>
  );
}
