import './viz.css';
import { useMemo, useRef, useState } from 'preact/hooks';
import { StatusBadge } from '../components/status-chips';
import type { GraphNode, GraphResponse } from '../lib/xapi';
import { layoutDag } from './dag-layout';
import { statusTone } from './gantt-layout';

const NODE_W = 220;
const NODE_H = 56;
const GAP_X = 36;
const GAP_Y = 70;
const PAD = 24;

const px = (gx: number) => PAD + gx * (NODE_W + GAP_X);
const py = (gy: number) => PAD + gy * (NODE_H + GAP_Y);
const clip = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s);

const KIND_LABEL: Record<string, string> = {
  child: 'child',
  continuedAsNew: 'continued as new',
  reset: 'reset',
  signal: 'signal',
  cancelRequest: 'cancel request',
};

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smooth path through grid points, from the bottom of one node to the top of the next. */
function layerPath(points: { x: number; y: number }[]): string {
  const pts = points.map((p, i) => ({
    x: px(p.x) + NODE_W / 2,
    y: i === 0 ? py(p.y) + NODE_H : i === points.length - 1 ? py(p.y) : py(p.y) + NODE_H / 2,
  }));
  let d = `M${pts[0]?.x ?? 0},${pts[0]?.y ?? 0}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as { x: number; y: number };
    const b = pts[i] as { x: number; y: number };
    const my = (a.y + b.y) / 2;
    d += ` C${a.x},${my} ${b.x},${my} ${b.x},${b.y}`;
  }
  return d;
}

/** Arc between the sides of two nodes, for signal and cancel overlays (they may form cycles). */
function overlayPath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const ax = px(a.x) + NODE_W;
  const ay = py(a.y) + NODE_H / 2;
  const bx = px(b.x) + NODE_W;
  const by = py(b.y) + NODE_H / 2 + (a.x === b.x && a.y === b.y ? 1 : 0);
  const bulge = 60 + Math.abs(ay - by) * 0.2;
  return `M${ax},${ay} C${ax + bulge},${ay} ${bx + bulge},${by} ${bx + 4},${by}`;
}

export interface GraphViewProps {
  data: GraphResponse;
  onOpen: (node: GraphNode) => void;
}

/** Relationship graph: layered parent/child, continue-as-new and reset; signal and cancel as overlays. */
export function GraphView({ data, onOpen }: GraphViewProps) {
  const root = data.nodes.find((n) => n.root) ?? data.nodes.find((n) => n.focus);
  const layout = useMemo(
    () => layoutDag(data.nodes.map((n) => n.id), data.edges, { root: root?.id }),
    [data, root?.id],
  );
  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const contentW = PAD * 2 + layout.columns * (NODE_W + GAP_X) + 120;
  const contentH = PAD * 2 + layout.rows * (NODE_H + GAP_Y);
  const fit: ViewBox = { x: 0, y: 0, w: Math.max(contentW, 600), h: Math.max(contentH, 300) };
  const [vb, setVb] = useState<ViewBox | null>(null);
  const [asList, setAsList] = useState(false);
  const drag = useRef<{ x: number; y: number; vb: ViewBox } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const view = vb ?? fit;

  const zoom = (factor: number) => {
    const w = view.w / factor;
    const h = view.h / factor;
    setVb({ x: view.x + (view.w - w) / 2, y: view.y + (view.h - h) / 2, w, h });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
  };
  const onDown = (e: PointerEvent) => {
    if ((e.target as Element).closest('.graph-node')) return;
    drag.current = { x: e.clientX, y: e.clientY, vb: view };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    const el = svgRef.current;
    if (!d || !el) return;
    const scale = d.vb.w / el.clientWidth;
    setVb({ ...d.vb, x: d.vb.x - (e.clientX - d.x) * scale, y: d.vb.y - (e.clientY - d.y) * scale });
  };
  const onUp = () => (drag.current = null);

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const summary = `Relationship graph with ${data.nodes.length} runs and ${data.edges.length} links${root ? `, rooted at ${root.workflowId}` : ''}.`;

  return (
    <div>
      <div class="toolbar">
        <div class="segmented" role="group" aria-label="Zoom">
          <button type="button" class="btn" onClick={() => zoom(1.4)}>
            +
          </button>
          <button type="button" class="btn" onClick={() => zoom(1 / 1.4)}>
            −
          </button>
          <button type="button" class="btn" disabled={!vb} onClick={() => setVb(null)}>
            Fit
          </button>
        </div>
        <button type="button" class="btn" aria-pressed={asList} onClick={() => setAsList(!asList)}>
          {asList ? 'Show as graph' : 'Show as list'}
        </button>
        <div class="graph-legend" aria-label="Legend">
          {(['child', 'continuedAsNew', 'reset', 'signal', 'cancelRequest'] as const).map((k) => (
            <span key={k}>
              <svg width="34" height="10" aria-hidden="true">
                <line x1="2" x2="32" y1="5" y2="5" class={`graph-edge graph-edge-${k}`} />
              </svg>{' '}
              {KIND_LABEL[k]}
            </span>
          ))}
        </div>
      </div>
      {asList ? (
        <div class="stack">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Namespace</th>
              </tr>
            </thead>
            <tbody>
              {data.nodes.map((n) => (
                <tr key={n.id}>
                  <td>
                    <button type="button" class="link-button" onClick={() => onOpen(n)}>
                      {n.workflowId}
                    </button>{' '}
                    {n.focus && <span class="badge">this run</span>} {n.root && <span class="badge">root</span>}
                  </td>
                  <td>{n.workflowType}</td>
                  <td>
                    <StatusBadge status={n.status} />
                  </td>
                  <td>{n.namespace}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table class="table">
            <thead>
              <tr>
                <th scope="col">From</th>
                <th scope="col">Link</th>
                <th scope="col">To</th>
              </tr>
            </thead>
            <tbody>
              {data.edges.map((e, i) => (
                <tr key={i}>
                  <td>{byId.get(e.from)?.workflowId}</td>
                  <td>
                    {KIND_LABEL[e.kind] ?? e.kind}
                    {e.eventId ? ` (event ${e.eventId})` : ''}
                  </td>
                  <td>{byId.get(e.to)?.workflowId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div class="graph-wrap">
          <svg
            ref={svgRef}
            width="100%"
            height="100%"
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            role="img"
            aria-label={summary}
            onWheel={onWheel}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <defs>
              <marker id="graph-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" class="graph-arrow-head" />
              </marker>
            </defs>
            {layout.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const d = e.overlay || e.points.length < 2 || b.layer <= a.layer ? overlayPath(a, b) : layerPath(e.points);
              const mid = e.points[Math.floor(e.points.length / 2)] ?? a;
              return (
                <g key={i}>
                  <path d={d} class={`graph-edge graph-edge-${e.kind}`} marker-end="url(#graph-arrow)">
                    <title>{KIND_LABEL[e.kind] ?? e.kind}</title>
                  </path>
                  {(e.kind === 'reset' || e.overlay) && (
                    <text class="graph-edge-label" x={px(mid.x) + NODE_W / 2 + (e.overlay ? NODE_W / 2 + 40 : 6)} y={py(mid.y) + (e.overlay ? NODE_H / 2 - 4 : -GAP_Y / 2)}>
                      {KIND_LABEL[e.kind]}
                    </text>
                  )}
                </g>
              );
            })}
            {layout.nodes
              .filter((n) => !n.dummy)
              .map((ln) => {
                const n = byId.get(ln.id);
                if (!n) return null;
                const x = px(ln.x);
                const y = py(ln.y);
                return (
                  <g
                    key={n.id}
                    class={n.focus ? 'graph-node focus' : 'graph-node'}
                    transform={`translate(${x},${y})`}
                    onClick={() => onOpen(n)}
                    role="link"
                    aria-label={`${n.workflowType} ${n.workflowId}`}
                  >
                    <title>{`${n.namespace} / ${n.workflowId}\n${n.runId || 'run unknown'}\n${n.status.replace('WORKFLOW_EXECUTION_STATUS_', '').toLowerCase()}`}</title>
                    <rect width={NODE_W} height={NODE_H} rx={8} />
                    <circle cx={14} cy={18} r={5} class={`dot-${statusTone(n.status)}`} />
                    <text x={26} y={22}>
                      {clip(n.workflowType || 'unknown type', 26)}
                      {n.root ? ' (root)' : ''}
                    </text>
                    <text x={12} y={42} class="graph-sub">
                      {clip(n.workflowId, 32)}
                    </text>
                  </g>
                );
              })}
          </svg>
        </div>
      )}
    </div>
  );
}
