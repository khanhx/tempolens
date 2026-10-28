import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Sort } from '../lib/query/url-state';
import { dropColumn, moveColumn, pickerOrder } from '../lib/table/columns';

export interface Column<T> {
  id: string;
  label: string;
  /** Header content instead of the label (the label still names the column for assistive tech). */
  header?: ComponentChildren;
  /** CSS width, e.g. `140px` or `20%`. */
  width?: string;
  render: (row: T) => ComponentChildren;
  /** Tooltip text for the cell. */
  title?: (row: T) => string;
  sortable?: boolean;
  /** Short tag shown after the label, e.g. `memo`. */
  tag?: string;
  /** Tooltip for the header. */
  hint?: string;
  /** The header can be dragged onto another movable header. */
  movable?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: Sort | null;
  onSort?: (column: string) => void;
  /** Called when a movable header is dropped before or after another. */
  onMove?: (column: string, target: string, after: boolean) => void;
  empty?: ComponentChildren;
  /** Fixed row height in px; rows are virtualized with it. */
  rowHeight?: number;
  caption?: string;
}

/** True when the pointer is over the right half of `el`. */
const afterHalf = (e: DragEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientX > r.left + r.width / 2;
};

/** Native drag-and-drop over a list of ids; `drop` is the indicator position. */
function useDragOrder(onDrop: (id: string, target: string, after: boolean) => void, vertical = false) {
  const dragged = useRef<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const isAfter = (e: DragEvent) => {
    if (!vertical) return afterHalf(e);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };
  const props = (id: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      dragged.current = id;
      e.dataTransfer?.setData('text/plain', id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (e: DragEvent) => {
      if (dragged.current === null || dragged.current === id) return;
      e.preventDefault();
      const after = isAfter(e);
      if (drop?.id !== id || drop.after !== after) setDrop({ id, after });
    },
    onDragLeave: () => drop?.id === id && setDrop(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const from = dragged.current;
      if (from !== null && from !== id) onDrop(from, id, isAfter(e));
      dragged.current = null;
      setDrop(null);
    },
    onDragEnd: () => {
      dragged.current = null;
      setDrop(null);
    },
  });
  const dropClass = (id: string) => (drop?.id === id ? (drop.after ? 'drop-after' : 'drop-before') : undefined);
  return { props, dropClass };
}

const OVERSCAN = 12;

/**
 * Table with a sticky header and virtualized rows: only the rows in view
 * (plus a margin) are in the DOM, so 1,000 rows cost as much as 40.
 */
export function DataTable<T>({ columns, rows, rowKey, sort, onSort, onMove, empty, rowHeight = 32, caption }: DataTableProps<T>) {
  const drag = useDragOrder((id, target, after) => onMove?.(id, target, after));
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(800);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // A new row set starts at the top.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [rows]);

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);
  const visible = rows.slice(start, end);

  return (
    <div class="dt-scroll" ref={scroller} onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}>
      <table class="dt">
        {caption && <caption class="visually-hidden">{caption}</caption>}
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = !!(c.sortable && onSort);
              const active = sortable && sort?.column === c.id ? sort.dir : null;
              const label = (
                <>
                  {c.label}
                  {c.tag && <span class="dt-tag">{c.tag}</span>}
                </>
              );
              return (
                <th
                  key={c.id}
                  scope="col"
                  title={c.hint}
                  aria-sort={!sortable ? undefined : active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
                  class={c.movable && onMove ? drag.dropClass(c.id) : undefined}
                  {...(c.movable && onMove ? drag.props(c.id) : {})}
                >
                  {sortable ? (
                    <button type="button" class="dt-sort" onClick={() => onSort?.(c.id)} title={`Sort by ${c.label}`} aria-label={`Sort by ${c.label}`}>
                      {label}
                      <span aria-hidden="true">{active === 'asc' ? ' ▲' : active === 'desc' ? ' ▼' : ''}</span>
                    </button>
                  ) : (
                    (c.header ?? label)
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} class="dt-empty">
                {empty ?? 'No rows.'}
              </td>
            </tr>
          )}
          {start > 0 && <tr aria-hidden="true" style={{ height: `${start * rowHeight}px` }} />}
          {visible.map((row) => (
            <tr key={rowKey(row)} style={{ height: `${rowHeight}px` }}>
              {columns.map((c) => (
                <td key={c.id} title={c.title?.(row)}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
          {end < rows.length && <tr aria-hidden="true" style={{ height: `${(rows.length - end) * rowHeight}px` }} />}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Menu for choosing and ordering columns: visible ones first in their order,
 * each draggable with Move up/down buttons, then hidden ones alphabetically.
 */
export function ColumnPicker({
  all,
  visible,
  onChange,
  onReset,
  children,
}: {
  all: { id: string; label: string; tag?: string }[];
  visible: string[];
  onChange: (ids: string[]) => void;
  onReset: () => void;
  /** Extra controls at the end of the menu. */
  children?: ComponentChildren;
}) {
  const { shown, hidden } = pickerOrder(all, visible);
  const drag = useDragOrder((id, target, after) => onChange(dropColumn(visible, id, target, after)), true);
  const tag = (c: { tag?: string }) => c.tag && <span class="dt-tag">{c.tag}</span>;
  const move = (id: string, by: number) => onChange(moveColumn(visible, id, visible.indexOf(id) + by));
  return (
    <details class="menu">
      <summary class="btn">Columns</summary>
      <div class="menu-panel column-picker" role="group" aria-label="Visible columns">
        <ul class="column-list" aria-label="Shown columns">
          {shown.map((c, i) => (
            <li key={c.id} class={`menu-item ${drag.dropClass(c.id) ?? ''}`} {...drag.props(c.id)}>
              <label>
                <span class="drag-handle" aria-hidden="true">
                  ⠿
                </span>
                {/* The last visible column stays: an empty table has nothing to show. */}
                <input type="checkbox" checked disabled={shown.length === 1} onChange={() => onChange(visible.filter((v) => v !== c.id))} /> {c.label}
              </label>
              <span>
                {tag(c)}
                <button type="button" class="btn btn-ghost btn-sm" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => move(c.id, -1)}>
                  ↑
                </button>
                <button type="button" class="btn btn-ghost btn-sm" aria-label={`Move ${c.label} down`} disabled={i === shown.length - 1} onClick={() => move(c.id, 1)}>
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ul>
        {hidden.length > 0 && (
          <ul class="column-list" aria-label="Hidden columns">
            {hidden.map((c) => (
              <li key={c.id} class="menu-item">
                <label>
                  <input type="checkbox" checked={false} onChange={() => onChange([...visible, c.id])} /> {c.label}
                </label>
                {tag(c)}
              </li>
            ))}
          </ul>
        )}
        {children}
        <button type="button" class="btn btn-sm" onClick={onReset}>
          Reset columns
        </button>
      </div>
    </details>
  );
}
