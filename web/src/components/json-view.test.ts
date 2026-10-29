// @vitest-environment happy-dom
// "Expand all" opens every branch within a row budget, "Collapse all" leaves
// only the root open, and a large document expands breadth first with a notice.
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPAND_ALL_BUDGET, expandPlan, JsonView } from './json-view';

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(value: unknown, openDepth?: number): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  render(h(JsonView, { value, openDepth }), root);
  return root;
}

const button = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const collapsed = (root: HTMLElement) => root.querySelectorAll('.jv-toggle[aria-expanded="false"]').length;
const expanded = (root: HTMLElement) => root.querySelectorAll('.jv-toggle[aria-expanded="true"]').length;

const deep = { a: { b: { c: { d: { e: [1, 2, { f: 'x' }] } } } }, g: [] };

describe('expandPlan', () => {
  it('opens every non-empty branch of a small document', () => {
    const plan = expandPlan(deep);
    expect(plan.truncated).toBe(false);
    // root, a, b, c, d, e and the object inside e; the empty array is not a branch to open.
    expect(plan.open.size).toBe(7);
  });

  it('stops breadth first before the row budget', () => {
    const big = Array.from({ length: 150 }, (_, i) => ({ id: i, tags: ['a', 'b'], nested: { x: 1, y: 2 } }));
    const plan = expandPlan(big, 500);
    expect(plan.truncated).toBe(true);
    expect(plan.shown).toBeLessThanOrEqual(500);
    // The root (150 rows) and then whole items of 3 rows each fit.
    expect(plan.open.has(big)).toBe(true);
    expect(plan.shown).toBe(150 + 3 * 116);
  });

  it('ignores scalars', () => {
    expect(expandPlan('text')).toEqual({ open: new Set(), shown: 0, truncated: false });
  });
});

describe('JsonView expand and collapse', () => {
  it('expands every node, then collapses to the root', async () => {
    const root = mount(deep, 1);
    expect(collapsed(root)).toBe(1);
    await act(() => button(root, 'Expand all JSON nodes')?.click());
    expect(collapsed(root)).toBe(0);
    expect(expanded(root)).toBe(7);
    expect(root.textContent).toContain('"f": "x"');
    await act(() => button(root, 'Collapse all JSON nodes')?.click());
    expect(expanded(root)).toBe(1);
    expect(collapsed(root)).toBe(1);
  });

  it('caps a large document and says so', async () => {
    // 200 shown items of 20 keys each are well over the budget.
    const big = Array.from({ length: 1000 }, (_, i) => Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`k${k}`, { i, k }])));
    const root = mount(big, 0);
    await act(() => button(root, 'Expand all JSON nodes')?.click());
    const rows = root.querySelectorAll('.jv-row').length;
    expect(rows).toBeLessThanOrEqual(EXPAND_ALL_BUDGET);
    expect(root.querySelector('[role="status"]')?.textContent).toMatch(/expanded the first [\d,]+ values/);
  });

  it('keeps the buttons keyboard reachable and hides them for scalars', () => {
    const root = mount({ a: 1 });
    const expand = button(root, 'Expand all JSON nodes');
    expect(expand?.tagName).toBe('BUTTON');
    expect(expand?.textContent).toBe('Expand all');
    expect(button(root, 'Collapse all JSON nodes')?.textContent).toBe('Collapse all');
    const scalar = mount(42);
    expect(button(scalar, 'Expand all JSON nodes')).toBeNull();
  });
});
