import { describe, expect, it } from 'vitest';
import { applyTheme, isAutoRefreshPeriod, nextTheme, persistedSignal } from './prefs';

class MemoryStorage {
  readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const isNumber = (v: unknown): v is number => typeof v === 'number';

describe('persistedSignal', () => {
  it('reads a valid stored value and writes changes back', () => {
    const storage = new MemoryStorage();
    storage.setItem('tempolens.n', '7');
    const s = persistedSignal('n', 0, isNumber, storage);
    expect(s.value).toBe(7);
    s.value = 9;
    expect(storage.getItem('tempolens.n')).toBe('9');
  });

  it('falls back on missing, invalid or corrupt values', () => {
    const storage = new MemoryStorage();
    expect(persistedSignal('missing', 1, isNumber, storage).value).toBe(1);
    storage.setItem('tempolens.wrongType', '"text"');
    expect(persistedSignal('wrongType', 2, isNumber, storage).value).toBe(2);
    storage.setItem('tempolens.corrupt', '{not json');
    expect(persistedSignal('corrupt', 3, isNumber, storage).value).toBe(3);
  });

  it('works without storage and survives a throwing setItem', () => {
    expect(persistedSignal('none', 4, isNumber, undefined).value).toBe(4);
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const s = persistedSignal('q', 5, isNumber, throwing);
    s.value = 6;
    expect(s.value).toBe(6);
  });
});

describe('auto-refresh period', () => {
  it('accepts off, 5, 15 and 60 seconds only', () => {
    for (const v of [0, 5, 15, 60]) expect(isAutoRefreshPeriod(v)).toBe(true);
    for (const v of [1, 30, '5', null]) expect(isAutoRefreshPeriod(v)).toBe(false);
  });

  it('reads a stored 5 s period', () => {
    const storage = new MemoryStorage();
    storage.setItem('tempolens.autoRefresh', '5');
    expect(persistedSignal('autoRefresh', 0, isAutoRefreshPeriod, storage).value).toBe(5);
  });
});

describe('theme helpers', () => {
  it('cycles system → light → dark → system', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
  });

  it('pins or unpins data-theme', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('system', root);
    expect(root.dataset.theme).toBeUndefined();
  });
});
