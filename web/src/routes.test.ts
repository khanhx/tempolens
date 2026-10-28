import { exec } from 'preact-iso/router';
import { describe, expect, it } from 'vitest';
import { href, namespaceFromPath, P, switchNamespacePath } from './routes';

const sample: Record<string, string> = {
  ns: 'tui seed/a',
  wf: 'order/42 "x"',
  run: '0193e4c4-6f1e-7b5a-9d0c-7f1e2a3b4c5d',
  eventId: '7',
  mode: 'compact',
  id: 'sched%1',
  jobId: 'job-1',
  queue: 'tempolens-seed',
};

describe('href', () => {
  it('encodes each parameter exactly once', () => {
    expect(href(P.run, { ns: 'a b', wf: 'x/y', run: 'r1' })).toBe('/namespaces/a%20b/workflows/x%2Fy/r1');
    expect(href(P.workflows, { ns: 'default' }, { query: 'ExecutionStatus="Running"' })).toBe(
      '/namespaces/default/workflows?query=ExecutionStatus%3D%22Running%22',
    );
  });

  it('rejects an empty parameter', () => {
    expect(() => href(P.workflows, { ns: '' })).toThrow(/ns/);
  });

  it('round-trips every pattern through the router matcher', () => {
    for (const pattern of Object.values(P)) {
      const names = [...pattern.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string);
      const params = Object.fromEntries(names.map((n) => [n, sample[n] ?? n]));
      const url = href(pattern as string, params);
      const match = exec(url, pattern, { params: {} } as never) as { params: Record<string, string> } | undefined;
      expect(match, pattern).toBeDefined();
      expect(match?.params, pattern).toEqual(params);
    }
  });
});

describe('namespaceFromPath', () => {
  it('decodes the namespace segment', () => {
    expect(namespaceFromPath('/namespaces/tui-seed-a/workflows')).toBe('tui-seed-a');
    expect(namespaceFromPath('/namespaces/a%20b')).toBe('a b');
    expect(namespaceFromPath('/namespaces')).toBeNull();
    expect(namespaceFromPath('/workflows')).toBeNull();
    expect(namespaceFromPath('/namespaces/%E0%A4%A')).toBeNull();
  });
});

describe('switchNamespacePath', () => {
  it('keeps list sections and drops deeper pages', () => {
    expect(switchNamespacePath('/namespaces/a/schedules', 'b')).toBe('/namespaces/b/schedules');
    expect(switchNamespacePath('/namespaces/a/schedules/s1/edit', 'b')).toBe('/namespaces/b/schedules');
    expect(switchNamespacePath('/namespaces/a/workflows/wf/run/history', 'b c')).toBe('/namespaces/b%20c/workflows');
    expect(switchNamespacePath('/namespaces/a', 'b')).toBe('/namespaces/b/workflows');
    expect(switchNamespacePath('/workflows', 'b')).toBe('/namespaces/b/workflows');
  });
});
