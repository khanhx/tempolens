// Session-local command history for the console input, kept in
// sessionStorage so it survives a reload but not the tab.

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const HISTORY_KEY = 'tempolens.console.history';
export const HISTORY_LIMIT = 100;

function defaultStorage(): Store | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    // Storage disabled by the browser.
    return undefined;
  }
}

export interface History {
  /** Oldest first. */
  entries(): string[];
  /** Appends `line` unless it is blank or repeats the newest entry; keeps the newest `limit`. */
  push(line: string): void;
  clear(): void;
}

export function createHistory(storage: Store | undefined = defaultStorage(), key = HISTORY_KEY, limit = HISTORY_LIMIT): History {
  let memory: string[] = [];
  const read = (): string[] => {
    if (!storage) return memory;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string').slice(-limit) : [];
    } catch {
      return [];
    }
  };
  const write = (list: string[]) => {
    memory = list;
    try {
      storage?.setItem(key, JSON.stringify(list));
    } catch {
      // Quota or privacy mode: keep the in-memory copy.
    }
  };
  return {
    entries: read,
    push(line) {
      const text = line.trim();
      if (!text) return;
      const list = read();
      if (list.at(-1) === text) return;
      write([...list, text].slice(-limit));
    },
    clear: () => write([]),
  };
}

/**
 * Moves through `entries` from `index` (null = the line being typed). Up
 * goes to older entries and stops at the oldest; down goes to newer ones
 * and returns to null after the newest.
 */
export function recall(entries: readonly string[], index: number | null, dir: 'up' | 'down'): number | null {
  if (entries.length === 0) return null;
  if (dir === 'up') return index === null ? entries.length - 1 : Math.max(0, index - 1);
  if (index === null) return null;
  return index + 1 < entries.length ? index + 1 : null;
}
