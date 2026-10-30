import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  EnvironmentProfile,
  EnvironmentState,
} from '../shared/environment';
import type { HardwareInfo } from '../shared/types';
import { errorMessage } from './ui';

const POLL_INTERVAL_MS = 750;

type EnvironmentOperation = 'detect' | 'start' | 'retry' | 'cancel';

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
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const operationRef = useRef<symbol | null>(null);
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
    ): Promise<void> => {
      if (operationRef.current !== null) return;
      if (stateRef.current?.active && operation !== 'cancel') return;

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
      } catch (caught) {
        if (mountedRef.current && generation === generationRef.current) {
          setError(errorMessage(caught));
        }
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
    () => execute('cancel', () => window.smo.environment.cancel()),
    [execute],
  );

  const changeProfile = useCallback((next: EnvironmentProfile): void => {
    profileRef.current = next;
    if (mountedRef.current) setProfile(next);
  }, []);
  const changeInstallRoot = useCallback((next: string): void => {
    installRootRef.current = next;
    if (mountedRef.current) setInstallRoot(next);
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    mountedRef.current = true;
    const isCurrent = () => mountedRef.current && generation === generationRef.current;

    const initialize = async (): Promise<void> => {
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
          setPending(true);
          try {
            await window.smo.comfy.health();
            if (!isCurrent()) return;
            applyState({ ...initial, stage: 'ready', healthy: true, error: null });
          } catch {
            if (!isCurrent()) return;
            setPending(false);
            await retry();
          } finally {
            if (isCurrent()) setPending(false);
          }
        }
      } catch (caught) {
        if (isCurrent()) setError(errorMessage(caught));
      }
    };

    void initialize();
    return () => {
      mountedRef.current = false;
      if (generationRef.current === generation) generationRef.current += 1;
      operationRef.current = null;
    };
  }, [applyState, detect, retry]);

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
          setError(null);
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
    busy: pending || state?.active === true,
    setProfile: changeProfile,
    setInstallRoot: changeInstallRoot,
    detect,
    start,
    retry,
    cancel,
  };
}

export type EnvironmentController = ReturnType<typeof useEnvironment>;
