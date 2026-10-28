import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

/** Whether the shortcut help dialog is open. */
export const helpOpen = signal(false);

export const SHORTCUTS: readonly [string, string][] = [
  ['/', 'Focus the query input'],
  ['?', 'Show keyboard shortcuts'],
  ['← / →', 'Previous / next page of workflows'],
  ['r', 'Refresh the current view'],
  ['Esc', 'Close a dialog or leave an input'],
];

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');

export type ShortcutMap = Partial<Record<string, () => void>>;

/**
 * Binds single-key shortcuts while the component is mounted. Keys are
 * ignored while typing in a field, except Escape, and with modifier keys.
 */
export function useShortcuts(map: ShortcutMap): void {
  const current = useRef(map);
  current.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (e.key !== 'Escape' && isTyping(e.target)) return;
      const fn = current.current[e.key];
      if (fn) {
        // Escape keeps its default so native dialogs still close on it.
        if (e.key !== 'Escape') e.preventDefault();
        fn();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/** Focuses the element marked `data-shortcut-search`, if the page has one. */
export function focusSearch(): void {
  const el = document.querySelector<HTMLElement>('[data-shortcut-search]');
  el?.focus();
}
