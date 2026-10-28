// LOCAL TEST ONLY. Captures the phase 11 comparison pages from the upstream UI and the new UI.
// Output: out/<side>/<page id>.jpg, plus out/manifest.json with the status of every capture.
// Env: OLD_BASE (default http://localhost:8233), NEW_BASE (default http://localhost:8234),
//      READ_BASE (default http://localhost:8237, the role=read container), CAPTURE=old,new,read (default all),
//      NAMESPACE (default from pages.json). Highlight boxes are measured from the live page and written to
//      out/highlights-measured.json, keyed by "<page id>|<side>".
import { expect, test } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Side = 'old' | 'new' | 'read';
type PageSpec = {
  id: string;
  caption: string;
  old?: string;
  new?: string;
  expect: string;
  click?: string;
  newClick?: string;
  dark?: boolean;
  newOnly?: boolean;
  pending?: string;
  note?: string;
  readShot?: boolean;
  highlight?: Highlight[];
  oldHighlight?: Highlight[];
};
type Highlight = { selector: string; label: string };
type Rect = { x: number; y: number; w: number; h: number; label: string };
type Manifest = {
  id: string;
  side: Side;
  url: string;
  status: 'ok' | 'failed' | 'pending';
  error?: string;
  bytes?: number;
};

const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'out');
const VIEWPORT = { width: 1440, height: 900 };
const OLD_BASE = process.env.OLD_BASE ?? 'http://localhost:8233';
const NEW_BASE = process.env.NEW_BASE ?? 'http://localhost:8234';
const READ_BASE = process.env.READ_BASE ?? 'http://localhost:8237';
const SIDES = (process.env.CAPTURE ?? 'old,new,read').split(',') as Side[];

const spec = JSON.parse(await readFile(path.join(HERE, 'pages.json'), 'utf8')) as {
  namespace: string;
  pages: PageSpec[];
};

// Replaces {run:<workflowId>} with the latest run ID of that workflow, read from the upstream API.
async function resolveRuns(request: import('@playwright/test').APIRequestContext, text: string): Promise<string> {
  let out = text;
  for (const m of text.matchAll(/\{run:([^}]+)\}/g)) {
    const wf = m[1];
    const res = await request.get(
      `${OLD_BASE}/api/v1/namespaces/${spec.namespace}/workflows/${encodeURIComponent(wf)}`,
    );
    expect(res.ok(), `resolve run for ${wf}: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as { workflowExecutionInfo: { execution: { runId: string } } };
    out = out.replace(m[0], body.workflowExecutionInfo.execution.runId);
  }
  return out;
}

test('capture comparison pages', async ({ browser, request }) => {
  test.setTimeout(30 * 60 * 1000);
  const manifest: Manifest[] = [];
  const measured: Record<string, Rect[]> = {};
  for (const side of SIDES) {
    await mkdir(path.join(OUT, side), { recursive: true });
  }

  for (const page of spec.pages) {
    for (const side of SIDES) {
      if (side === 'old' && (page.newOnly || page.readShot)) continue;
      if (side === 'read' && !page.readShot) continue;
      if (side !== 'old' && page.pending) {
        manifest.push({ id: page.id, side, url: page.new ?? '', status: 'pending', error: page.pending });
        continue;
      }
      const base = side === 'old' ? OLD_BASE : side === 'read' ? READ_BASE : NEW_BASE;
      const rawPath = side === 'old' ? page.old ?? page.new : page.new ?? page.old;
      if (!rawPath) continue;
      const url = await resolveRuns(request, rawPath);
      const click = side === 'old' ? page.click : page.newClick ?? page.click;

      const context = await browser.newContext({
        viewport: VIEWPORT,
        colorScheme: page.dark ? 'dark' : 'light',
      });
      const tab = await context.newPage();
      const entry: Manifest = { id: page.id, side, url, status: 'ok' };
      try {
        await tab.goto(base + url, { waitUntil: "load", timeout: 60_000 });
        // Upstream polls, so networkidle may never come. Wait briefly for it, then carry on.
        await tab.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        if (click) {
          // Exact label first, then a substring for tabs that show a count before the label.
          const exact = tab.getByText(click, { exact: true });
          const target = (await exact.count()) > 0 ? exact.first() : tab.getByText(click).first();
          await target.click({ timeout: 20_000 });
        }
        // expect may list alternatives separated by " || ": any one visible text is enough.
        const alternatives = page.expect.split(' || ').map((t) => tab.getByText(t.trim()).filter({ visible: true }).first());
        await Promise.any(alternatives.map((loc) => loc.waitFor({ state: 'visible', timeout: 20_000 })));
        await tab.waitForTimeout(500);
        const file = path.join(OUT, side, `${page.id}.jpg`);
        const buf = await tab.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
        await writeFile(file, buf);
        entry.bytes = buf.length;
        const rects: Rect[] = [];
        for (const h of (side === 'old' ? page.oldHighlight : page.highlight) ?? []) {
          const box = await tab.locator(h.selector).first().boundingBox().catch(() => null);
          if (box) rects.push({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), label: h.label });
        }
        measured[`${page.id}|${side}`] = rects;
      } catch (err) {
        entry.status = 'failed';
        entry.error = (err as Error).message.split('\n')[0];
      } finally {
        await context.close();
      }
      manifest.push(entry);
      console.log(`${entry.status.padEnd(6)} ${side.padEnd(4)} ${page.id} ${entry.error ?? ''}`);
    }
  }

  await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(OUT, 'highlights-measured.json'), JSON.stringify(measured, null, 2));
  const failed = manifest.filter((m) => m.status === 'failed');
  console.log(`captured ${manifest.length - failed.length} of ${manifest.length}; failed: ${failed.length}`);
});
