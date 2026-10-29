import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Sort } from '../lib/query/url-state';
import type { ColumnWidths } from '../lib/table/columns';
import { clampWidth, dropColumn, MIN_COLUMN_WIDTH, moveColumn, pickerOrder } from '../lib/table/columns';

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
  /** The header has a resize handle on its right edge. */
  resizable?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: Sort | null;
  onSort?: (column: string) => void;
  /** Called when a movable header is dropped before or after another. */
  onMove?: (column: string, target: string, after: boolean) => void;
  /** Widths in px chosen by the user; they override `Column.width`. */
  widths?: ColumnWidths;
  /** Called with the new width in px when a resizable column is resized. */
  onResize?: (column: string, width: number) => void;
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

/** Native drag-and-drop over a list of ids; `drop` is the indicator position. No drag starts while `blocked` is true. */
function useDragOrder(onDrop: (id: string, target: string, after: boolean) => void, vertical = false, blocked?: () => boolean) {
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
      if (blocked?.()) {
        e.preventDefault();
        return;
      }
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
const RESIZE_STEP = 10;

/** Pixels from a computed length such as `8px`; 0 when unset. */
const px = (v: string) => Number.parseFloat(v) || 0;

/**
 * Width that shows all of `cell`'s content: its children are cloned into an
 * unconstrained, invisible box inside the cell, so fonts and classes still
 * apply, and measured there. The resize handle is left out.
 */
function contentWidth(cell: HTMLElement): number {
  const box = document.createElement('div');
  box.className = 'dt-measure';
  for (const child of cell.childNodes) {
    if (!(child instanceof HTMLElement && child.classList.contains('dt-resize'))) box.append(child.cloneNode(true));
  }
  cell.append(box);
  const width = box.getBoundingClientRect().width;
  box.remove();
  const style = getComputedStyle(cell);
  return Math.ceil(width + px(style.paddingLeft) + px(style.paddingRight) + 1);
}

/**
 * Table with a sticky header and virtualized rows: only the rows in view
 * (plus a margin) are in the DOM, so 1,000 rows cost as much as 40.
 */
export function DataTable<T>({ columns, rows, rowKey, sort, onSort, onMove, widths, onResize, empty, rowHeight = 32, caption }: DataTableProps<T>) {
  // Set from a press on a resize handle until its release, so the press never starts a header drag.
  const resizing = useRef(false);
  const drag = useDragOrder((id, target, after) => onMove?.(id, target, after), false, () => resizing.current);
  // The width of the column being dragged; it is reported once, on release.
  const [draft, setDraft] = useState<{ id: string; width: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
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

  const widthOf = (c: Column<T>) => (draft?.id === c.id ? draft.width : widths?.[c.id]);
  // Fixed layout spreads spare room over every column, so once all widths are
  // in px and one was chosen, the table takes their sum and each column keeps its width.
  const pxWidths = columns.map((c) => widthOf(c) ?? (c.width?.endsWith('px') ? px(c.width) : null));
  const tableWidth = columns.some((c) => widthOf(c) !== undefined) && pxWidths.every((w) => w !== null) ? pxWidths.reduce<number>((a, w) => a + (w ?? 0), 0) : null;

  const startResize = (id: string, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const th = (e.currentTarget as HTMLElement).parentElement;
    const startX = e.clientX;
    const startWidth = th?.getBoundingClientRect().width ?? 0;
    let width: number | null = null;
    resizing.current = true;
    const move = (ev: PointerEvent) => {
      width = clampWidth(startWidth + ev.clientX - startX);
      setDraft({ id, width });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      resizing.current = false;
      setDraft(null);
      // A press without a move (a click, or half of a double-click) keeps the width.
      if (width !== null) onResize?.(id, width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const autoFit = (id: string) => {
    const index = columns.findIndex((c) => c.id === id);
    const rowsEl = table.current?.rows;
    if (index < 0 || !rowsEl) return;
    let width = 0;
    // Spacer and empty-state rows have fewer cells; only header and body rows are measured.
    for (const row of rowsEl) {
      const cell = row.cells.length === columns.length ? row.cells[index] : undefined;
      if (cell) width = Math.max(width, contentWidth(cell));
    }
    onResize?.(id, clampWidth(width));
  };

  const keyResize = (id: string, e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // Handled here, so the page's ←/→ shortcuts do not also turn the page.
    e.preventDefault();
    e.stopPropagation();
    const current = widths?.[id] ?? (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().width ?? 0;
    onResize?.(id, clampWidth(current + (e.key === 'ArrowRight' ? RESIZE_STEP : -RESIZE_STEP)));
  };

  return (
    <div class="dt-scroll" ref={scroller} onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}>
      <table class={draft ? 'dt dt-resizing' : 'dt'} ref={table} style={tableWidth !== null ? { width: `${tableWidth}px` } : undefined}>
        {caption && <caption class="visually-hidden">{caption}</caption>}
        <colgroup>
          {columns.map((c) => (
            <col key={c.id} style={widthOf(c) !== undefined ? { width: `${widthOf(c)}px` } : c.width ? { width: c.width } : undefined} />
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
                  {c.resizable && onResize && (
                    <span
                      class="dt-resize"
                      role="separator"
                      aria-orientation="vertical"
                      tabIndex={0}
                      aria-label={`Resize ${c.label} column`}
                      aria-valuemin={MIN_COLUMN_WIDTH}
                      aria-valuenow={widthOf(c)}
                      title="Drag to resize, double-click to fit"
                      onPointerDown={(e) => startResize(c.id, e)}
                      onDblClick={() => autoFit(c.id)}
                      onKeyDown={(e) => keyResize(c.id, e)}
                    />
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
