import { signal } from '@preact/signals';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  href?: string;
  linkText?: string;
}

export const toasts = signal<Toast[]>([]);
let nextId = 1;

/** Shows a toast; it stays until dismissed or replaced unless `ttlMs` is set. Returns its id. */
export function showToast(t: Omit<Toast, 'id'>, ttlMs: number | null = 8000): number {
  const id = nextId++;
  toasts.value = [...toasts.value, { ...t, id }];
  if (ttlMs !== null) window.setTimeout(() => dismissToast(id), ttlMs);
  return id;
}

export function updateToast(id: number, patch: Partial<Omit<Toast, 'id'>>): void {
  toasts.value = toasts.value.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function Toasts() {
  if (toasts.value.length === 0) return null;
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast toast-${t.kind}`}>
          <span>{t.text}</span>
          {t.href && <a href={t.href}>{t.linkText ?? 'Open'}</a>}
          <button type="button" class="chip-remove" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
