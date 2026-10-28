import { useEffect, useState } from 'preact/hooks';

/**
 * Loads a module on demand (when `enabled` turns true), so heavy dialogs
 * stay out of the page chunk. Returns null until loaded; a failure is
 * returned as an Error.
 */
export function useLazyModule<T>(load: () => Promise<T>, enabled: boolean): T | Error | null {
  const [mod, setMod] = useState<T | Error | null>(null);
  useEffect(() => {
    if (!enabled || mod) return;
    let cancelled = false;
    load().then(
      (m) => !cancelled && setMod(() => m),
      (err: unknown) => !cancelled && setMod(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return mod;
}
