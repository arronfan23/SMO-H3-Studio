import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useMediaUrl } from './useMediaUrl';
import { errorMessage, fileName } from './ui';

export interface ReferenceImagePickerProps {
  paths: readonly string[];
  max: number;
  disabled?: boolean;
  onChange: (paths: string[]) => void;
  onError: (message: string | null) => void;
}

function additionsWithoutDuplicates(
  candidates: readonly string[],
  existingPaths: readonly string[],
): { additions: string[]; hasDuplicates: boolean } {
  const seen = new Set(existingPaths);
  const additions: string[] = [];
  let hasDuplicates = false;

  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      hasDuplicates = true;
      continue;
    }
    seen.add(candidate);
    additions.push(candidate);
  }

  return { additions, hasDuplicates };
}

function ReferenceImageItem({
  path,
  index,
  disabled,
  onRemove,
}: {
  path: string;
  index: number;
  disabled: boolean;
  onRemove: (index: number) => void;
}) {
  const { url, error } = useMediaUrl(path);
  const name = fileName(path);

  return (
    <li className="reference-image-item">
      <span className="reference-image-index">{index + 1}</span>
      <div className="reference-image-preview">
        {url ? (
          <img src={url} alt={`参考图 ${index + 1}：${name}`} />
        ) : (
          <span role={error ? 'alert' : 'status'}>{error ?? '正在读取…'}</span>
        )}
      </div>
      <span className="reference-image-filename" title={path}>{name}</span>
      <button
        className="button button-icon"
        type="button"
        aria-label={`删除参考图 ${index + 1}`}
        title={`删除参考图 ${index + 1}`}
        disabled={disabled}
        onClick={() => onRemove(index)}
      >
        <X size={16} aria-hidden="true" />
      </button>
    </li>
  );
}

export function ReferenceImagePicker({
  paths,
  max,
  disabled = false,
  onChange,
  onError,
}: ReferenceImagePickerProps) {
  const [selecting, setSelecting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const mountedRef = useRef(true);
  const operationIdRef = useRef(0);
  const pathsRef = useRef(paths);
  const maxRef = useRef(max);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  const onErrorRef = useRef(onError);
  pathsRef.current = paths;
  maxRef.current = max;
  disabledRef.current = disabled;
  onChangeRef.current = onChange;
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrent = (operationId: number): boolean =>
    mountedRef.current && operationIdRef.current === operationId;

  const selectImage = async (): Promise<void> => {
    if (disabledRef.current || pathsRef.current.length >= maxRef.current) {
      return;
    }
    const operationId = ++operationIdRef.current;
    setDropActive(false);
    setSelecting(true);
    onErrorRef.current(null);

    try {
      const selected = await window.smo.files.selectImage();
      if (!isCurrent(operationId) || disabledRef.current || selected === null) {
        return;
      }
      const currentPaths = pathsRef.current;
      if (currentPaths.length >= maxRef.current) {
        onErrorRef.current(`最多 ${maxRef.current} 张参考图，本次选择未添加。`);
        return;
      }
      const { additions, hasDuplicates } = additionsWithoutDuplicates([selected], currentPaths);
      if (hasDuplicates) {
        onErrorRef.current('参考图路径重复，未重复添加。');
      }
      if (additions.length > 0) {
        onChangeRef.current([...currentPaths, ...additions]);
      }
    } catch (selectError) {
      if (isCurrent(operationId)) {
        onErrorRef.current(errorMessage(selectError));
      }
    } finally {
      if (isCurrent(operationId)) {
        setSelecting(false);
      }
    }
  };

  const removeImage = (index: number): void => {
    if (disabledRef.current) {
      return;
    }
    operationIdRef.current += 1;
    setSelecting(false);
    setDropActive(false);
    onChangeRef.current(pathsRef.current.filter((_, pathIndex) => pathIndex !== index));
    onErrorRef.current(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDropActive(false);
    if (disabledRef.current) {
      return;
    }
    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length === 0) {
      return;
    }

    const operationId = ++operationIdRef.current;
    setSelecting(true);
    onErrorRef.current(null);
    void (async () => {
      try {
        const authorized = await Promise.all(
          droppedFiles.map((file) => window.smo.files.authorizeDroppedImage(file)),
        );
        if (!isCurrent(operationId) || disabledRef.current) {
          return;
        }
        const currentPaths = pathsRef.current;
        const { additions, hasDuplicates } = additionsWithoutDuplicates(authorized, currentPaths);
        if (currentPaths.length + additions.length > maxRef.current) {
          onErrorRef.current(`最多 ${maxRef.current} 张参考图，本次拖入未添加。`);
          return;
        }
        if (hasDuplicates) {
          onErrorRef.current('检测到重复路径，已忽略重复参考图。');
        }
        if (additions.length > 0) {
          onChangeRef.current([...currentPaths, ...additions]);
        }
      } catch (dropError) {
        if (isCurrent(operationId)) {
          onErrorRef.current(errorMessage(dropError));
        }
      } finally {
        if (isCurrent(operationId)) {
          setSelecting(false);
        }
      }
    })();
  };

  return (
    <div className="reference-image-picker">
      <div className="reference-image-toolbar">
        <button
          className="button button-secondary"
          type="button"
          disabled={disabled || selecting || paths.length >= max}
          onClick={() => void selectImage()}
        >
          <ImagePlus size={16} aria-hidden="true" />
          {selecting ? '正在选择…' : '选择参考图'}
        </button>
        <span className="reference-image-count">{paths.length} / {max}</span>
      </div>
      <div
        className="reference-image-dropzone"
        role="group"
        aria-label="参考图拖放区"
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
        {paths.length === 0 ? (
          <div className="reference-image-empty">尚未选择参考图</div>
        ) : (
          <ol className="reference-image-list" aria-label="已选参考图">
            {paths.map((path, index) => (
              <ReferenceImageItem
                key={path}
                path={path}
                index={index}
                disabled={disabled}
                onRemove={removeImage}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
