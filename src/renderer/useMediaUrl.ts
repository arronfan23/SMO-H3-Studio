import { useEffect, useState } from 'react';
import { errorMessage } from './ui';

interface ResolvedMedia {
  path: string;
  url: string | null;
  error: string | null;
}

export function useMediaUrl(path: string | null): {
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
          setResolved({ path, url, error: null });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setResolved({ path, url: null, error: errorMessage(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [path]);

  return resolved?.path === path
    ? { url: resolved.url, error: resolved.error }
    : { url: null, error: null };
}
