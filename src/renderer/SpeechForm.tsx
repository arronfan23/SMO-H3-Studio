import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import type { MediaComponentId, MediaComponentState } from '../shared/media-components';
import type {
  AudioOutputFormat,
  SpeechCapabilities,
  SpeechGenerationRequest,
} from '../shared/types';
import { AudioInput } from './AudioInput';
import { AudioRecorder } from './AudioRecorder';
import { ComponentGate } from './ComponentGate';
import { JobStatus } from './JobStatus';
import { GenerationResultPreview } from './GenerationResultPreview';
import { errorMessage } from './ui';
import { useMediaUrl } from './useMediaUrl';

const OUTPUT_FORMATS: Array<{ value: AudioOutputFormat; label: string }> = [
  { value: 'wav', label: 'WAV' },
  { value: 'mp3', label: 'MP3' },
  { value: 'flac', label: 'FLAC' },
  { value: 'm4a', label: 'M4A' },
];

const LANGUAGE_LABELS: Record<string, string> = {
  Chinese: '中文',
  English: '英语',
  Japanese: '日语',
  Spanish: '西班牙语',
  Arabic: '阿拉伯语',
};

export function SpeechForm({
  active = true,
  pageActive = true,
  busy = false,
  onOpenWorks,
  onJobStarted,
}: {
  active?: boolean;
  pageActive?: boolean;
  busy?: boolean;
  onOpenWorks?: () => void;
  onJobStarted?: () => Promise<boolean | void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [instruct, setInstruct] = useState('');
  const [language, setLanguage] = useState('');
  const [outputFormat, setOutputFormat] = useState<AudioOutputFormat>('wav');
  const [speechRate, setSpeechRate] = useState(1);
  const [referenceAudioPath, setReferenceAudioPath] = useState<string | null>(null);
  const [referenceAudioRevision, setReferenceAudioRevision] = useState(0);
  const [referenceAudioSeconds, setReferenceAudioSeconds] = useState<number | null>(null);
  const [currentCapabilities, setCurrentCapabilities] = useState<SpeechCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [capabilitiesRevision, setCapabilitiesRevision] = useState(0);
  const [component, setComponent] = useState<MediaComponentState | null>(null);
  const [componentLoading, setComponentLoading] = useState(true);
  const [componentError, setComponentError] = useState<string | null>(null);
  const [componentOperation, setComponentOperation] = useState<
    'install' | 'cancel' | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const { url: referenceAudioUrl, error: referenceMediaError } = useMediaUrl(referenceAudioPath);
  const referenceAudioRef = useRef<HTMLAudioElement | null>(null);
  const referenceAudioRevisionRef = useRef(0);
  const mountedRef = useRef(false);
  const generationRef = useRef(false);
  const capabilitiesRequestRef = useRef(0);
  const retryCapabilitiesAfterInstallRef = useRef(false);
  const componentRequestRef = useRef(0);
  const componentPollRef = useRef(0);
  const componentOperationRef = useRef(0);
  const activeComponentOperationRef = useRef<'install' | 'cancel' | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      capabilitiesRequestRef.current += 1;
      componentOperationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!active || !pageActive) {
      referenceAudioRef.current?.pause();
    }
  }, [active, pageActive, referenceAudioRevision]);

  const refreshComponent = useCallback(async (id: MediaComponentId): Promise<void> => {
    const requestId = ++componentRequestRef.current;
    setComponentLoading(true);
    setComponentError(null);
    try {
      const next = await window.smo.components.getState(id);
      if (mountedRef.current && requestId === componentRequestRef.current) {
        setComponent(next);
      }
    } catch (loadError) {
      if (mountedRef.current && requestId === componentRequestRef.current) {
        setComponentError(errorMessage(loadError));
      }
    } finally {
      if (mountedRef.current && requestId === componentRequestRef.current) {
        setComponentLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refreshComponent('speech');
  }, [refreshComponent]);

  useEffect(() => {
    if (component?.status !== 'installing') {
      return;
    }
    let current = true;
    const poll = async (): Promise<void> => {
      const pollId = ++componentPollRef.current;
      try {
        const next = await window.smo.components.getState('speech');
        if (current && mountedRef.current && pollId === componentPollRef.current) {
          setComponent(next);
          setComponentError(null);
        }
      } catch (pollError) {
        if (current && mountedRef.current && pollId === componentPollRef.current) {
          setComponentError(errorMessage(pollError));
        }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 250);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [component?.status]);

  useEffect(() => {
    const requestId = ++capabilitiesRequestRef.current;
    if (!active || !pageActive || component?.status !== 'ready') {
      setCapabilitiesLoading(false);
      return;
    }

    setCapabilitiesLoading(true);
    setCapabilitiesError(null);
    void (async () => {
      try {
        const next = await window.smo.speech.getCapabilities('custom');
        if (!mountedRef.current || requestId !== capabilitiesRequestRef.current) {
          return;
        }
        retryCapabilitiesAfterInstallRef.current = false;
        setCurrentCapabilities(next);
        setLanguage((previous) =>
          next.languages.includes(previous) ? previous : next.languages[0] ?? '',
        );
      } catch (loadError) {
        if (!mountedRef.current || requestId !== capabilitiesRequestRef.current) {
          return;
        }
        if (retryCapabilitiesAfterInstallRef.current) {
          retryCapabilitiesAfterInstallRef.current = false;
          setCapabilitiesError(null);
          setCapabilitiesRevision((revision) => revision + 1);
          return;
        }
        setCapabilitiesError(errorMessage(loadError));
      } finally {
        if (mountedRef.current && requestId === capabilitiesRequestRef.current) {
          setCapabilitiesLoading(false);
        }
      }
    })();
  }, [active, pageActive, component?.status, capabilitiesRevision]);

  const installComponent = async (id: MediaComponentId): Promise<void> => {
    if (busy || activeComponentOperationRef.current !== null) {
      return;
    }
    const operationId = ++componentOperationRef.current;
    activeComponentOperationRef.current = 'install';
    componentRequestRef.current += 1;
    setComponentOperation('install');
    setComponentError(null);
    setComponent((previous) =>
      previous?.id === id
        ? { ...previous, status: 'installing', active: true, error: null }
        : previous,
    );
    const isCurrent = (): boolean =>
      mountedRef.current && operationId === componentOperationRef.current;
    try {
      const next = await window.smo.components.install(id);
      if (isCurrent()) {
        componentPollRef.current += 1;
        if (next.status === 'ready' && active && pageActive) {
          retryCapabilitiesAfterInstallRef.current = true;
          setCapabilitiesRevision((revision) => revision + 1);
        }
        setComponent(next);
      }
    } catch (installError) {
      if (isCurrent()) {
        componentPollRef.current += 1;
        setComponentError(errorMessage(installError));
        try {
          const latest = await window.smo.components.getState(id);
          if (isCurrent()) {
            componentPollRef.current += 1;
            setComponent(latest);
          }
        } catch {
          // Keep the install error visible if the follow-up state read also fails.
        }
      }
    } finally {
      if (isCurrent()) {
        activeComponentOperationRef.current = null;
        setComponentOperation(null);
      }
    }
  };

  const cancelComponent = async (id: MediaComponentId): Promise<void> => {
    if (activeComponentOperationRef.current === 'cancel') {
      return;
    }
    const operationId = ++componentOperationRef.current;
    activeComponentOperationRef.current = 'cancel';
    setComponentOperation('cancel');
    setComponentError(null);
    const isCurrent = (): boolean =>
      mountedRef.current && operationId === componentOperationRef.current;
    try {
      await window.smo.components.cancel(id);
      const latest = await window.smo.components.getState(id);
      if (isCurrent()) {
        componentPollRef.current += 1;
        setComponent(latest);
      }
    } catch (cancelError) {
      if (isCurrent()) {
        setComponentError(errorMessage(cancelError));
      }
    } finally {
      if (isCurrent()) {
        activeComponentOperationRef.current = null;
        setComponentOperation(null);
      }
    }
  };

  const generationDisabled =
    submitting ||
    busy ||
    recordingBusy ||
    component?.status !== 'ready' ||
    componentOperation !== null ||
    capabilitiesLoading ||
    capabilitiesError !== null ||
    !currentCapabilities ||
    referenceAudioPath === null;

  const startGeneration = async (): Promise<void> => {
    if (
      generationRef.current ||
      busy ||
      recordingBusy ||
      component?.status !== 'ready' ||
      componentOperation !== null ||
      capabilitiesLoading
    ) {
      return;
    }
    if (!currentCapabilities) {
      setError('音色与语言尚未加载，请重试。');
      return;
    }
    if (capabilitiesError !== null) {
      return;
    }
    const text = prompt.trim();
    if (text.length === 0) {
      setError('请填写口播文字。');
      return;
    }
    if (language.length === 0) {
      setError('请选择语言。');
      return;
    }
    if (referenceAudioPath === null) {
      setError('请选择参考音频。');
      return;
    }

    const shared = {
      mode: 'speech' as const,
      prompt: text,
      language,
      outputFormat,
      speechRate,
    };
    const trimmedInstruct = instruct.trim();
    const request: SpeechGenerationRequest =
      trimmedInstruct.length === 0
        ? { ...shared, speechMode: 'clone', referenceAudioPath }
        : {
            ...shared,
            speechMode: 'custom',
            referenceAudioPath,
            instruct: trimmedInstruct,
          };

    generationRef.current = true;
    setSubmitting(true);
    setError(null);
    setJobId(null);
    try {
      const result = await window.smo.jobs.start(request);
      if (!mountedRef.current) {
        return;
      }
      setJobId(result.id);
      void onJobStarted?.();
    } catch (startError) {
      if (mountedRef.current) {
        setError(errorMessage(startError));
      }
    } finally {
      generationRef.current = false;
      if (mountedRef.current) {
        setSubmitting(false);
      }
    }
  };

  const renderPromptField = () => (
    <div className="field">
      <label htmlFor="custom-speech-prompt">口播文字</label>
      <textarea
        id="custom-speech-prompt"
        rows={6}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="输入要朗读的文字"
      />
    </div>
  );

  const renderLanguageField = () => (
    <div className="field">
      <label htmlFor="custom-speech-language">语言</label>
      <select
        id="custom-speech-language"
        value={language}
        disabled={submitting || capabilitiesLoading || !currentCapabilities}
        onChange={(event) => setLanguage(event.target.value)}
      >
        {language === '' && <option value="">请选择语言</option>}
        {currentCapabilities?.languages.map((option) => (
          <option key={option} value={option}>
            {LANGUAGE_LABELS[option] ?? option}
          </option>
        ))}
      </select>
    </div>
  );

  const renderOutputField = () => (
    <div className="field">
      <label htmlFor="custom-speech-output">输出格式</label>
      <select
        id="custom-speech-output"
        value={outputFormat}
        disabled={submitting}
        onChange={(event) => setOutputFormat(event.target.value as AudioOutputFormat)}
      >
        {OUTPUT_FORMATS.map((format) => (
          <option key={format.value} value={format.value}>{format.label}</option>
        ))}
      </select>
    </div>
  );

  const renderSpeechRateField = () => (
    <div className="field">
      <div className="speech-rate-heading">
        <label htmlFor="custom-speech-rate">语速</label>
        <output>{speechRate.toFixed(2)}x</output>
      </div>
      <input
        id="custom-speech-rate"
        className="speech-rate-slider"
        type="range"
        min={0.5}
        max={2}
        step={0.05}
        value={speechRate}
        disabled={submitting}
        onChange={(event) => setSpeechRate(Number(event.target.value))}
      />
    </div>
  );

  const handleReferenceAudioSelected = (selected: string | null): void => {
    referenceAudioRevisionRef.current += 1;
    setReferenceAudioRevision(referenceAudioRevisionRef.current);
    setReferenceAudioPath(selected);
    setReferenceAudioSeconds(null);
  };

  const renderReferenceAudioFields = () => {
    return (
    <div className="field">
      <span className="field-caption">参考音频</span>
      <AudioInput
        path={referenceAudioPath}
        disabled={submitting || busy || recordingBusy}
        onSelected={handleReferenceAudioSelected}
        onError={setError}
      />
      <AudioRecorder
        active={active && pageActive}
        disabled={submitting || busy}
        hasAudio={referenceAudioPath !== null}
        onBusyChange={setRecordingBusy}
        onRecorded={handleReferenceAudioSelected}
        onError={setError}
      />
      {referenceAudioPath && referenceAudioSeconds !== null && (
        <p className="audio-duration">音频时长：{referenceAudioSeconds.toFixed(2)} 秒</p>
      )}
      {referenceAudioUrl && (
        <audio
          key={`${referenceAudioPath}:${referenceAudioRevision}`}
          ref={referenceAudioRef}
          className="audio-preview"
          aria-label="参考音频"
          controls
          preload="metadata"
          src={referenceAudioUrl}
          onLoadedMetadata={(event) => {
            if (referenceAudioRevision !== referenceAudioRevisionRef.current) return;
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) {
              setReferenceAudioSeconds(seconds);
            } else {
              setError('无法读取有效的音频时长。');
            }
          }}
        />
      )}
      {referenceMediaError && <p className="form-error" role="alert">{referenceMediaError}</p>}
    </div>
    );
  };

  return (
    <section className="speech-workspace" aria-label="语音制作">
      <ComponentGate
        id="speech"
        state={component}
        loading={componentLoading}
        error={componentError}
        operation={componentOperation}
        generationBusy={busy}
        install={installComponent}
        cancel={cancelComponent}
        retry={refreshComponent}
      />
      <form
        className="generation-form"
        noValidate
        aria-busy={submitting}
        onSubmit={(event) => {
          event.preventDefault();
          void startGeneration();
        }}
      >
        {capabilitiesLoading && (
          <p className="form-notice" role="status">正在加载音色与语言…</p>
        )}
        {capabilitiesError && (
          <>
            <p className="form-error" role="alert">
              音色与语言加载失败：{capabilitiesError}
            </p>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setCapabilitiesRevision((revision) => revision + 1)}
            >
              <RotateCcw size={16} aria-hidden="true" />
              重试加载
            </button>
          </>
        )}

        <div
          id="custom-speech-panel"
          className="speech-mode-fields"
        >
          {renderPromptField()}
          {renderReferenceAudioFields()}
          <div className="field">
            <label htmlFor="custom-speech-instruct">情绪/语气</label>
            <input
              id="custom-speech-instruct"
              type="text"
              value={instruct}
              onChange={(event) => setInstruct(event.target.value)}
              placeholder="例如：温暖、从容，富有感染力"
            />
          </div>
          <div className="form-row form-row-three">
            {renderLanguageField()}
            {renderSpeechRateField()}
            {renderOutputField()}
          </div>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        <button
          className="button button-generate"
          type="submit"
          disabled={generationDisabled}
        >
          <Play size={17} aria-hidden="true" />
          {submitting ? '正在提交…' : '生成语音'}
        </button>
        <JobStatus jobId={jobId} active={active && pageActive} allowCancel />
        <GenerationResultPreview jobId={jobId} onOpenWorks={onOpenWorks ?? (() => undefined)} />
      </form>
    </section>
  );
}
