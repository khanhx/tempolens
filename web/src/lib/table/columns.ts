// Column layout of the workflow list: ids, URL encoding, saved order and
// reordering. The order resolves URL > saved preference > default, and ids
// that no longer name a column are dropped when read.

const MEMO_PREFIX = 'memo:';

export const memoId = (key: string) => MEMO_PREFIX + key;
export const isMemoId = (id: string) => id.startsWith(MEMO_PREFIX) && id.length > MEMO_PREFIX.length;
export const memoKeyOf = (id: string) => id.slice(MEMO_PREFIX.length);

/** `cols` URL value: each id URI-encoded so a memo key may contain a comma. */
export const encodeColumns = (ids: readonly string[]) => ids.map(encodeURIComponent).join(',');

/** Ids from a `cols` URL value, deduplicated; null when there are none. */
export function decodeColumns(raw: string | null): string[] | null {
  if (raw === null) return null;
  const ids = raw.split(',').flatMap((part) => {
    try {
      const id = decodeURIComponent(part).trim();
      return id ? [id] : [];
    } catch {
      // A malformed escape is a stale or hand-edited link: skip that id.
      return [];
    }
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
