// Workflow-list state in the URL. `query` and `per-page` keep upstream's
// names, so old links such as `?query=WorkflowType%3D%22x%22` load as-is.
import { parseRange } from './range';

export type SortDir = 'asc' | 'desc';

export interface Sort {
  /** Column id (see the list page's column table). */
  column: string;
  dir: SortDir;
}

export interface ListState {
  query: string;
  /** Raw `range=` value; invalid values are dropped. */
  range: string;
  sort: Sort | null;
  perPage: number;
  /** Visible column ids; null means the saved or default set. */
  cols: string[] | null;
  /** Namespaces for the cross-namespace list; null when not given. */
  ns: string[] | null;
}

export const PER_PAGE_OPTIONS = [100, 250, 500] as const;
export const DEFAULT_PER_PAGE = 100;

const list = (v: string | null): string[] | null => {
  if (v === null) return null;
  const items = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
};

export function parseListState(search: string | URLSearchParams): ListState {
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const perPage = Number(p.get('per-page'));
  const sortRaw = /^([A-Za-z0-9_-]+):(asc|desc)$/.exec(p.get('sort') ?? '');
  const range = p.get('range') ?? '';
  return {
    query: p.get('query') ?? '',
    range: parseRange(range) ? range : '',
    sort: sortRaw?.[1] && sortRaw[2] ? { column: sortRaw[1], dir: sortRaw[2] as SortDir } : null,
    perPage: (PER_PAGE_OPTIONS as readonly number[]).includes(perPage) ? perPage : DEFAULT_PER_PAGE,
    cols: list(p.get('cols')),
    ns: list(p.get('ns')),
  };
}

/** `?…` for a state, omitting defaults; '' when everything is default. */
export function listSearch(state: ListState): string {
  const p = new URLSearchParams();
  if (state.query) p.set('query', state.query);
  if (state.range) p.set('range', state.range);
  if (state.sort) p.set('sort', `${state.sort.column}:${state.sort.dir}`);
  if (state.perPage !== DEFAULT_PER_PAGE) p.set('per-page', String(state.perPage));
  if (state.cols?.length) p.set('cols', state.cols.join(','));
  if (state.ns?.length) p.set('ns', state.ns.join(','));
  const s = p.toString();
  return s ? `?${s}` : '';
}
