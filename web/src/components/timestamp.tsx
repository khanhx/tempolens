import { signal } from '@preact/signals';
import { timeMode, timeZone } from '../lib/prefs';
import { formatAbsolute, formatDuration, formatTimestamp, parseTimestamp } from '../lib/time';

/** Ticks every 30 s so relative times stay current. Starts on first use. */
const now = signal(Date.now());
let ticking = false;
function useNow(): number {
  if (!ticking && typeof window !== 'undefined') {
    ticking = true;
    window.setInterval(() => (now.value = Date.now()), 30_000);
  }
  return now.value;
}

/** A timestamp in the user's time preferences, with the other form as a tooltip. */
export function Timestamp({ value }: { value: string | null | undefined }) {
  const current = useNow();
  const date = parseTimestamp(value);
  if (!date) return <span class="muted">–</span>;
  const text = formatTimestamp(date, { mode: timeMode.value, zone: timeZone.value, now: current });
  const title = timeMode.value === 'relative' ? formatAbsolute(date, timeZone.value) : formatTimestamp(date, { mode: 'relative', zone: timeZone.value, now: current });
  return (
    <time dateTime={date.toISOString()} title={title}>
      {text}
    </time>
  );
}

export function Duration({ ms }: { ms: number | null | undefined }) {
  return ms == null ? <span class="muted">–</span> : <span>{formatDuration(ms)}</span>;
}
