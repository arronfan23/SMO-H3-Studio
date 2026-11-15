import { useEffect, useState } from 'react';
import type { Work } from '../shared/types';

export function useWorkResult(jobId: string | null): Work | null {
  const [work, setWork] = useState<Work | null>(null);

  useEffect(() => {
    if (jobId === null) {
      setWork(null);
      return;
    }

    let active = true;
    let timer: number | null = null;
    const read = async (): Promise<void> => {
      try {
        const works = await window.smo.works.list();
        if (!active) return;
        const current = works.find((candidate) => candidate.id === jobId) ?? null;
        setWork(current);
        if (current?.status === 'done' || current?.status === 'failed') return;
      } catch {
        // Keep retrying transient repository reads without replacing the result.
      }
      if (active) timer = window.setTimeout(read, 500);
    };

    setWork(null);
    void read();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [jobId]);

  return work;
}
