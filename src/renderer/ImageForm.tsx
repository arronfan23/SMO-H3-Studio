import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import {
  ASPECT_RATIO_OPTIONS,
  type AspectRatio,
} from '../shared/generation-options';
import {
  DEFAULT_IMAGE_OPTIONS,
  DEFAULT_IMAGE_RESOLUTION_MP,
  IMAGE_RESOLUTION_OPTIONS,
  type ImageResolutionMegapixels,
} from '../shared/image-options';
import type { MediaComponentId, MediaComponentState } from '../shared/media-components';
import { resolveH3Resolution, resolveResolutionForDimensions } from '../shared/resolution';
import { ComponentGate } from './ComponentGate';
import { JobStatus } from './JobStatus';
import { ReferenceImagePicker } from './ReferenceImagePicker';
import { StepNumberField } from './StepNumberField';
import { errorMessage } from './ui';
import { useMediaUrl } from './useMediaUrl';

const JOB_SYNC_ERROR = '任务状态同步失败，正在等待活动任务状态，请勿重复提交。';
type ImageMode = 'text' | 'reference';

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
  const [imageMode, setImageMode] = useState<ImageMode>('text');
  const [referenceImagePaths, setReferenceImagePaths] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1 (Square)');
  const [megapixels, setMegapixels] = useState<ImageResolutionMegapixels>(
    DEFAULT_IMAGE_RESOLUTION_MP,
  );
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
  const [referenceDimensions, setReferenceDimensions] = useState<{
    path: string;
    naturalWidth: number;
    naturalHeight: number;
  } | null>(null);
  const firstReferencePath = referenceImagePaths[0] ?? null;
  const referenceContextRef = useRef({ imageMode, firstReferencePath });
  referenceContextRef.current = { imageMode, firstReferencePath };
  const { url: firstReferenceUrl, error: firstReferenceError } = useMediaUrl(
    imageMode === 'reference' ? firstReferencePath : null,
  );
  const currentReferenceDimensions = referenceDimensions?.path === firstReferencePath
    ? referenceDimensions
    : null;
  const referenceResolution = imageMode === 'reference' && currentReferenceDimensions !== null
    ? resolveResolutionForDimensions(
        currentReferenceDimensions.naturalWidth,
        currentReferenceDimensions.naturalHeight,
        megapixels,
      )
    : null;
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
  const textImageTabRef = useRef<HTMLButtonElement>(null);
  const referenceImageTabRef = useRef<HTMLButtonElement>(null);

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
    componentOperation !== null ||
    (imageMode === 'reference' &&
      (referenceImagePaths.length === 0 || referenceResolution === null));

  const readFirstReferenceDimensions = (image: HTMLImageElement): void => {
    const path = firstReferencePath;
    const current = referenceContextRef.current;
    if (
      path === null ||
      current.imageMode !== 'reference' ||
      current.firstReferencePath !== path
    ) {
      return;
    }
    const { naturalWidth, naturalHeight } = image;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      setReferenceDimensions(null);
      setError('无法读取首图自然尺寸，请重新选择参考图。');
      return;
    }
    setReferenceDimensions({ path, naturalWidth, naturalHeight });
  };

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
    if (imageMode === 'reference' && referenceImagePaths.length === 0) {
      setError('请至少添加 1 张参考图。');
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

    const resolution = imageMode === 'reference'
      ? referenceResolution
      : resolveH3Resolution(aspectRatio, megapixels);
    if (resolution === null) {
      setError('首图尺寸尚未读取完成，请稍候再生成。');
      return;
    }
    const { width, height } = resolution;
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
        referenceImagePaths: imageMode === 'reference' ? [...referenceImagePaths] : [],
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

  const resolutionField = (
    <div className="field">
      <label htmlFor="image-resolution">分辨率</label>
      <select
        id="image-resolution"
        value={String(megapixels)}
        disabled={submitting || busy}
        onChange={(event) =>
          setMegapixels(Number(event.target.value) as ImageResolutionMegapixels)
        }
      >
        {IMAGE_RESOLUTION_OPTIONS.map((option) => {
          const resolution = imageMode === 'reference'
            ? currentReferenceDimensions === null
              ? null
              : resolveResolutionForDimensions(
                  currentReferenceDimensions.naturalWidth,
                  currentReferenceDimensions.naturalHeight,
                  option.value,
                )
            : resolveH3Resolution(aspectRatio, option.value);
          return (
            <option key={option.value} value={String(option.value)}>
              {resolution === null
                ? `${option.value} MP（等待首图尺寸）`
                : `${resolution.width} × ${resolution.height} px`}
            </option>
          );
        })}
      </select>
    </div>
  );

  const focusImageMode = (nextMode: ImageMode): void => {
    setImageMode(nextMode);
    (nextMode === 'text' ? textImageTabRef : referenceImageTabRef).current?.focus();
  };

  const handleImageModeKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let nextMode: ImageMode | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      nextMode = imageMode === 'text' ? 'reference' : 'text';
    } else if (event.key === 'Home') {
      nextMode = 'text';
    } else if (event.key === 'End') {
      nextMode = 'reference';
    }
    if (nextMode !== null) {
      event.preventDefault();
      focusImageMode(nextMode);
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
        <div
          className="tab-list"
          role="tablist"
          aria-label="图像模式"
          onKeyDown={handleImageModeKeyDown}
        >
          <button
            ref={textImageTabRef}
            id="text-image-tab"
            type="button"
            role="tab"
            aria-selected={imageMode === 'text'}
            aria-controls="text-image-panel"
            tabIndex={imageMode === 'text' ? 0 : -1}
            onClick={() => focusImageMode('text')}
          >
            文字生图
          </button>
          <button
            ref={referenceImageTabRef}
            id="reference-image-tab"
            type="button"
            role="tab"
            aria-selected={imageMode === 'reference'}
            aria-controls="reference-image-panel"
            tabIndex={imageMode === 'reference' ? 0 : -1}
            onClick={() => focusImageMode('reference')}
          >
            参考生图
          </button>
        </div>

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

        <div
          id={`${imageMode}-image-panel`}
          className="generation-form"
          role="tabpanel"
          aria-labelledby={`${imageMode}-image-tab`}
        >
          {imageMode === 'reference' ? (
            <>
              {firstReferenceUrl !== null && (
                <img
                  key={firstReferenceUrl}
                  data-testid="reference-image-dimensions"
                  src={firstReferenceUrl}
                  alt=""
                  aria-hidden="true"
                  hidden
                  onLoad={(event) => readFirstReferenceDimensions(event.currentTarget)}
                />
              )}
              <ReferenceImagePicker
                paths={referenceImagePaths}
                max={4}
                disabled={submitting || busy}
                onChange={setReferenceImagePaths}
                onError={setError}
              />
              <div className="form-row image-option-row">{resolutionField}</div>
            </>
          ) : (
            <div className="form-row image-option-row">
              <div className="field">
                <label htmlFor="image-aspect">图像比例</label>
                <select
                  id="image-aspect"
                  value={aspectRatio}
                  disabled={submitting || busy}
                  onChange={(event) =>
                    setAspectRatio(event.target.value as AspectRatio)
                  }
                >
                  {ASPECT_RATIO_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {resolutionField}
            </div>
          )}
        </div>

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
        {imageMode === 'reference' && (
          <p className="form-notice" role="status">
            {referenceImagePaths.length === 0
              ? '请至少添加 1 张参考图后再生成。'
              : referenceResolution === null
                ? firstReferenceError ?? '正在读取首图尺寸，完成后才能生成图像。'
                : currentReferenceDimensions !== null
                  ? `首图 ${currentReferenceDimensions.naturalWidth} × ${currentReferenceDimensions.naturalHeight} px，输出 ${referenceResolution.width} × ${referenceResolution.height} px。`
                  : ''}
          </p>
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
