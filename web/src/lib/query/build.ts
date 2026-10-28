// Filters → Temporal visibility query. The query string in the URL is the
// single source of truth; filters are a structured view of it (parse.ts).

export type SAType = 'Keyword' | 'Text' | 'Int' | 'Double' | 'Bool' | 'Datetime' | 'KeywordList';
export type Op = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'BETWEEN' | 'STARTS_WITH' | 'IN' | 'IS NULL' | 'IS NOT NULL';

/** One clause. `values` holds 0 (null checks), 1, 2 (BETWEEN) or n (IN) raw values. */
export interface Filter {
  field: string;
  op: Op;
  values: string[];
}

export interface QueryCaps {
  /** `systemInfo.capabilities.prefixSearch`: STARTS_WITH is allowed. */
  prefixSearch?: boolean;
}

/** `INDEXED_VALUE_TYPE_KEYWORD_LIST` → `KeywordList`. */
export function saTypeFromApi(apiType: string): SAType | undefined {
  const map: Record<string, SAType> = {
    INDEXED_VALUE_TYPE_KEYWORD: 'Keyword',
    INDEXED_VALUE_TYPE_TEXT: 'Text',
    INDEXED_VALUE_TYPE_INT: 'Int',
    INDEXED_VALUE_TYPE_DOUBLE: 'Double',
    INDEXED_VALUE_TYPE_BOOL: 'Bool',
    INDEXED_VALUE_TYPE_DATETIME: 'Datetime',
    INDEXED_VALUE_TYPE_KEYWORD_LIST: 'KeywordList',
  };
  return map[apiType];
}

const NULL_OPS: readonly Op[] = ['IS NULL', 'IS NOT NULL'];

/** Operators the builder offers for a type. */
export function opsFor(type: SAType, caps: QueryCaps = {}): Op[] {
  switch (type) {
    case 'Keyword':
      return ['=', '!=', 'IN', ...(caps.prefixSearch ? (['STARTS_WITH'] as Op[]) : []), ...NULL_OPS];
    case 'KeywordList':
      return ['=', '!=', 'IN', ...NULL_OPS];
    case 'Text':
      return ['=', '!=', ...NULL_OPS];
    case 'Bool':
      return ['=', '!=', ...NULL_OPS];
    case 'Int':
    case 'Double':
    case 'Datetime':
      return ['=', '!=', '>', '>=', '<', '<=', 'BETWEEN', ...NULL_OPS];
  }
}

/** Number of values an operator takes; -1 means one or more. */
export function arity(op: Op): number {
  if (op === 'IS NULL' || op === 'IS NOT NULL') return 0;
  if (op === 'BETWEEN') return 2;
  if (op === 'IN') return -1;
  return 1;
}

export const quoteString = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function quoteField(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, '')}\``;
}

/** Formats one value for `type`, validating it. Throws on an invalid value. */
export function literal(type: SAType, raw: string): string {
  const v = raw.trim();
  switch (type) {
    case 'Int':
      if (!/^-?\d+$/.test(v)) throw new Error(`"${raw}" is not an integer`);
      return v;
    case 'Double':
      if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v)) throw new Error(`"${raw}" is not a number`);
      return v;
    case 'Bool':
      if (v !== 'true' && v !== 'false') throw new Error(`"${raw}" is not true or false`);
      return v;
    case 'Datetime': {
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) throw new Error(`"${raw}" is not a date`);
      // Keep RFC 3339 input as written; normalise anything else.
      return quoteString(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) ? v : new Date(ms).toISOString());
    }
    default:
      return quoteString(raw);
  }
}

/** One filter as a query clause. Throws when the filter is invalid. */
export function buildClause(f: Filter, type: SAType, caps: QueryCaps = {}): string {
  if (!opsFor(type, caps).includes(f.op)) throw new Error(`${f.op} is not supported for ${f.field}`);
  const field = quoteField(f.field);
  const n = arity(f.op);
  if (n === 0) return `${field} ${f.op}`;
  if (n === -1 ? f.values.length === 0 : f.values.length !== n) throw new Error(`${f.field} ${f.op} needs ${n === -1 ? 'values' : `${n} value(s)`}`);
  const vals = f.values.map((v) => literal(type, v));
  if (f.op === 'IN') return `${field} IN (${vals.join(', ')})`;
  if (f.op === 'BETWEEN') return `${field} BETWEEN ${vals[0]} AND ${vals[1]}`;
  return `${field} ${f.op} ${vals[0]}`;
}

/** Filters joined with AND. `types` maps field → type; an unknown field throws. */
export function buildQuery(filters: Filter[], types: Record<string, SAType>, caps: QueryCaps = {}): string {
  return filters
    .map((f) => {
      const type = types[f.field];
      if (!type) throw new Error(`unknown search attribute ${f.field}`);
      return buildClause(f, type, caps);
    })
    .join(' AND ');
}
