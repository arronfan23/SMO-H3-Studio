import { useCallback, useEffect, useRef, useState } from 'react';

const POLL_INTERVAL_MS = 500;

export function useActiveJob(): {
  activeId: string | null;
  busy: boolean;
  syncRevision: number;
  refresh: () => Promise<boolean>;
} {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const latestRequestRef = useRef(0);

  const refresh = useCallback(async (): Promise<boolean> => {
    const requestId = ++latestRequestRef.current;
    const lifecycle = lifecycleRef.current;
    try {
      const state = await window.smo.jobs.getState();
      if (
        mountedRef.current &&
        lifecycle === lifecycleRef.current &&
        requestId === latestRequestRef.current &&
        !document.hidden
      ) {
        setActiveId(state.activeId);
        setSyncRevision((current) => current + 1);
        return true;
      }
    } catch {
      // A later poll or manual refresh can retry without surfacing a polling error.
    }
    return false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let timer: number | null = null;

    const stopPolling = (): void => {
      lifecycleRef.current += 1;
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const startPolling = (): void => {
      if (document.hidden || timer !== null) return;
      void refresh();
      timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const handleVisibilityChange = (): void => {
      if (document.hidden) {
        stopPolling();
      } else {
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    startPolling();
    return () => {
      mountedRef.current = false;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refresh]);

  return { activeId, busy: activeId !== null, syncRevision, refresh };
}
