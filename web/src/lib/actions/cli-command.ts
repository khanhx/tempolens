// "Copy as temporal CLI": the equivalent `temporal …` command line, quoted
// for POSIX shells.

/** Quotes a value for sh/bash/zsh; plain tokens stay unquoted. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-.,/:=@%+]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type CliFlag = readonly [name: string, value: string | number | boolean | null | undefined | readonly string[]];

/** `temporal <sub…> --flag value …`; empty and false flags are left out, arrays repeat the flag. */
export function cliCommand(subcommand: readonly string[], flags: readonly CliFlag[]): string {
  const parts = ['temporal', ...subcommand];
  for (const [name, value] of flags) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (value === true) parts.push(`--${name}`);
    else if (Array.isArray(value)) for (const v of value) parts.push(`--${name}`, shellQuote(String(v)));
    else parts.push(`--${name}`, shellQuote(String(value)));
  }
  return parts.join(' ');
}
