import { useEffect, useRef, useState, type DragEvent } from 'react';
import { FileAudio, X } from 'lucide-react';
import { errorMessage, fileName } from './ui';

const DROPPED_AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a']);

export function AudioInput({
  path,
  disabled = false,
  onSelected,
  onError,
}: {
  path: string | null;
  disabled?: boolean;
  onSelected: (path: string | null) => void;
  onError: (message: string | null) => void;
}) {
  const [selecting, setSelecting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const mountedRef = useRef(true);
  const operationIdRef = useRef(0);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = (operationId: number): boolean =>
    mountedRef.current && operationIdRef.current === operationId;

  const selectAudio = async (): Promise<void> => {
    if (disabledRef.current) {
      return;
    }
    const operationId = ++operationIdRef.current;
    setDropActive(false);
    setSelecting(true);
    onError(null);
    try {
      const selected = await window.smo.files.selectAudio();
      if (isCurrent(operationId) && !disabledRef.current && selected !== null) {
        onSelected(selected);
      }
    } catch (selectError) {
      if (isCurrent(operationId)) {
        onError(errorMessage(selectError));
      }
    } finally {
      if (isCurrent(operationId)) {
        setSelecting(false);
      }
    }
  };

  const removeAudio = (): void => {
    if (disabledRef.current) {
      return;
    }
    operationIdRef.current += 1;
    setSelecting(false);
    setDropActive(false);
    onSelected(null);
    onError(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropActive(false);
    if (disabledRef.current) {
      return;
    }
    const operationId = ++operationIdRef.current;
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setSelecting(false);
      onError('一次只能拖入一个音频文件。');
      return;
    }
    const file = files[0];
    const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!DROPPED_AUDIO_EXTENSIONS.has(extension)) {
      setSelecting(false);
      onError('仅支持 WAV、MP3、FLAC、OGG 或 M4A 音频。');
      return;
    }

    setSelecting(true);
    onError(null);
    void (async () => {
      try {
        // Only the dropped File crosses the renderer API. Preload resolves
        // its path and the main process authorizes it before selection.
        const authorized = await window.smo.files.authorizeDroppedAudio(file);
        if (isCurrent(operationId) && !disabledRef.current) {
          onSelected(authorized);
        }
      } catch (dropError) {
        if (isCurrent(operationId)) {
          onError(errorMessage(dropError));
        }
      } finally {
        if (isCurrent(operationId)) {
          setSelecting(false);
        }
      }
    })();
  };

  return (
    <div className="audio-input">
      <button
        className="button button-secondary"
        type="button"
        onClick={() => void selectAudio()}
        disabled={disabled || selecting}
      >
        <FileAudio size={16} aria-hidden="true" />
        {selecting ? '正在选择…' : '选择音频'}
      </button>
      <div
        className="audio-dropzone"
        role="group"
        aria-label="音频拖放区"
        aria-disabled={disabled}
        aria-busy={selecting}
        data-drop-active={dropActive && !disabled ? 'true' : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) {
            setDropActive(true);
          }
        }}
        onDragLeave={(event) => {
          const next = event.relatedTarget;
          if (!(next instanceof Node && event.currentTarget.contains(next))) {
            setDropActive(false);
          }
        }}
        onDrop={handleDrop}
      >
        {path === null ? (
          <div className="audio-dropzone-empty">尚未选择音频</div>
        ) : (
          <div className="audio-file">
            <strong>{fileName(path)}</strong>
            <button
              className="button button-secondary"
              type="button"
              onClick={removeAudio}
              disabled={disabled}
            >
              <X size={16} aria-hidden="true" />
              移除音频
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
