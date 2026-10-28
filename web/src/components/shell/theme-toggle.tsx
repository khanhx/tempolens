import type { Theme } from '../../lib/prefs';
import { nextTheme, theme } from '../../lib/prefs';

const LABELS: Record<Theme, { icon: string; text: string }> = {
  system: { icon: '◐', text: 'System' },
  light: { icon: '☀', text: 'Light' },
  dark: { icon: '☾', text: 'Dark' },
};

/** Cycles system → light → dark; the choice persists in localStorage. */
export function ThemeToggle() {
  const current = LABELS[theme.value];
  const next = LABELS[nextTheme(theme.value)];
  return (
    <button
      type="button"
      class="btn btn-ghost"
      title={`Theme: ${current.text}. Switch to ${next.text}.`}
      aria-label={`Theme: ${current.text}. Switch to ${next.text}.`}
      onClick={() => (theme.value = nextTheme(theme.value))}
    >
      <span aria-hidden="true">{current.icon}</span>
      {current.text}
    </button>
  );
}
