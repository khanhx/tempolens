// Autocomplete for the console input: command words, flags of the command
// typed so far, namespaces after --namespace, and enum values after flags
// that have them. Works on the text before the cursor, split on whitespace.
import { commandFlags, findCommand, nextWords } from './parse';

export interface Suggestions {
  /** Start of the partial word that a choice replaces. */
  from: number;
  items: string[];
}

const MAX_ITEMS = 20;

const startsWith = (prefix: string) => (s: string) => s.toLowerCase().startsWith(prefix.toLowerCase());

export function suggest(textBeforeCursor: string, namespaces: readonly string[]): Suggestions {
  const from = textBeforeCursor.search(/\S*$/);
  const partial = textBeforeCursor.slice(from);
  let words = textBeforeCursor.slice(0, from).trim().split(/\s+/).filter(Boolean);
  if (words[0] === 'temporal') words = words.slice(1);
  if (words[0] === 'cluster') words = ['operator', ...words];
  const done = (items: string[]): Suggestions => ({ from, items: items.filter(startsWith(partial)).filter((i) => i !== partial).slice(0, MAX_ITEMS) });

  const spec = findCommand(words);
  if (!words.some((w) => w.startsWith('-')) && !partial.startsWith('-')) {
    // Still choosing the command; a command can prefix a longer one (`workflow update`).
    const deeper = nextWords(words);
    if (deeper.length || !spec) return done(deeper);
    if (spec.positional === 'namespace' && words.length === spec.path.length && partial !== '') return done([...namespaces]);
  }
  if (!spec) return { from, items: [] };

  const flags = commandFlags(spec);
  const prev = words.at(-1) ?? '';
  const prevFlag = prev.startsWith('-') && !prev.includes('=') ? prev.replace(/^--?/, '') : null;
  if (prevFlag !== null) {
    const name = Object.entries(flags).find(([n, s]) => n === prevFlag || s.alias?.includes(prevFlag))?.[0];
    if (name === 'namespace') return done([...namespaces]);
    const values = name ? flags[name]?.values : undefined;
    if (values) return done([...values]);
    if (name && flags[name]?.kind !== 'bool') return { from, items: [] };
  }
  if (partial.startsWith('-') || partial === '') {
    const used = new Set(words.filter((w) => w.startsWith('--')).map((w) => w.slice(2).split('=')[0]));
    const names = Object.entries(flags)
      .filter(([n, s]) => s.kind === 'list' || !used.has(n))
      .map(([n]) => `--${n}`);
    return done(names);
  }
  return { from, items: [] };
}
