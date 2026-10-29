// Column layout of the workflow list: ids, URL encoding, saved order and
// reordering. The order resolves URL > saved preference > default, and ids
// that no longer name a column are dropped when read.

const MEMO_PREFIX = 'memo:';

export const memoId = (key: string) => MEMO_PREFIX + key;
export const isMemoId = (id: string) => id.startsWith(MEMO_PREFIX) && id.length > MEMO_PREFIX.length;
export const memoKeyOf = (id: string) => id.slice(MEMO_PREFIX.length);

/** `cols` URL value: each id URI-encoded so a memo key may contain a comma. */
export const encodeColumns = (ids: readonly string[]) => ids.map(encodeURIComponent).join(',');

/** Percent-decodes one query-string piece, with `+` as a space; null when the escape is malformed. */
function queryDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

// What encodeURIComponent can produce. Base ids hold none of the escaped
// characters and `sa:`/`memo:` ids always hold a colon, so a value whose
// comma-separated parts all match is the list page's own doubly encoded form.
const ENCODED_ID = /^[\w\-.!~*'()%]*$/;

/**
 * Ids from the raw, still percent-encoded `cols` query value, deduplicated;
 * null when there are none. Three forms are read:
 * - literal commas (`status,sa:Foo`, `status,memo%3Ateam%2Cregion`): split, then decode each id once;
 * - the list page's form (`status%2Cmemo%253Ateam%252Cregion`): decode, split, decode each id again;
 * - one hand-encoded id (`memo%3Ateam%2Cregion`): decode once, so `%2C` stays inside the key.
 */
export function decodeColumns(raw: string | null): string[] | null {
  if (raw === null) return null;
  let parts = raw.split(',');
  if (parts.length === 1) {
    const value = queryDecode(raw);
    if (value === null) return null;
    const split = value.split(',');
    if (split.every((part) => ENCODED_ID.test(part))) parts = split;
  }
  // A malformed escape is a stale or hand-edited link: that id is skipped.
  const ids = parts.flatMap((part) => {
    const id = queryDecode(part)?.trim();
    return id ? [id] : [];
  });
  return ids.length ? [...new Set(ids)] : null;
}

/** The first source with at least one known id, in its order; unknown ids are dropped. */
export function resolveColumns(sources: readonly (readonly string[] | null)[], fallback: readonly string[], known: (id: string) => boolean): string[] {
  for (const source of sources) {
    const ids = [...new Set(source ?? [])].filter(known);
    if (ids.length) return ids;
  }
  return [...fallback];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Preference key; the all-namespaces view uses `*`. */
export const columnsKey = (ns: string) => `tempolens.columns.${ns}`;

export function loadColumns(ns: string, storage: StorageLike | undefined = defaultStorage()): string[] | null {
  try {
    const v: unknown = JSON.parse(storage?.getItem(columnsKey(ns)) ?? 'null');
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? v : null;
  } catch {
    return null;
  }
}

/** Saves the order, or forgets it when `ids` is null. Storage errors are ignored: the URL still carries the choice. */
export function saveColumns(ns: string, ids: readonly string[] | null, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    if (ids?.length) storage?.setItem(columnsKey(ns), JSON.stringify(ids));
    else storage?.removeItem(columnsKey(ns));
  } catch {
    // Quota exceeded or storage disabled.
  }
}

/** Column widths in px by column id. Absent ids keep their default width. */
export type ColumnWidths = Readonly<Record<string, number>>;

export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 2000;

/** `px` rounded and clamped to the allowed column width. */
export const clampWidth = (px: number) => Math.round(Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Number.isFinite(px) ? px : MIN_COLUMN_WIDTH)));

/** Widths preference key, beside the order under the same namespace key. Widths stay out of the URL to keep links short. */
export const widthsKey = (ns: string) => `${columnsKey(ns)}.widths`;

/** Saved widths; entries that are not numbers are dropped and the rest clamped. */
export function loadWidths(ns: string, storage: StorageLike | undefined = defaultStorage()): ColumnWidths {
  try {
    const v: unknown = JSON.parse(storage?.getItem(widthsKey(ns)) ?? 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [id, px] of Object.entries(v)) if (typeof px === 'number' && Number.isFinite(px)) out[id] = clampWidth(px);
    return out;
  } catch {
    return {};
  }
}

/** Saves the widths, or forgets them when there are none. Storage errors are ignored: the widths last for the page. */
export function saveWidths(ns: string, widths: ColumnWidths, storage: StorageLike | undefined = defaultStorage()): void {
  try {
    if (Object.keys(widths).length) storage?.setItem(widthsKey(ns), JSON.stringify(widths));
    else storage?.removeItem(widthsKey(ns));
  } catch {
    // Quota exceeded or storage disabled.
  }
}

/** `ids` with `id` moved to `index` (clamped); unchanged when `id` is absent. */
export function moveColumn(ids: readonly string[], id: string, index: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}

/** Drop of `id` onto `target`, before or after it. */
export function dropColumn(ids: readonly string[], id: string, target: string, after: boolean): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return [...ids];
  const rest = ids.filter((x) => x !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** Picker rows: visible columns in their order, then hidden ones alphabetically by label. */
export function pickerOrder<C extends { id: string; label: string }>(all: readonly C[], visible: readonly string[]): { shown: C[]; hidden: C[] } {
  const byId = new Map(all.map((c) => [c.id, c]));
  const shown = visible.map((id) => byId.get(id)).filter((c): c is C => !!c);
  const hidden = all.filter((c) => !visible.includes(c.id)).sort((a, b) => a.label.localeCompare(b.label));
  return { shown, hidden };
}

/** Memo keys present in the rows, sorted. */
export function memoKeys(rows: readonly { memo?: { fields?: Record<string, unknown> } }[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.memo?.fields ?? {})) keys.add(k);
  return [...keys].sort();
}
