// Visibility query → filters, for the builder. Only a plain AND-conjunction
// of supported clauses is parsed; anything else (OR, parentheses, ORDER BY,
// unknown fields) returns null and the query stays raw.
import type { Filter, Op, SAType } from './build';
import { opsFor } from './build';

type Token =
  | { t: 'ident'; v: string }
  | { t: 'string'; v: string }
  | { t: 'number'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punct'; v: '(' | ')' | ',' };

/** Splits a query into tokens; returns null on a lexical error. */
export function tokenize(q: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < q.length) {
    const c = q.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let v = '';
      i++;
      for (;;) {
        if (i >= q.length) return null;
        const d = q.charAt(i);
        if (d === '\\' && i + 1 < q.length) {
          v += q.charAt(i + 1);
          i += 2;
        } else if (d === c) {
          i++;
          break;
        } else {
          v += d;
          i++;
        }
      }
      out.push({ t: 'string', v });
    } else if (c === '`') {
      const end = q.indexOf('`', i + 1);
      if (end < 0) return null;
      out.push({ t: 'ident', v: q.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '(' || c === ')' || c === ',') {
      out.push({ t: 'punct', v: c });
      i++;
    } else if ('=!<>'.includes(c)) {
      const two = q.slice(i, i + 2);
      if (two === '!=' || two === '<=' || two === '>=' || two === '<>') {
        out.push({ t: 'op', v: two === '<>' ? '!=' : two });
        i += 2;
      } else if (c === '!') {
        return null;
      } else {
        out.push({ t: 'op', v: c });
        i++;
      }
    } else {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(q.slice(i)) ?? /^[A-Za-z_][A-Za-z0-9_.]*/.exec(q.slice(i));
      if (!m) return null;
      out.push(/^[-\d]/.test(m[0]) ? { t: 'number', v: m[0] } : { t: 'ident', v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

const isWord = (tok: Token | undefined, word: string) => tok?.t === 'ident' && tok.v.toUpperCase() === word;

/** Parses `q` into filters, or returns null when the builder cannot represent it. */
export function parseQuery(q: string, types: Record<string, SAType>): Filter[] | null {
  const toks = tokenize(q);
  if (!toks) return null;
  if (toks.length === 0) return [];
  let i = 0;
  const filters: Filter[] = [];

  const value = (type: SAType): string | null => {
    const tok = toks[i++];
    if (!tok) return null;
    if (type === 'Int' || type === 'Double') return tok.t === 'number' ? tok.v : null;
    if (type === 'Bool') return tok.t === 'ident' && /^(true|false)$/i.test(tok.v) ? tok.v.toLowerCase() : null;
    if (type === 'Datetime') return tok.t === 'string' && !Number.isNaN(Date.parse(tok.v)) ? tok.v : null;
    return tok.t === 'string' ? tok.v : null;
  };

  for (;;) {
    const fieldTok = toks[i++];
    if (fieldTok?.t !== 'ident') return null;
    const field = fieldTok.v;
    const type = types[field];
    if (!type) return null;
    const opTok = toks[i];
    let op: Op;
    const values: string[] = [];

    if (opTok?.t === 'op') {
      i++;
      op = opTok.v as Op;
      const v = value(type);
      if (v === null) return null;
      values.push(v);
    } else if (isWord(opTok, 'IS')) {
      i++;
      const not = isWord(toks[i], 'NOT');
      if (not) i++;
      if (!isWord(toks[i++], 'NULL')) return null;
      op = not ? 'IS NOT NULL' : 'IS NULL';
    } else if (isWord(opTok, 'IN')) {
      i++;
      if (toks[i++]?.v !== '(') return null;
      for (;;) {
        const v = value(type);
        if (v === null) return null;
        values.push(v);
        const sep = toks[i++];
        if (sep?.v === ')') break;
        if (sep?.v !== ',') return null;
      }
      op = 'IN';
    } else if (isWord(opTok, 'BETWEEN')) {
      i++;
      const a = value(type);
      if (a === null || !isWord(toks[i++], 'AND')) return null;
      const b = value(type);
      if (b === null) return null;
      values.push(a, b);
      op = 'BETWEEN';
    } else if (isWord(opTok, 'STARTS_WITH')) {
      i++;
      const v = value(type);
      if (v === null) return null;
      values.push(v);
      op = 'STARTS_WITH';
    } else {
      return null;
    }

    if (!opsFor(type, { prefixSearch: true }).includes(op)) return null;
    filters.push({ field, op, values });
    if (i === toks.length) return filters;
    if (!isWord(toks[i++], 'AND')) return null;
  }
}
