import { afterEach, describe, expect, it, vi } from 'vitest';
import { canAll, canWrite, deniedReason, loadMe, me, meError, parseMe } from './me';

// The contract example (docs/api-contract.md §3.1).
const example = {
  user: { sub: 'CgR0ZXN0EgVsb2NhbA', email: 'alice@example.com', name: 'Alice' },
  role: 'write',
  authEnabled: true,
  settings: {
    defaultNamespace: 'default',
    showSystemNamespace: false,
    disabledActions: [],
    codec: { endpoint: '', includeCredentials: false, defaultErrorMessage: '', defaultErrorLink: '' },
    limits: { scanMaxWorkflows: 200, fanoutMaxNamespaces: 50, pageSizeMax: 100, graphDepthMax: 3 },
    version: '0.1.0',
  },
};

describe('parseMe', () => {
  it('accepts the contract example unchanged', () => {
    expect(parseMe(example)).toEqual(example);
  });

  it('accepts a null user with auth disabled', () => {
    const m = parseMe({ ...example, user: null, authEnabled: false, role: 'read' });
    expect(m.user).toBeNull();
    expect(m.authEnabled).toBe(false);
  });

  it('accepts the admin role', () => {
    expect(parseMe({ ...example, role: 'admin' }).role).toBe('admin');
  });

  it('rejects a missing or unknown role', () => {
    expect(() => parseMe({ ...example, role: 'root' })).toThrow(/role/);
    expect(() => parseMe({ settings: {} })).toThrow(/role/);
    expect(() => parseMe(null)).toThrow();
    expect(() => parseMe([])).toThrow();
  });

  it('keeps only known disabled actions in contract order', () => {
    const m = parseMe({ ...example, settings: { ...example.settings, disabledActions: ['start', 'bogus', 'terminate'] } });
    expect(m.settings.disabledActions).toEqual(['terminate', 'start']);
  });

  it('knows the tenth action, nexus, in contract order', () => {
    const m = parseMe({ ...example, settings: { ...example.settings, disabledActions: ['nexus', 'schedule', 'terminate'] } });
    expect(m.settings.disabledActions).toEqual(['terminate', 'schedule', 'nexus']);
    expect(canAll(['nexus'], m)).toBe(false);
    expect(canAll(['nexus'], parseMe(example))).toBe(true);
  });

  it('defaults missing settings', () => {
    const m = parseMe({ role: 'read' });
    expect(m.settings.defaultNamespace).toBe('default');
    expect(m.settings.limits.pageSizeMax).toBe(100);
    expect(m.settings.codec.endpoint).toBe('');
  });
});

describe('canWrite', () => {
  it('requires the write role and an enabled action', () => {
    const writer = parseMe({ ...example, settings: { ...example.settings, disabledActions: ['reset'] } });
    expect(canWrite('terminate', writer)).toBe(true);
    expect(canWrite('reset', writer)).toBe(false);
    expect(canWrite('terminate', parseMe({ ...example, role: 'read' }))).toBe(false);
    expect(canWrite('terminate', null)).toBe(false);
  });

  it('lets admin run write and admin actions, and writers only write ones', () => {
    const admin = parseMe({ ...example, role: 'admin' });
    expect(canWrite('terminate', admin)).toBe(true);
    expect(canWrite('namespace', admin)).toBe(true);
    // The server lists the admin-only actions as disabled for writers.
    const writer = parseMe({ ...example, settings: { ...example.settings, disabledActions: ['namespace', 'searchAttribute', 'batchDelete'] } });
    expect(canWrite('delete', writer)).toBe(true);
    expect(canWrite('namespace', writer)).toBe(false);
    expect(deniedReason(['namespace'], writer)).toMatch(/admin/);
  });
});

describe('loadMe', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    me.value = null;
    meError.value = null;
  });

  it('stores the parsed body', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(example))));
    await loadMe();
    expect(me.value?.user?.email).toBe('alice@example.com');
    expect(meError.value).toBeNull();
  });

  it('records HTTP and validation failures', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":14,"message":"down"}', { status: 503 })));
    await loadMe();
    expect(me.value).toBeNull();
    expect(meError.value?.message).toBe('down');

    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response('{"role":"root"}')));
    await loadMe();
    expect(meError.value?.message).toMatch(/role/);
  });
});
