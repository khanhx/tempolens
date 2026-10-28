import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Sort } from '../lib/query/url-state';

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
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: Sort | null;
  onSort?: (column: string) => void;
  empty?: ComponentChildren;
  /** Fixed row height in px; rows are virtualized with it. */
  rowHeight?: number;
  caption?: string;
}

const OVERSCAN = 12;

/**
 * Table with a sticky header and virtualized rows: only the rows in view
 * (plus a margin) are in the DOM, so 1,000 rows cost as much as 40.
 */
export function DataTable<T>({ columns, rows, rowKey, sort, onSort, empty, rowHeight = 32, caption }: DataTableProps<T>) {
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
              const active = sort?.column === c.id ? sort.dir : null;
              return (
                <th key={c.id} scope="col" aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}>
                  {c.sortable && onSort ? (
                    <button type="button" class="dt-sort" onClick={() => onSort(c.id)} title={`Sort by ${c.label}`}>
                      {c.label}
                      <span aria-hidden="true">{active === 'asc' ? ' ▲' : active === 'desc' ? ' ▼' : ''}</span>
                    </button>
                  ) : (
                    (c.header ?? c.label)
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

/** Checkbox menu for choosing visible columns; order follows `all`. */
export function ColumnPicker({
  all,
  visible,
  onChange,
}: {
  all: { id: string; label: string }[];
  visible: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    const next = visible.includes(id) ? visible.filter((v) => v !== id) : [...visible, id];
    onChange(all.map((c) => c.id).filter((c) => next.includes(c)));
  };
  return (
    <details class="menu">
      <summary class="btn">Columns</summary>
      <div class="menu-panel" role="group" aria-label="Visible columns">
        {all.map((c) => (
          <label key={c.id} class="menu-item">
            <input type="checkbox" checked={visible.includes(c.id)} onChange={() => toggle(c.id)} /> {c.label}
          </label>
        ))}
      </div>
    </details>
  );
}
