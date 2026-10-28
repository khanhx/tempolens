// Combining a user query with extra clauses. Like the server, the user query
// is always wrapped as `(<q>)` before anything is appended, so `a OR b`
// cannot swallow the appended clause. A trailing ORDER BY stays at the end.

/** Index of a top-level `ORDER BY` outside quotes, or -1. */
function orderByIndex(q: string): number {
  let quote: string | null = null;
  for (let i = 0; i < q.length; i++) {
    const c = q.charAt(i);
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if ((i === 0 || /\s/.test(q.charAt(i - 1))) && /^ORDER\s+BY\b/i.test(q.slice(i))) {
      return i;
    }
  }
  return -1;
}

/** Splits `q` into the filter part and its `ORDER BY …` suffix (empty when absent). */
export function splitOrderBy(q: string): { where: string; orderBy: string } {
  const idx = orderByIndex(q);
  return idx < 0 ? { where: q.trim(), orderBy: '' } : { where: q.slice(0, idx).trim(), orderBy: q.slice(idx).trim() };
}

/** `(q) AND c1 AND c2 [ORDER BY …]`; empty parts are skipped. */
export function wrap(q: string, ...clauses: string[]): string {
  const { where, orderBy } = splitOrderBy(q);
  const extra = clauses.map((c) => c.trim()).filter(Boolean);
  const parts = where ? [extra.length ? `(${where})` : where, ...extra] : extra;
  return [parts.join(' AND '), orderBy].filter(Boolean).join(' ');
}

/** Replaces any ORDER BY in `q` with `orderBy` (or removes it when empty). */
export function withOrderBy(q: string, orderBy: string): string {
  const { where } = splitOrderBy(q);
  return [where, orderBy].filter(Boolean).join(' ');
}
