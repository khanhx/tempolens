// Pure layered graph layout (no d3, no elk):
//   1. Layering edges are child, continue-as-new and reset; signal and
//      cancel edges may form cycles, so they are drawn as overlays only.
//   2. Layers by longest path from the sources (cycle-safe).
//   3. Dummy nodes split edges that span several layers.
//   4. Barycenter ordering: two sweeps down and up.
//   5. Grid coordinates; a layer wraps after `maxPerRow` nodes.

export type EdgeKind = 'child' | 'continuedAsNew' | 'reset' | 'signal' | 'cancelRequest';

export interface LayoutEdgeInput {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface LaidNode {
  id: string;
  /** Grid column (0-based) and row (0-based). */
  x: number;
  y: number;
  layer: number;
  dummy: boolean;
}

export interface LaidEdge extends LayoutEdgeInput {
  /** Grid points from source to target (through dummy nodes for long layering edges). */
  points: { x: number; y: number }[];
  overlay: boolean;
}

export interface Layout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  columns: number;
  rows: number;
}

export const LAYERING_KINDS: ReadonlySet<EdgeKind> = new Set(['child', 'continuedAsNew', 'reset']);

/**
 * Longest-path layers over layering edges. `root` (when given) is pinned to
 * layer 0 so a mid-tree focus still draws the whole tree from the top.
 */
export function assignLayers(ids: readonly string[], edges: readonly LayoutEdgeInput[], root?: string): Map<string, number> {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of edges) {
    if (!LAYERING_KINDS.has(e.kind) || !indeg.has(e.from) || !indeg.has(e.to) || e.from === e.to) continue;
    if (e.to === root) continue; // nothing sits above the root
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  // Kahn's algorithm; nodes left over are on cycles and keep their current layer.
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const remaining = new Map(indeg);
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i] as string;
    for (const v of out.get(u) ?? []) {
      layer.set(v, Math.max(layer.get(v) ?? 0, (layer.get(u) ?? 0) + 1));
      const left = (remaining.get(v) ?? 1) - 1;
      remaining.set(v, left);
      if (left === 0) queue.push(v);
    }
  }
  return layer;
}

/** Number of crossings between consecutive layers for the given order. */
export function countCrossings(order: readonly string[][], edges: readonly { from: string; to: string }[]): number {
  const pos = new Map<string, [number, number]>();
  order.forEach((ids, l) => ids.forEach((id, i) => pos.set(id, [l, i])));
  let crossings = 0;
  for (let l = 0; l + 1 < order.length; l++) {
    const between = edges
      .map((e) => [pos.get(e.from), pos.get(e.to)] as const)
      .filter(([a, b]) => a && b && a[0] === l && b[0] === l + 1)
      .map(([a, b]) => [a?.[1] ?? 0, b?.[1] ?? 0] as const);
    for (let i = 0; i < between.length; i++) {
      for (let j = i + 1; j < between.length; j++) {
        const [a1, b1] = between[i] as readonly [number, number];
        const [a2, b2] = between[j] as readonly [number, number];
        if ((a1 - a2) * (b1 - b2) < 0) crossings++;
      }
    }
  }
  return crossings;
}

function barycenterOrder(order: string[][], segments: { from: string; to: string }[], sweeps = 2): string[][] {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  for (const s of segments) {
    preds.set(s.to, [...(preds.get(s.to) ?? []), s.from]);
    succs.set(s.from, [...(succs.get(s.from) ?? []), s.to]);
  }
  const reorder = (layerIds: string[], refLayer: string[], neighbours: Map<string, string[]>) => {
    const refPos = new Map(refLayer.map((id, i) => [id, i]));
    const keyed = layerIds.map((id, i) => {
      const ns = (neighbours.get(id) ?? []).map((n) => refPos.get(n)).filter((p): p is number => p !== undefined);
      return { id, key: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i, i };
    });
    keyed.sort((a, b) => a.key - b.key || a.i - b.i);
    return keyed.map((k) => k.id);
  };
  const result = order.map((l) => [...l]);
  for (let s = 0; s < sweeps; s++) {
    for (let l = 1; l < result.length; l++) result[l] = reorder(result[l] ?? [], result[l - 1] ?? [], preds);
    for (let l = result.length - 2; l >= 0; l--) result[l] = reorder(result[l] ?? [], result[l + 1] ?? [], succs);
  }
  return result;
}

/** Lays out the graph on a grid. Node ids must be unique; unknown edge endpoints are ignored. */
export function layoutDag(ids: readonly string[], edges: readonly LayoutEdgeInput[], opts: { root?: string; maxPerRow?: number } = {}): Layout {
  const maxPerRow = opts.maxPerRow ?? 30;
  const known = new Set(ids);
  const valid = edges.filter((e) => known.has(e.from) && known.has(e.to));
  const layers = assignLayers(ids, valid, opts.root);

  // Segments between adjacent layers, inserting dummies on long layering edges.
  const segments: { from: string; to: string }[] = [];
  const chains = new Map<LayoutEdgeInput, string[]>();
  const dummyLayer = new Map<string, number>();
  let dummyCount = 0;
  for (const e of valid) {
    if (!LAYERING_KINDS.has(e.kind)) continue;
    const a = layers.get(e.from) ?? 0;
    const b = layers.get(e.to) ?? 0;
    if (b <= a) continue; // back edge on a cycle, or into the root: drawn directly
    const chain = [e.from];
    for (let l = a + 1; l < b; l++) {
      const d = `\u0000d${dummyCount++}`;
      dummyLayer.set(d, l);
      chain.push(d);
    }
    chain.push(e.to);
    chains.set(e, chain);
    for (let i = 0; i + 1 < chain.length; i++) segments.push({ from: chain[i] as string, to: chain[i + 1] as string });
  }

  const layerCount = Math.max(0, ...[...layers.values()], ...[...dummyLayer.values()]) + 1;
  const order: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) order[layers.get(id) ?? 0]?.push(id);
  for (const [d, l] of dummyLayer) order[l]?.push(d);
  const ordered = barycenterOrder(order, segments);

  // Grid: each layer takes ceil(n / maxPerRow) rows; columns centre narrower layers.
  const columns = Math.max(1, ...ordered.map((l) => Math.min(l.length, maxPerRow)));
  const pos = new Map<string, { x: number; y: number }>();
  const nodes: LaidNode[] = [];
  let row = 0;
  ordered.forEach((layerIds, layer) => {
    const rowsHere = Math.max(1, Math.ceil(layerIds.length / maxPerRow));
    layerIds.forEach((id, i) => {
      const r = Math.floor(i / maxPerRow);
      const inRow = Math.min(maxPerRow, layerIds.length - r * maxPerRow);
      const x = (columns - inRow) / 2 + (i % maxPerRow);
      const p = { x, y: row + r };
      pos.set(id, p);
      nodes.push({ id, ...p, layer, dummy: id.startsWith('\u0000d') });
    });
    row += rowsHere;
  });

  const laidEdges: LaidEdge[] = valid.map((e) => {
    const chain = chains.get(e) ?? [e.from, e.to];
    return { ...e, overlay: !LAYERING_KINDS.has(e.kind), points: chain.map((id) => pos.get(id) ?? { x: 0, y: 0 }) };
  });
  return { nodes, edges: laidEdges, columns, rows: row };
}
