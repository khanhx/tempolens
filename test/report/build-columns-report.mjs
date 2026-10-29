// LOCAL TEST ONLY. Builds the workflow-table column and command console screenshots as one self-contained HTML file.
// Input: out/columns/<shot>.png from columns-capture.spec.ts, and out/console/<shot>.png from console-capture.spec.ts.
// Output: plans/reports/tester-261029-0816-columns-console-e2e.html, with every image embedded as base64.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const REPORT = path.resolve(HERE, '../../plans/reports/tester-261029-0816-columns-console-e2e.html');

const shots = [
  {
    dir: 'columns',
    file: '01-sorted-header',
    title: 'Sorted header',
    note: 'The owner header is sorted ascending. The arrow and aria-sort="ascending" appear on the active header only.',
  },
  {
    dir: 'columns',
    file: '02-picker',
    title: 'Column picker',
    note: 'Visible columns come first, in their current order, each with drag, up and down controls. Hidden columns follow as checkboxes.',
  },
  {
    dir: 'columns',
    file: '03-memo-and-property-columns',
    title: 'Memo and property columns',
    note: 'Memo keys owner, priority and tags carry the memo tag. team,region is a free-text key with a comma. Task queue, history length and root workflow are property columns.',
  },
  {
    dir: 'columns',
    file: '04-all-namespaces-notice',
    title: 'All namespaces, client-sort notice',
    note: 'The all-namespaces view sorts the loaded rows on the client, and the status notice says so.',
  },
  {
    dir: 'console',
    file: '05-console-cli-result-table',
    title: 'Console: CLI result as a table',
    note: 'A workflow list command runs as the reader role. The result opens as a table, with JSON and Table toggles and Copy as CLI.',
  },
  {
    dir: 'console',
    file: '06-console-read-denied',
    title: 'Console: read user, mutating command',
    note: 'The reader role sees the terminate command with Run disabled and the write-access reason. The server refuses the same call with 403.',
  },
  {
    dir: 'console',
    file: '07-console-confirm-dialog',
    title: 'Console: typed confirm for a terminate',
    note: 'The writer role opens the terminate confirm dialog. Confirm and run stays disabled until the workflow ID is typed. The shot is cancelled, so nothing is sent.',
  },
  {
    dir: 'console',
    file: '08-console-raw-mode',
    title: 'Console: raw gRPC mode',
    note: 'Raw mode sends one allowlisted read method with an editable protojson request, and shows the response.',
  },
];

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const figures = [];
for (const shot of shots) {
  const buf = await readFile(path.join(HERE, 'out', shot.dir, `${shot.file}.png`));
  const src = `data:image/png;base64,${buf.toString('base64')}`;
  figures.push(`
  <figure>
    <figcaption><strong>${esc(shot.title)}</strong> <code>${esc(shot.file)}.png</code></figcaption>
    <img src="${src}" alt="${esc(shot.title)}" width="1440" height="900">
    <p>${esc(shot.note)}</p>
  </figure>`);
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tempolens workflow table columns and console: screenshots</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 24px; color: #0f172a; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .lead { color: #475569; margin: 0 0 24px; }
  figure { margin: 0 0 32px; }
  figcaption { margin-bottom: 8px; }
  figcaption code { color: #64748b; margin-left: 6px; }
  img { display: block; width: 100%; height: auto; border: 1px solid #cbd5e1; border-radius: 6px; }
  figure p { margin: 8px 0 0; color: #334155; }
</style>
</head>
<body>
<h1>Workflow table columns and command console: screenshots</h1>
<p class="lead">Captured from the local Tempolens build against the seeded run. Table shots are the writer role on tui-seed-a. Console shots are the reader and writer roles on tui-seed-a and tui-test-* data. Local test data only.</p>
${figures.join('\n')}
</body>
</html>
`;

await writeFile(REPORT, html);
console.log(`wrote ${REPORT} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
