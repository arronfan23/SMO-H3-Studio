import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EnvironmentProfile,
  EnvironmentState,
} from '../shared/environment';
import type { HardwareInfo } from '../shared/types';
import { errorMessage } from './ui';

const POLL_INTERVAL_MS = 750;

type EnvironmentOperation = 'detect' | 'start' | 'retry';

export function isEnvironmentProfileAllowed(
  profile: EnvironmentProfile,
  hardware: HardwareInfo | null,
): boolean {
  if (profile === 'balanced-16gb') return (hardware?.vramGiB ?? 0) >= 12;
  if (profile === 'high-memory-candidate') return (hardware?.vramGiB ?? 0) >= 20;
  return hardware !== null;
}

export function useEnvironment() {
  const [state, setState] = useState<EnvironmentState | null>(null);
  const [profile, setProfile] = useState<EnvironmentProfile>('conservative');
  const [installRoot, setInstallRoot] = useState('');
  const [pending, setPending] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const operationRef = useRef<symbol | null>(null);
  const cancelOperationRef = useRef<symbol | null>(null);
  const initialReadRef = useRef<symbol | null>(null);
  const stateRef = useRef<EnvironmentState | null>(null);
  const profileRef = useRef<EnvironmentProfile>('conservative');
  const installRootRef = useRef('');

  const applyState = useCallback((next: EnvironmentState): void => {
    if (!mountedRef.current) return;
    stateRef.current = next;
    installRootRef.current = next.installRoot;
    const preferred = next.selection?.profile ?? next.config?.profile ?? profileRef.current;
    const allowed =
      next.hardware === null || isEnvironmentProfileAllowed(preferred, next.hardware)
        ? preferred
        : 'conservative';
    profileRef.current = allowed;
    setState(next);
    setInstallRoot(next.installRoot);
    setProfile(allowed);
  }, []);

  const execute = useCallback(
    async (
      operation: EnvironmentOperation,
      action: () => Promise<EnvironmentState>,
    ): Promise<boolean> => {
      if (operationRef.current !== null || stateRef.current?.active) return false;

      const token = Symbol(operation);
      const generation = generationRef.current;
      operationRef.current = token;
      if (mountedRef.current) {
        setPending(true);
        setError(null);
      }
      try {
        const next = await action();
        if (generation === generationRef.current) applyState(next);
        return true;
      } catch (caught) {
        if (mountedRef.current && generation === generationRef.current) {
          setError(errorMessage(caught));
        }
        return true;
      } finally {
        if (operationRef.current === token) operationRef.current = null;
        if (mountedRef.current && generation === generationRef.current) {
          setPending(false);
        }
      }
    },
    [applyState],
  );

  const detect = useCallback(
    () => execute('detect', () => window.smo.environment.detect(installRootRef.current)),
    [execute],
  );
  const start = useCallback(
    () =>
      execute('start', () =>
        window.smo.environment.start({
          profileId: profileRef.current,
          installRoot: installRootRef.current,
        }),
      ),
    [execute],
  );
  const retry = useCallback(
    () =>
      execute('retry', () =>
        window.smo.environment.retry({
          profileId: profileRef.current,
          installRoot: installRootRef.current,
        }),
      ),
    [execute],
  );
  const cancel = useCallback(
    async (): Promise<boolean> => {
      if (cancelOperationRef.current !== null) return false;
      const token = Symbol('cancel');
      const generation = generationRef.current;
      cancelOperationRef.current = token;
      if (mountedRef.current) {
        setCancelling(true);
        setError(null);
      }
      try {
        const next = await window.smo.environment.cancel();
        if (generation === generationRef.current) applyState(next);
        return true;
      } catch (caught) {
        if (mountedRef.current && generation === generationRef.current) {
          setError(errorMessage(caught));
        }
        return true;
      } finally {
        if (cancelOperationRef.current === token) cancelOperationRef.current = null;
        if (mountedRef.current && generation === generationRef.current) {
          setCancelling(false);
        }
      }
    },
    [applyState],
  );

  const changeProfile = useCallback((next: EnvironmentProfile): void => {
    profileRef.current = next;
    if (mountedRef.current) setProfile(next);
  }, []);
  const changeInstallRoot = useCallback((next: string): void => {
    installRootRef.current = next;
    if (mountedRef.current) setInstallRoot(next);
  }, []);

  const readInitial = useCallback(async (): Promise<void> => {
    if (initialReadRef.current !== null) return;
    const token = Symbol('read-initial');
    const generation = generationRef.current;
    initialReadRef.current = token;
    if (mountedRef.current) {
      setInitializing(true);
      setError(null);
    }
    const isCurrent = () => mountedRef.current && generation === generationRef.current;

    try {
      const initial = await window.smo.environment.getState();
      if (!isCurrent()) return;
      applyState(initial);

      if (
        !initial.active &&
        (initial.config === null || initial.config.status !== 'ready')
      ) {
        await detect();
        return;
      }

      if (initial.config?.status === 'ready' && !initial.healthy) {
        try {
          await window.smo.comfy.health();
          if (!isCurrent()) return;
          applyState({ ...initial, stage: 'ready', healthy: true, error: null });
        } catch {
          if (!isCurrent()) return;
          const executed = await retry();
          if (isCurrent() && !executed && stateRef.current?.active !== true) {
            setError('环境恢复未能启动，请点击“重试安装”。');
          }
        }
      }
    } catch (caught) {
      if (isCurrent()) setError(errorMessage(caught));
    } finally {
      if (initialReadRef.current === token) initialReadRef.current = null;
      if (isCurrent()) setInitializing(false);
    }
  }, [applyState, detect, retry]);

  useEffect(() => {
    const generation = ++generationRef.current;
    mountedRef.current = true;
    void readInitial();
    return () => {
      mountedRef.current = false;
      if (generationRef.current === generation) generationRef.current += 1;
      operationRef.current = null;
      cancelOperationRef.current = null;
      initialReadRef.current = null;
    };
  }, [readInitial]);

  useEffect(() => {
    if (!state || (!state.active && !pending)) return;
    let cancelled = false;
    let polling = false;

    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const next = await window.smo.environment.getState();
        if (!cancelled) {
          applyState(next);
        }
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        polling = false;
      }
    };

    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyState, pending, state]);

  return {
    state,
    profile,
    installRoot,
    error,
    busy: pending || initializing || state?.active === true,
    cancelling,
    setProfile: changeProfile,
    setInstallRoot: changeInstallRoot,
    readInitial,
    detect,
    start,
    retry,
    cancel,
  };
}

export type EnvironmentController = ReturnType<typeof useEnvironment>;
