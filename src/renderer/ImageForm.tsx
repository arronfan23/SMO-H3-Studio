import { useCallback, useEffect, useRef, useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import {
  DEFAULT_GENERATION_OPTIONS,
  type GenerationOptionsValue,
} from '../shared/generation-options';
import { DEFAULT_IMAGE_OPTIONS } from '../shared/image-options';
import type { MediaComponentId, MediaComponentState } from '../shared/media-components';
import { resolveH3Resolution } from '../shared/resolution';
import { ComponentGate } from './ComponentGate';
import { GenerationOptions } from './GenerationOptions';
import { JobStatus } from './JobStatus';
import { StepNumberField } from './StepNumberField';
import { errorMessage } from './ui';

const JOB_SYNC_ERROR = '任务状态同步失败，正在等待活动任务状态，请勿重复提交。';

export function ImageForm({
  active = true,
  pageActive = true,
  busy = false,
  syncRevision = 0,
  onJobStarted,
}: {
  active?: boolean;
  pageActive?: boolean;
  busy?: boolean;
  syncRevision?: number;
  onJobStarted?: () => Promise<boolean | void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [options, setOptions] = useState<GenerationOptionsValue>({
    ...DEFAULT_GENERATION_OPTIONS,
    aspectRatio: '1:1 (Square)',
    megapixels: 1,
  });
  const [seed, setSeed] = useState<number>(DEFAULT_IMAGE_OPTIONS.seed);
  const [steps, setSteps] = useState<number>(DEFAULT_IMAGE_OPTIONS.steps);
  const [component, setComponent] = useState<MediaComponentState | null>(null);
  const [componentLoading, setComponentLoading] = useState(true);
  const [componentError, setComponentError] = useState<string | null>(null);
  const [componentOperation, setComponentOperation] = useState<
    'install' | 'cancel' | null
  >(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const interactionActive = active && pageActive;
  const interactionActiveRef = useRef(interactionActive);
  interactionActiveRef.current = interactionActive;
  const syncRevisionRef = useRef(syncRevision);
  syncRevisionRef.current = syncRevision;
  const mountedRef = useRef(false);
  const generationRef = useRef(false);
  const awaitingSynchronizationRef = useRef<number | null>(null);
  const componentRequestRef = useRef(0);
  const componentPollRef = useRef(0);
  const componentOperationRef = useRef(0);
  const activeComponentOperationRef = useRef<'install' | 'cancel' | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      componentRequestRef.current += 1;
      componentPollRef.current += 1;
      componentOperationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const awaitedRevision = awaitingSynchronizationRef.current;
    if (awaitedRevision === null || syncRevision <= awaitedRevision) {
      return;
    }
    awaitingSynchronizationRef.current = null;
    generationRef.current = false;
    setSubmitting(false);
    setError((current) => current === JOB_SYNC_ERROR ? null : current);
  }, [syncRevision]);

  const refreshComponent = useCallback(async (id: MediaComponentId): Promise<void> => {
    if (!interactionActiveRef.current) {
      return;
    }
    const requestId = ++componentRequestRef.current;
    setComponentLoading(true);
    setComponentError(null);
    try {
      const next = await window.smo.components.getState(id);
      if (
        mountedRef.current &&
        interactionActiveRef.current &&
        requestId === componentRequestRef.current
      ) {
        componentPollRef.current += 1;
        setComponent(next);
      }
    } catch (loadError) {
      if (
        mountedRef.current &&
        interactionActiveRef.current &&
        requestId === componentRequestRef.current
      ) {
        setComponentError(errorMessage(loadError));
      }
    } finally {
      if (mountedRef.current && requestId === componentRequestRef.current) {
        setComponentLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!interactionActive) {
      componentRequestRef.current += 1;
      componentPollRef.current += 1;
      componentOperationRef.current += 1;
      activeComponentOperationRef.current = null;
      setComponentOperation(null);
      setComponentLoading(false);
      return;
    }
    void refreshComponent('image');
  }, [interactionActive, refreshComponent]);

  useEffect(() => {
    if (!interactionActive || component?.status !== 'installing') {
      return;
    }
    let current = true;
    let timer: number | null = null;
    const poll = async (): Promise<void> => {
      if (!interactionActiveRef.current) {
        return;
      }
      const pollId = ++componentPollRef.current;
      try {
        const next = await window.smo.components.getState('image');
        if (
          current &&
          mountedRef.current &&
          interactionActiveRef.current &&
          pollId === componentPollRef.current
        ) {
          setComponent(next);
          setComponentError(null);
        }
      } catch (pollError) {
        if (
          current &&
          mountedRef.current &&
          interactionActiveRef.current &&
          pollId === componentPollRef.current
        ) {
          setComponentError(errorMessage(pollError));
        }
      } finally {
        if (current && interactionActiveRef.current) {
          timer = window.setTimeout(() => void poll(), 250);
        }
      }
    };
    void poll();
    return () => {
      current = false;
      componentPollRef.current += 1;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [component?.status, interactionActive]);

  const installComponent = async (id: MediaComponentId): Promise<void> => {
    if (
      !interactionActiveRef.current ||
      busy ||
      activeComponentOperationRef.current !== null
    ) {
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
      mountedRef.current &&
      interactionActiveRef.current &&
      operationId === componentOperationRef.current;
    try {
      const next = await window.smo.components.install(id);
      if (isCurrent()) {
        componentPollRef.current += 1;
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
    if (
      !interactionActiveRef.current ||
      activeComponentOperationRef.current === 'cancel'
    ) {
      return;
    }
    const operationId = ++componentOperationRef.current;
    activeComponentOperationRef.current = 'cancel';
    setComponentOperation('cancel');
    setComponentError(null);
    const isCurrent = (): boolean =>
      mountedRef.current &&
      interactionActiveRef.current &&
      operationId === componentOperationRef.current;
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
    !interactionActive ||
    submitting ||
    busy ||
    component?.status !== 'ready' ||
    componentOperation !== null;

  const startGeneration = async (): Promise<void> => {
    if (
      !interactionActiveRef.current ||
      generationRef.current ||
      busy ||
      component?.status !== 'ready' ||
      componentOperation !== null
    ) {
      return;
    }
    const text = prompt.trim();
    if (text.length === 0) {
      setError('请填写图像提示词。');
      return;
    }
    if (!Number.isSafeInteger(seed) || seed < 0) {
      setError('随机种子必须是非负安全整数。');
      return;
    }
    if (!Number.isInteger(steps) || steps < 1 || steps > 100) {
      setError('采样步数必须是 1–100 之间的整数。');
      return;
    }

    const { width, height } = resolveH3Resolution(
      options.aspectRatio,
      options.megapixels,
    );
    generationRef.current = true;
    awaitingSynchronizationRef.current = null;
    setSubmitting(true);
    setError(null);
    setJobId(null);
    let releaseSubmissionLock = true;
    try {
      const result = await window.smo.jobs.start({
        mode: 'image',
        prompt: text,
        width,
        height,
        seed,
        steps,
      });
      if (!mountedRef.current) {
        return;
      }
      setJobId(result.id);
      if (onJobStarted !== undefined) {
        const revisionBeforeRefresh = syncRevisionRef.current;
        let synchronized = false;
        try {
          synchronized = (await onJobStarted()) !== false;
        } catch {
          synchronized = false;
        }
        if (!synchronized && syncRevisionRef.current === revisionBeforeRefresh) {
          releaseSubmissionLock = false;
          awaitingSynchronizationRef.current = revisionBeforeRefresh;
          if (mountedRef.current) {
            setError(JOB_SYNC_ERROR);
          }
        }
      }
    } catch (startError) {
      if (mountedRef.current) {
        setError(errorMessage(startError));
      }
    } finally {
      if (releaseSubmissionLock) {
        awaitingSynchronizationRef.current = null;
        generationRef.current = false;
        if (mountedRef.current) {
          setSubmitting(false);
        }
      }
    }
  };

  return (
    <section className="image-workspace" aria-label="图像制作">
      <ComponentGate
        id="image"
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
        aria-busy={submitting || busy}
        onSubmit={(event) => {
          event.preventDefault();
          void startGeneration();
        }}
      >
        <div className="field">
          <label htmlFor="image-prompt">图像提示词</label>
          <textarea
            id="image-prompt"
            rows={7}
            value={prompt}
            placeholder="描述主体、环境、构图、光线和色彩"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </div>

        <GenerationOptions
          idPrefix="image"
          value={options}
          onChange={setOptions}
          disabled={submitting || busy}
          showModel={false}
          aspectLabel="图像比例"
        />

        <div className="form-row image-parameter-row">
          <div className="field">
            <label htmlFor="image-seed">随机种子</label>
            <input
              id="image-seed"
              type="number"
              min={0}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              value={Number.isNaN(seed) ? '' : seed}
              disabled={submitting || busy}
              onChange={(event) => setSeed(event.target.valueAsNumber)}
            />
          </div>
          <StepNumberField
            id="image-steps"
            label="采样步数"
            value={steps}
            recommended={25}
            min={1}
            max={100}
            disabled={submitting || busy}
            onChange={setSteps}
          />
        </div>

        {busy && !submitting && (
          <p className="form-notice" role="status">当前有生成任务，完成后才能生成图像。</p>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button
          className="button button-generate"
          type="submit"
          disabled={generationDisabled}
        >
          <ImageIcon size={17} aria-hidden="true" />
          {submitting ? '正在提交…' : '生成图像'}
        </button>
        <JobStatus jobId={jobId} active={active && pageActive} allowCancel />
      </form>
    </section>
  );
}
