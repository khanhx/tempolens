#!/usr/bin/env node
// Bundle budget gate. Reads dist/.vite/manifest.json and measures the gzip
// size of the JS+CSS that each page needs:
//   - first load: the entry closure plus the workflow-list route chunk;
//   - every lazy route: the entry closure plus that route's closure.
// A closure follows static imports only; dynamic imports are separate routes.
// Exits non-zero when a budget is exceeded or the manifest is missing.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, gzipSync } from 'node:zlib';

const FIRST_LOAD_BUDGET = 60_000;
const ROUTE_BUDGET = 120_000;
const FIRST_LOAD_ROUTE = 'src/pages/workflows-list.tsx';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const manifestPath = join(dist, '.vite', 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`manifest missing: set build.manifest (expected ${manifestPath}; run "npm run build" first)`);
  process.exit(1);
}

/** @type {Record<string, {file: string, src?: string, isEntry?: boolean, isDynamicEntry?: boolean, imports?: string[], dynamicImports?: string[], css?: string[]}>} */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const gzipCache = new Map();
function gzipSize(file) {
  if (!gzipCache.has(file)) {
    const body = readFileSync(join(dist, file));
    gzipCache.set(file, gzipSync(body, { level: constants.Z_BEST_COMPRESSION }).length);
  }
  return gzipCache.get(file);
}

/** Files (JS and CSS) loaded with a chunk: itself, its static imports, and their CSS. */
function closure(key, files = new Set()) {
  const chunk = manifest[key];
  if (!chunk) throw new Error(`manifest has no chunk "${key}"`);
  if (files.has(chunk.file)) return files;
  files.add(chunk.file);
  for (const css of chunk.css ?? []) files.add(css);
  for (const dep of chunk.imports ?? []) closure(dep, files);
  return files;
}

const sum = (files) => [...files].reduce((total, f) => total + gzipSize(f), 0);
const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;

const entries = Object.entries(manifest).filter(([, c]) => c.isEntry);
if (entries.length !== 1) {
  console.error(`expected exactly one entry chunk in the manifest, found ${entries.length}`);
  process.exit(1);
}
const [entryKey] = entries[0];
const entryFiles = closure(entryKey);

if (!manifest[FIRST_LOAD_ROUTE]) {
  console.error(`first-load route "${FIRST_LOAD_ROUTE}" is not a chunk in the manifest; is it still lazy-loaded?`);
  process.exit(1);
}

const rows = [];
const firstLoad = sum(closure(FIRST_LOAD_ROUTE, new Set(entryFiles)));
rows.push({ name: `first load (entry + ${FIRST_LOAD_ROUTE})`, bytes: firstLoad, budget: FIRST_LOAD_BUDGET });

const routes = Object.entries(manifest)
  .filter(([, c]) => c.isDynamicEntry)
  .map(([key, c]) => ({ name: c.src ?? key, bytes: sum(closure(key, new Set(entryFiles))), budget: ROUTE_BUDGET }))
  .sort((a, b) => b.bytes - a.bytes);
rows.push(...routes);

let failed = false;
const width = Math.max(...rows.map((r) => r.name.length));
console.log(`entry alone: ${kb(sum(entryFiles))} gzip (${entryFiles.size} files)`);
for (const r of rows) {
  const over = r.bytes > r.budget;
  failed ||= over;
  console.log(`${over ? 'FAIL' : 'ok  '}  ${r.name.padEnd(width)}  ${kb(r.bytes).padStart(9)} / ${kb(r.budget)}`);
}

if (failed) {
  console.error('bundle budget exceeded');
  process.exit(1);
}
console.log(`budget ok: first load ${kb(firstLoad)} ≤ ${kb(FIRST_LOAD_BUDGET)}, ${routes.length} routes ≤ ${kb(ROUTE_BUDGET)}`);
