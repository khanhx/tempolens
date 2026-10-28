import { useState } from 'preact/hooks';

/** Copies `text` to the clipboard and confirms briefly. */
export function CopyButton({ text, label = 'Copy' }: { text: string | (() => string); label?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
      setState('done');
    } catch {
      setState('error');
    }
    window.setTimeout(() => setState('idle'), 1500);
  };
  return (
    <button type="button" class="btn btn-ghost btn-sm" onClick={copy} title={label} aria-label={label}>
      {state === 'done' ? 'Copied' : state === 'error' ? 'Copy failed' : label}
    </button>
  );
}
