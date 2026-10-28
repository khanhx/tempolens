// A small JSON parser that keeps integers outside ±2^53 exact as BigInt
// (Temporal payloads often carry int64 IDs), and a matching stringify.

const NUMBER = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
// eslint-disable-next-line no-control-regex
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const MAX_DEPTH = 512;

/** Parses JSON text. Throws SyntaxError on invalid input. */
export function parseJson(text: string): unknown {
  let i = 0;

  const fail = (what: string): never => {
    throw new SyntaxError(`${what} at position ${i}`);
  };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else return;
    }
  };
  const literal = <T>(word: string, value: T): T => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return value;
    }
    return fail('Unexpected token');
  };
  const str = (): string => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) return fail('Invalid string');
    i = STRING.lastIndex;
    return JSON.parse(m[0]) as string;
  };
  const num = (): number | bigint => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) return fail('Invalid number');
    i = NUMBER.lastIndex;
    const n = Number(m[0]);
    return m[1] === undefined && m[2] === undefined && !Number.isSafeInteger(n) ? BigInt(m[0]) : n;
  };

  const value = (depth: number): unknown => {
    if (depth > MAX_DEPTH) fail('Nesting too deep');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expected key');
        const key = str();
        ws();
        if (text[i] !== ':') fail('Expected ":"');
        i++;
        const v = value(depth + 1);
        // Never let a "__proto__" key change the object's prototype.
        if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        else obj[key] = v;
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return obj;
        } else fail('Expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return arr;
        } else fail('Expected "," or "]"');
      }
    }
    if (c === '"') return str();
    if (c === 't') return literal('true', true);
    if (c === 'f') return literal('false', false);
    if (c === 'n') return literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return num();
    return fail('Unexpected token');
  };

  const result = value(0);
  ws();
  if (i < text.length) fail('Unexpected trailing data');
  return result;
}

/** Like JSON.stringify(value, null, indent), but BigInt values print as plain integers. */
export function stringifyJson(value: unknown, indent = 2): string {
  const pad = (depth: number) => (indent > 0 ? '\n' + ' '.repeat(indent * depth) : '');
  const sep = indent > 0 ? ': ' : ':';
  const walk = (v: unknown, depth: number): string | undefined => {
    if (v === null) return 'null';
    switch (typeof v) {
      case 'bigint':
        return v.toString();
      case 'number':
        return Number.isFinite(v) ? String(v) : 'null';
      case 'boolean':
        return String(v);
      case 'string':
        return JSON.stringify(v);
      case 'object': {
        const toJSON = (v as { toJSON?: () => unknown }).toJSON;
        if (typeof toJSON === 'function') return walk(toJSON.call(v), depth);
        if (Array.isArray(v)) {
          if (v.length === 0) return '[]';
          const items = v.map((item) => walk(item, depth + 1) ?? 'null');
          return `[${items.map((s) => pad(depth + 1) + s).join(',')}${pad(depth)}]`;
        }
        const entries: string[] = [];
        for (const [k, item] of Object.entries(v)) {
          const s = walk(item, depth + 1);
          if (s !== undefined) entries.push(`${pad(depth + 1)}${JSON.stringify(k)}${sep}${s}`);
        }
        return entries.length ? `{${entries.join(',')}${pad(depth)}}` : '{}';
      }
      default:
        return undefined;
    }
  };
  return walk(value, 0) ?? 'null';
}
