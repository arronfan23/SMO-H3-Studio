import { useEffect, useState } from 'react';
import { errorMessage } from './ui';

interface ResolvedMedia {
  path: string;
  revision: number;
  url: string | null;
  error: string | null;
}

export function useMediaUrl(path: string | null, revision = 0): {
  url: string | null;
  error: string | null;
} {
  const [resolved, setResolved] = useState<ResolvedMedia | null>(null);

  useEffect(() => {
    if (path === null) {
      return;
    }
    let active = true;
    window.smo.files
      .mediaUrl(path)
      .then((url) => {
        if (active) {
          setResolved({ path, revision, url, error: null });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setResolved({ path, revision, url: null, error: errorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [path, revision]);

  return resolved?.path === path && resolved.revision === revision
    ? { url: resolved.url, error: resolved.error }
    : { url: null, error: null };
}
