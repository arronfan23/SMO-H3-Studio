import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { errorMessage } from './ui';

type RecorderPhase = 'idle' | 'starting' | 'recording' | 'saving';

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function microphoneError(error: unknown): string {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String(error.name)
      : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝，请允许本应用使用麦克风后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '未检测到可用的麦克风，请连接麦克风后重试。';
  }
  return `无法开始录音：${errorMessage(error)}`;
}

export function AudioRecorder({
  active = true,
  disabled = false,
  hasAudio = false,
  onBusyChange,
  onRecorded,
  onError,
}: {
  active?: boolean;
  disabled?: boolean;
  hasAudio?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onRecorded: (path: string) => void;
  onError: (message: string | null) => void;
}) {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const phaseRef = useRef<RecorderPhase>('idle');
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onRecordedRef = useRef(onRecorded);
  const onErrorRef = useRef(onError);
  activeRef.current = active;
  onRecordedRef.current = onRecorded;
  onErrorRef.current = onError;

  const updatePhase = (next: RecorderPhase): void => {
    phaseRef.current = next;
    if (mountedRef.current) {
      setPhase(next);
    }
  };

  const stopTracks = (): void => {
    const stream = streamRef.current;
    streamRef.current = null;
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
  };

  const cancelRecording = (preserveSaving = true): void => {
    if (
      preserveSaving &&
      mountedRef.current &&
      phaseRef.current === 'saving'
    ) {
      stopTracks();
      return;
    }
    operationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop();
        } catch {
          // Tracks are still stopped below if MediaRecorder is already closed.
        }
      }
    }
    chunksRef.current = [];
    stopTracks();
    updatePhase('idle');
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelRecording(false);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      cancelRecording();
    }
  }, [active]);

  useEffect(() => {
    if (disabled && phaseRef.current !== 'idle') {
      cancelRecording();
    }
  }, [disabled]);

  useEffect(() => {
    onBusyChange?.(phase !== 'idle');
  }, [onBusyChange, phase]);

  useEffect(
    () => () => {
      onBusyChange?.(false);
    },
    [],
  );

  useEffect(() => {
    if (phase !== 'recording') {
      return;
    }
    const startedAt = Date.now() - elapsedSeconds * 1_000;
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const isCurrent = (operation: number): boolean =>
    mountedRef.current && operationRef.current === operation;

  const isActive = (operation: number): boolean =>
    isCurrent(operation) && activeRef.current;

  const finishRecording = async (operation: number): Promise<void> => {
    if (!isCurrent(operation)) {
      return;
    }
    updatePhase('saving');
    const recorder = recorderRef.current;
    try {
      const chunks = chunksRef.current;
      const blob = new Blob(chunks, {
        type: recorder?.mimeType || chunks[0]?.type || 'audio/webm',
      });
      if (blob.size === 0) {
        throw new Error('没有录制到音频，请重录。');
      }
      const path = await window.smo.recordings.save(blob);
      if (!isCurrent(operation)) {
        await window.smo.recordings.discard(path);
        return;
      }
      onRecordedRef.current(path);
      updatePhase('idle');
    } catch (saveError) {
      if (isCurrent(operation)) {
        updatePhase('idle');
        onErrorRef.current(`录音保存失败：${errorMessage(saveError)}`);
      }
    } finally {
      if (operationRef.current === operation) {
        recorderRef.current = null;
        chunksRef.current = [];
      }
    }
  };

  const startRecording = async (): Promise<void> => {
    if (disabled || !activeRef.current || phaseRef.current !== 'idle') {
      return;
    }
    const operation = ++operationRef.current;
    chunksRef.current = [];
    setElapsedSeconds(0);
    updatePhase('starting');
    onErrorRef.current(null);

    try {
      if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
        const error = new Error('Media devices are unavailable');
        error.name = 'NotFoundError';
        throw error;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isActive(operation)) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      if (typeof MediaRecorder !== 'function') {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        throw new Error('当前环境不支持录音。');
      }

      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (operationRef.current === operation && event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        void finishRecording(operation);
      };
      recorder.onerror = () => {
        if (isCurrent(operation)) {
          onErrorRef.current('录音失败，请重录。');
          cancelRecording(false);
        }
      };
      recorder.start();
      updatePhase('recording');
    } catch (startError) {
      if (!isActive(operation)) {
        return;
      }
      recorderRef.current = null;
      stopTracks();
      updatePhase('idle');
      onErrorRef.current(microphoneError(startError));
    }
  };

  const stopRecording = (): void => {
    const recorder = recorderRef.current;
    if (phaseRef.current !== 'recording' || recorder === null) {
      return;
    }
    updatePhase('saving');
    try {
      recorder.stop();
    } catch (stopError) {
      updatePhase('idle');
      onErrorRef.current(`录音保存失败：${errorMessage(stopError)}`);
    } finally {
      stopTracks();
    }
  };

  const busy = phase === 'starting' || phase === 'saving';
  return (
    <div className="audio-recorder" aria-busy={busy}>
      {phase === 'recording' ? (
        <button
          className="button button-secondary"
          type="button"
          onClick={stopRecording}
        >
          <Square size={16} aria-hidden="true" />
          停止录音
        </button>
      ) : (
        <button
          className="button button-secondary"
          type="button"
          onClick={() => void startRecording()}
          disabled={disabled || phase !== 'idle'}
        >
          <Mic size={16} aria-hidden="true" />
          {phase === 'starting'
            ? '正在申请麦克风…'
            : phase === 'saving'
              ? '正在保存录音…'
              : hasAudio
                ? '重录'
                : '开始录音'}
        </button>
      )}
      {phase === 'recording' && (
        <span
          className="audio-recorder-time"
          role="timer"
          aria-label="录音计时"
        >
          {formatElapsed(elapsedSeconds)}
        </span>
      )}
      {phase === 'saving' && (
        <span className="audio-recorder-status">正在转换为 WAV</span>
      )}
    </div>
  );
}
