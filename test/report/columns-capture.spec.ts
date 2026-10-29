// LOCAL TEST ONLY. Screenshots of the workflow list column states, for plans/reports/tester-261028-1000-table-columns.html.
// Writes out/columns/<shot>.png. Needs RUN_ID (seed run) and the writer cookie from test/e2e/out.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'out', 'columns');
const COOKIE = readFileSync(path.join(HERE, '..', 'e2e', 'out', 'writer.cookie'), 'utf8').trim();
const NS = 'tui-seed-a';
const MEMO_QUERY = `WorkflowType = 'SeedMemo' AND SeedRun = '${RUN_ID}'`;

// The per-user limit is 5 requests per second with a burst of 10, so each shot waits before it loads.
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

test.beforeAll(() => {
  if (!RUN_ID) throw new Error('RUN_ID must be set');
  mkdirSync(OUT, { recursive: true });
});

async function open(page: Page, path: string, cols?: string[]) {
  const colsParam = cols ? `&cols=${cols.map((c) => encodeURIComponent(c)).join(',')}` : '';
  await page.goto(`${BASE}${path}?query=${encodeURIComponent(MEMO_QUERY)}${colsParam}`);
  await expect(page.getByRole('table', { name: /^Workflows/ }).locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

test.describe('column states', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: '__Host-tempolens_session', value: COOKIE, domain: 'localhost', path: '/', httpOnly: true, secure: true },
    ]);
  });

  test('sorted header with the arrow and aria-sort', async ({ page }) => {
    await open(page, `/namespaces/${NS}/workflows`, ['id', 'memo:owner', 'memo:priority']);
    await page.getByTitle('Sort by owner').click();
    await expect(page.getByRole('columnheader', { name: /owner/ })).toHaveAttribute('aria-sort', 'ascending');
    await shot(page, '01-sorted-header');
  });

  test('picker with visible columns first and reorder controls', async ({ page }) => {
    await open(page, `/namespaces/${NS}/workflows`, ['id', 'memo:owner', 'memo:priority']);
    await page.getByText('Columns', { exact: true }).click();
    await expect(page.getByRole('group', { name: 'Visible columns' })).toBeVisible();
    await shot(page, '02-picker');
  });

  test('memo and property columns', async ({ page }) => {
    await open(page, `/namespaces/${NS}/workflows`, ['id', 'memo:owner', 'memo:priority', 'memo:tags', 'task-queue', 'history-length', 'root']);
    // The comma key goes in through the picker, so the URL is the one the page writes.
    await page.getByText('Columns', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Memo key' }).fill('team,region');
    await page.getByRole('button', { name: 'Add memo column' }).click();
    await expect(page.getByRole('columnheader', { name: /team,region/ })).toBeVisible();
    // Toggle the picker shut so it does not cover the table, then wait for the memo values to decode.
    await page.getByText('Columns', { exact: true }).click();
    await expect(page.getByRole('table', { name: /^Workflows/ }).getByText('payments,eu')).toBeVisible({ timeout: 20_000 });
    await shot(page, '03-memo-and-property-columns');
  });

  test('all namespaces with the client-sort notice', async ({ page }) => {
    await open(page, '/workflows', ['namespace', 'id', 'memo:owner', 'memo:priority']);
    await page.getByTitle('Sort by owner').click();
    await expect(page.getByRole('status').filter({ hasText: /Sorted locally across/ })).toBeVisible();
    await shot(page, '04-all-namespaces-notice');
  });
});
