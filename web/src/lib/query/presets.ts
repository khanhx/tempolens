// User-saved list views, per namespace, in localStorage (upstream keeps 50
// per namespace too). A preset is just a query plus a range.

export interface Preset {
  name: string;
  query: string;
  range: string;
}

export const MAX_PRESETS = 50;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

const key = (ns: string) => `tempolens.presets.${ns}`;

const isPreset = (v: unknown): v is Preset =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Preset).name === 'string' &&
  typeof (v as Preset).query === 'string' &&
  typeof (v as Preset).range === 'string';

export function listPresets(ns: string, storage: StorageLike | undefined = defaultStorage()): Preset[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(key(ns)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isPreset).slice(0, MAX_PRESETS) : [];
  } catch {
    return [];
  }
}

function write(ns: string, presets: Preset[], storage: StorageLike | undefined): void {
  if (!storage) throw new Error('Browser storage is not available, so presets cannot be saved.');
  storage.setItem(key(ns), JSON.stringify(presets));
}

/** Saves a preset, replacing one with the same name. Throws when the name is empty or the limit is reached. */
export function savePreset(ns: string, preset: Preset, storage: StorageLike | undefined = defaultStorage()): Preset[] {
  const name = preset.name.trim();
  if (!name) throw new Error('A preset needs a name.');
  const current = listPresets(ns, storage);
  const rest = current.filter((p) => p.name !== name);
  if (rest.length >= MAX_PRESETS) throw new Error(`At most ${MAX_PRESETS} presets per namespace.`);
  const next = [...rest, { name, query: preset.query, range: preset.range }];
  write(ns, next, storage);
  return next;
}

export function deletePreset(ns: string, name: string, storage: StorageLike | undefined = defaultStorage()): Preset[] {
  const next = listPresets(ns, storage).filter((p) => p.name !== name);
  write(ns, next, storage);
  return next;
}
