import './viz.css';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Timestamp } from '../components/timestamp';
import { formatAbsolute, formatDuration } from '../lib/time';
import { timeZone } from '../lib/prefs';
import type { Bar, TimeView } from './gantt-layout';
import { fullView, panView, ticks, timeToX, zoomView } from './gantt-layout';

const ROW_H = 24;
const LABEL_W = 300;
const OVERSCAN = 10;

export interface GanttProps {
  bars: Bar[];
  now: number;
  /** One-line description for assistive tech. */
  summary: string;
  onSelect?: (bar: Bar) => void;
  /** Loads the bars of an expandable child row. */
  loadChild?: (bar: Bar) => Promise<Bar[]>;
  truncated?: boolean;
}

type ChildState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; bars: Bar[] };

const tickLabel = (t: number, view: TimeView) => {
  const span = view.end - view.start;
  const full = formatAbsolute(new Date(t), timeZone.value);
  // "2026-10-27 08:00:00.000 UTC": drop the date for short spans and ms for long ones.
  const time = full.slice(11, span < 10_000 ? 23 : 19);
  return span > 86_400_000 ? full.slice(5, 16) : time;
};

/** Hand-written SVG Gantt chart with virtualized rows. */
export function Gantt({ bars, now, summary, onSelect, loadChild, truncated }: GanttProps) {
  const [userView, setUserView] = useState<TimeView | null>(null);
  const [children, setChildren] = useState<Record<string, ChildState>>({});
  const [asList, setAsList] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(Math.max(200, el.clientWidth - LABEL_W - 16));
      setViewport(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [asList]);

  // Child rows are inserted after their parent, one level deeper.
  const rows = useMemo(() => {
    const out: Bar[] = [];
    const add = (list: Bar[]) => {
      for (const b of list) {
        out.push(b);
        const c = children[b.id];
        if (c?.status === 'ready') add(c.bars);
      }
    };
    add(bars);
    return out;
  }, [bars, children]);

  const autoView = useMemo(() => fullView(rows, now), [rows, now]);
  const view = userView ?? autoView;
  const x = (t: number) => timeToX(t, view, width);

  const toggleChild = async (b: Bar) => {
    if (!loadChild) return;
    if (children[b.id]) {
      setChildren(Object.fromEntries(Object.entries(children).filter(([id]) => id !== b.id)));
      return;
    }
    setChildren((c) => ({ ...c, [b.id]: { status: 'loading' } }));
    try {
      const loaded = await loadChild(b);
      setChildren((c) => ({ ...c, [b.id]: { status: 'ready', bars: loaded } }));
    } catch (err) {
      setChildren((c) => ({ ...c, [b.id]: { status: 'error', message: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const center = view.start + ((e.clientX - rect.left) / width) * (view.end - view.start);
    setUserView(zoomView(view, e.deltaY < 0 ? 1.5 : 1 / 1.5, center));
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);
  const tickTimes = ticks(view, Math.max(2, Math.floor(width / 110)));

  return (
    <div class="gantt">
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="Zoom">
          <button type="button" class="btn" onClick={() => setUserView(zoomView(view, 2))} title="Zoom in (or Ctrl + wheel)">
            +
          </button>
          <button type="button" class="btn" onClick={() => setUserView(zoomView(view, 0.5))} title="Zoom out">
            −
          </button>
          <button type="button" class="btn" onClick={() => setUserView(panView(view, -0.25))} title="Earlier">
            ◀
          </button>
          <button type="button" class="btn" onClick={() => setUserView(panView(view, 0.25))} title="Later">
            ▶
          </button>
          <button type="button" class="btn" onClick={() => setUserView(null)} disabled={!userView}>
            Fit
          </button>
        </div>
        <button type="button" class="btn" aria-pressed={asList} onClick={() => setAsList(!asList)}>
          {asList ? 'Show as chart' : 'Show as list'}
        </button>
        <span class="muted">
          {rows.length.toLocaleString('en-US')} rows · {formatDuration(view.end - view.start)} shown
        </span>
        <span class="gantt-legend">
          <span class="swatch bar-running" /> running <span class="swatch bar-completed" /> completed <span class="swatch bar-failed" /> failed
          <span class="swatch bar-wait" /> scheduled / retrying
        </span>
      </div>
      {truncated && <p class="alert alert-warning">Only the first 2,000 bars are drawn; narrow the history to see the rest.</p>}
      {asList ? (
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Kind</th>
              <th scope="col">Start</th>
              <th scope="col">End</th>
              <th scope="col">Duration</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  {'· '.repeat(b.depth)}
                  {b.label}
                  {b.attempts && b.attempts > 1 ? ` (attempt ${b.attempts})` : ''}
                </td>
                <td>{b.lane}</td>
                <td>
                  <Timestamp value={new Date(b.start).toISOString()} />
                </td>
                <td>{b.open ? 'running' : <Timestamp value={new Date(b.end).toISOString()} />}</td>
                <td>{b.point ? '–' : formatDuration(b.end - b.start)}</td>
                <td>{b.tone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="gantt-scroll" ref={scroller} onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}>
          <div class="gantt-axis">
            <div class="gantt-label-head">Item</div>
            <svg width={width} height={22} aria-hidden="true">
              {tickTimes.map((t) => (
                <g key={t} transform={`translate(${x(t)},0)`}>
                  <line y1={16} y2={22} class="gantt-tick" />
                  <text y={12} class="gantt-tick-label" text-anchor={x(t) < 40 ? 'start' : x(t) > width - 40 ? 'end' : 'middle'}>
                    {tickLabel(t, view)}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div class="gantt-body" style={{ height: `${rows.length * ROW_H}px` }}>
            <div class="gantt-labels" style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {visible.map((b) => {
                const c = children[b.id];
                return (
                  <div key={b.id} class="gantt-label" style={{ paddingLeft: `${4 + b.depth * 14}px` }} title={b.label}>
                    {b.child && loadChild ? (
                      <button type="button" class="link-button" aria-expanded={!!c} aria-label={`${c ? 'Collapse' : 'Expand'} child ${b.child.workflowId}`} onClick={() => void toggleChild(b)}>
                        {c?.status === 'loading' ? '…' : c ? '▾' : '▸'}
                      </button>
                    ) : (
                      <span class="gantt-bullet" aria-hidden="true">
                        •
                      </span>
                    )}{' '}
                    {c?.status === 'error' ? <span class="field-error">{c.message}</span> : b.label}
                  </div>
                );
              })}
            </div>
            <svg
              class="gantt-svg"
              width={width}
              height={rows.length * ROW_H}
              role="img"
              aria-label={summary}
              onWheel={onWheel}
            >
              {tickTimes.map((t) => (
                <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={rows.length * ROW_H} class="gantt-grid" />
              ))}
              {visible.map((b, i) => {
                const y = (start + i) * ROW_H;
                const x1 = x(b.start);
                const x2 = Math.max(x(b.end), x1 + 2);
                const tip = `${b.label} (${b.lane})\n${formatAbsolute(new Date(b.start), timeZone.value)} → ${b.open ? 'running' : formatAbsolute(new Date(b.end), timeZone.value)}${b.point ? '' : `\n${formatDuration(b.end - b.start)}`}${b.attempts && b.attempts > 1 ? `\nattempt ${b.attempts}` : ''}`;
                return (
                  <g key={b.id} class={onSelect ? 'gantt-row clickable' : 'gantt-row'} onClick={() => onSelect?.(b)}>
                    <title>{tip}</title>
                    {b.point ? (
                      <polygon class={`bar-${b.tone}`} points={`${x1},${y + 5} ${x1 + 7},${y + 12} ${x1},${y + 19} ${x1 - 7},${y + 12}`} />
                    ) : (
                      <>
                        {b.lastStart !== undefined && b.lastStart > b.start && (
                          <rect class="bar-wait" x={x1} y={y + 7} width={Math.max(x(b.lastStart) - x1, 1)} height={10} rx={2} />
                        )}
                        <rect
                          class={`bar-${b.tone}${b.open ? ' bar-open' : ''}`}
                          x={b.lastStart !== undefined && b.lastStart > b.start ? x(b.lastStart) : x1}
                          y={y + (b.lane === 'workflow-task' ? 9 : 5)}
                          width={Math.max(x2 - (b.lastStart !== undefined && b.lastStart > b.start ? x(b.lastStart) : x1), 2)}
                          height={b.lane === 'workflow-task' ? 6 : 14}
                          rx={3}
                        />
                        {b.attempts && b.attempts > 1 ? (
                          <text class="gantt-retry" x={x2 + 4} y={y + 16}>
                            ×{b.attempts}
                          </text>
                        ) : null}
                      </>
                    )}
                  </g>
                );
              })}
              <line class="gantt-now" x1={x(now)} x2={x(now)} y1={0} y2={rows.length * ROW_H} />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
