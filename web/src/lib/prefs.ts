import type { Signal } from '@preact/signals';
import { effect, signal } from '@preact/signals';

export type Theme = 'system' | 'light' | 'dark';
export type TimeMode = 'relative' | 'absolute';
export type TimeZoneMode = 'local' | 'utc';

const KEY_PREFIX = 'tempolens.';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    // Access throws when storage is disabled; preferences then last for the session only.
    return undefined;
  }
}

/**
 * A signal backed by localStorage under `tempolens.<key>`. A stored value that
 * fails `valid` (corrupt, or from an older version) falls back to `fallback`.
 */
export function persistedSignal<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
  storage: StorageLike | undefined = defaultStorage(),
): Signal<T> {
  const storageKey = KEY_PREFIX + key;
  let initial = fallback;
  try {
    const raw = storage?.getItem(storageKey);
    if (raw != null) {
      const parsed: unknown = JSON.parse(raw);
      if (valid(parsed)) initial = parsed;
    }
  } catch {
    // Corrupt JSON: keep the fallback.
  }
  const s = signal(initial);
  effect(() => {
    const value = s.value;
    try {
      storage?.setItem(storageKey, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage disabled: the in-memory value still applies.
    }
  });
  return s;
}

const oneOf =
  <T extends string>(...values: readonly T[]) =>
  (v: unknown): v is T =>
    typeof v === 'string' && (values as readonly string[]).includes(v);

const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isNamespaceOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v !== '');

export const theme = persistedSignal<Theme>('theme', 'system', oneOf('system', 'light', 'dark'));
export const timeMode = persistedSignal<TimeMode>('timeMode', 'relative', oneOf('relative', 'absolute'));
export const timeZone = persistedSignal<TimeZoneMode>('timeZone', 'local', oneOf('local', 'utc'));
export const navCollapsed = persistedSignal<boolean>('navCollapsed', false, isBoolean);
export const lastNamespace = persistedSignal<string | null>('lastNamespace', null, isNamespaceOrNull);
/** Workflow-list auto-refresh period in seconds; 0 is off. */
export const autoRefresh = persistedSignal<0 | 15 | 60>('autoRefresh', 0, (v): v is 0 | 15 | 60 => v === 0 || v === 15 || v === 60);
/** Workflow list as a table or a multi-run timeline. */
export const listView = persistedSignal<'table' | 'timeline'>('listView', 'table', oneOf('table', 'timeline'));
/** History view mode, as upstream's `eventView`. */
export const eventView = persistedSignal<'compact' | 'full' | 'json'>('eventView', 'compact', oneOf('compact', 'full', 'json'));

const THEME_ORDER: readonly Theme[] = ['system', 'light', 'dark'];

export function nextTheme(current: Theme): Theme {
  return THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length] ?? 'system';
}

/** Pins the colour scheme on <html>; 'system' removes the pin so prefers-color-scheme applies. */
export function applyTheme(value: Theme, root: HTMLElement = document.documentElement): void {
  if (value === 'system') delete root.dataset.theme;
  else root.dataset.theme = value;
}
