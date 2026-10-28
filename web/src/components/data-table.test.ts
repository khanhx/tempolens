// @vitest-environment happy-dom
// Header sort state and names, header drag-and-drop, and the column picker's order and buttons.
import type { ComponentChild } from 'preact';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Column } from './data-table';
import { ColumnPicker, DataTable } from './data-table';

// happy-dom lacks the ondrag* properties browsers have, and without them Preact
// listens for mixed-case event names (`DragOver`) that never fire.
for (const name of ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend']) {
  if (!(`on${name}` in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, `on${name}`, { value: null, writable: true });
}

type Row = { id: string };
const col = (id: string, extra: Partial<Column<Row>> = {}): Column<Row> => ({ id, label: id.toUpperCase(), render: (r) => r.id, ...extra });

function mount(vnode: ComponentChild): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  act(() => render(vnode, root));
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('DataTable header', () => {
  it('marks only the active sortable header with a direction', () => {
    const onSort = vi.fn();
    const root = mount(
      h(DataTable<Row>, {
        columns: [col('a', { sortable: true }), col('b', { sortable: true }), col('c', { tag: 'memo', hint: 'not server-filterable' })],
        rows: [{ id: 'x' }],
        rowKey: (r) => r.id,
        sort: { column: 'b', dir: 'desc' },
        onSort,
      }),
    );
    const [a, b, c] = [...root.querySelectorAll('th')];
    expect(a?.getAttribute('aria-sort')).toBe('none');
    expect(b?.getAttribute('aria-sort')).toBe('descending');
    expect(b?.textContent).toContain('▼');
    expect(c?.hasAttribute('aria-sort')).toBe(false);
    expect(c?.getAttribute('title')).toBe('not server-filterable');
    expect(c?.querySelector('.dt-tag')?.textContent).toBe('memo');

    const button = root.querySelector<HTMLButtonElement>('button[aria-label="Sort by A"]');
    expect(button?.title).toBe('Sort by A');
    act(() => button?.click());
    expect(onSort).toHaveBeenCalledWith('a');
  });

  it('reports a header dropped onto another movable header', () => {
    const onMove = vi.fn();
    const root = mount(
      h(DataTable<Row>, { columns: [col('a', { movable: true }), col('b', { movable: true }), col('sel')], rows: [], rowKey: (r) => r.id, onMove }),
    );
    const [a, b, sel] = [...root.querySelectorAll('th')];
    expect(a?.getAttribute('draggable')).toBe('true');
    expect(sel?.hasAttribute('draggable')).toBe(false);
    act(() => {
      a?.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    act(() => {
      b?.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
    });
    expect(b?.className).toMatch(/drop-(before|after)/);
    act(() => {
      b?.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    expect(onMove).toHaveBeenCalledWith('a', 'b', expect.any(Boolean));
    expect(b?.className ?? '').not.toMatch(/drop-/);
  });
});

describe('ColumnPicker', () => {
  const all = [
    { id: 'status', label: 'Status' },
    { id: 'id', label: 'Workflow ID' },
    { id: 'run', label: 'Run ID' },
    { id: 'memo:owner', label: 'owner', tag: 'memo' },
  ];

  function picker(visible: string[]) {
    const onChange = vi.fn();
    const onReset = vi.fn();
    const root = mount(h(ColumnPicker, { all, visible, onChange, onReset }));
    const button = (name: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
    return { root, onChange, onReset, button };
  }

  it('lists visible columns in order, then hidden ones alphabetically', () => {
    const { root } = picker(['run', 'status']);
    const labels = (list: string) => [...root.querySelectorAll(`ul[aria-label="${list}"] label`)].map((l) => l.textContent?.trim());
    expect(root.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Visible columns');
    expect(labels('Shown columns')).toEqual(['⠿ Run ID', '⠿ Status']);
    expect(labels('Hidden columns')).toEqual(['owner', 'Workflow ID']);
  });

  it('moves columns with the up and down buttons, disabled at the ends', () => {
    const { onChange, button } = picker(['run', 'status', 'id']);
    expect(button('Move Run ID up')?.disabled).toBe(true);
    expect(button('Move Workflow ID down')?.disabled).toBe(true);
    act(() => button('Move Run ID down')?.click());
    expect(onChange).toHaveBeenLastCalledWith(['status', 'run', 'id']);
    act(() => button('Move Workflow ID up')?.click());
    expect(onChange).toHaveBeenLastCalledWith(['run', 'id', 'status']);
  });

  it('adds, removes and resets columns', () => {
    const { root, onChange, onReset } = picker(['run', 'status']);
    const box = (label: string) => [...root.querySelectorAll('label')].find((l) => l.textContent?.trim().endsWith(label))?.querySelector('input');
    act(() => box('owner')?.click());
    expect(onChange).toHaveBeenLastCalledWith(['run', 'status', 'memo:owner']);
    act(() => box('Status')?.click());
    expect(onChange).toHaveBeenLastCalledWith(['run']);
    act(() => [...root.querySelectorAll('button')].find((b) => b.textContent === 'Reset columns')?.click());
    expect(onReset).toHaveBeenCalled();
  });

  it('keeps the last visible column', () => {
    const { root } = picker(['run']);
    expect(root.querySelector<HTMLInputElement>('ul[aria-label="Shown columns"] input')?.disabled).toBe(true);
  });
});
