// LOCAL TEST ONLY. Workflow list columns, in the single-namespace and the all-namespaces views:
// header sort, add, remove and reorder, the URL and saved-preference round trip, memo and property columns.
// Requires RUN_ID (seed run) and cookies in out/writer.cookie, as functional.spec.ts does.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const NS = 'tui-seed-a';
const OTHER_NS = 'tui-seed-b';
const OUT = path.join(__dirname, 'out');

test.beforeAll(() => {
  if (!RUN_ID) throw new Error('RUN_ID must be set');
});

// The per-user limit is 5 requests per second with a burst of 10, and one all-namespaces load uses about 10 of
// them. Each test waits before it loads a page, so the bucket refills and the tests do not see "too many requests".
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

// Memo fixtures, as test/seed/main.go starts them. Keep this list in step with memoFixtures there.
// Each fixture runs in every namespace listed; the first two also run in tui-seed-b.
type Fixture = { owner: string; priority: number; teamRegion: string; namespaces: string[] };
const FIXTURES: Fixture[] = [
  { owner: 'alice', priority: 2, teamRegion: 'payments,eu', namespaces: [NS, OTHER_NS] },
  { owner: 'bob', priority: 10, teamRegion: 'payments,us', namespaces: [NS, OTHER_NS] },
  { owner: 'carol', priority: 1, teamRegion: 'search,eu', namespaces: [NS] },
  { owner: 'dave', priority: 5, teamRegion: 'search,us', namespaces: [NS] },
];

// Column ids as the list page names them: base ids, root for the root workflow, and memo:<key> for memo keys.
const COL = {
  id: 'id',
  run: 'run',
  type: 'type',
  end: 'end',
  namespace: 'namespace',
  taskQueue: 'task-queue',
  historyLength: 'history-length',
  parent: 'parent',
  root: 'root',
  owner: 'memo:owner',
  priority: 'memo:priority',
  teamRegion: 'memo:team,region',
  tags: 'memo:tags',
  deploy: 'memo:deploy',
} as const;

const MEMO_QUERY = `WorkflowType = 'SeedMemo' AND SeedRun = '${RUN_ID}'`;

type Dir = 'asc' | 'desc';
type View = { name: string; path: string; prefsKey: string; namespaces: string[]; defaultCols: string[] };

const VIEWS: View[] = [
  { name: 'single namespace', path: `/namespaces/${NS}/workflows`, prefsKey: NS, namespaces: [NS], defaultCols: [COL.id, COL.run, COL.type, COL.end] },
  { name: 'all namespaces', path: '/workflows', prefsKey: '*', namespaces: [NS, OTHER_NS], defaultCols: [COL.namespace, COL.id, COL.run, COL.type, COL.end] },
];

// The memo rows a view shows: one per fixture and namespace, filtered to the view's namespaces.
function expectedRows(view: View): Fixture[] {
  return FIXTURES.flatMap((f) => f.namespaces.filter((ns) => view.namespaces.includes(ns)).map(() => f));
}

function expectedOwners(view: View, dir: Dir): string[] {
  return expectedRows(view)
    .map((f) => f.owner)
    .sort((a, b) => (dir === 'asc' ? 1 : -1) * a.localeCompare(b));
}

// Numeric, not text: the fixtures include 10, which sorts before 2 as text.
function expectedPriorities(view: View, dir: Dir): string[] {
  return expectedRows(view)
    .map((f) => f.priority)
    .sort((a, b) => (dir === 'asc' ? a - b : b - a))
    .map(String);
}

function viewUrl(view: View, extra = ''): string {
  return `${BASE}${view.path}?query=${encodeURIComponent(MEMO_QUERY)}${extra}`;
}

// Each column id is encoded on its own, so a memo key with a comma survives the join.
function colsParam(ids: string[]): string {
  return `&cols=${ids.map((id) => encodeURIComponent(id)).join(',')}`;
}

function cookieFor(user: string): string {
  return readFileSync(path.join(OUT, `${user}.cookie`), 'utf8').trim();
}

async function signedIn(browser: Browser, user: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: '__Host-tempolens_session', value: cookieFor(user), domain: 'localhost', path: '/', httpOnly: true, secure: true },
  ]);
  return { context, page: await context.newPage() };
}

const table = (page: Page) => page.getByRole('table', { name: /^Workflows/ });

// Reads wait for the first body row, so a read right after navigation sees the loaded table.
async function headerLabels(page: Page): Promise<string[]> {
  await expect(table(page).locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
  return (await table(page).locator('thead th').allInnerTexts()).map((t) => t.trim());
}

// The labels in the order the headers show them. Each label matches the header text it is part of.
async function headerOrder(page: Page, labels: string[]): Promise<string[]> {
  const headers = await headerLabels(page);
  return headers.map((h) => labels.find((l) => h.includes(l))).filter((l): l is string => l !== undefined);
}

// The cell values of one column for the rows whose text contains rowText, in row order.
async function columnValues(page: Page, label: string, rowText = `seed-memo-${RUN_ID}`): Promise<string[]> {
  const index = (await headerLabels(page)).findIndex((h) => h.includes(label));
  expect(index, `header ${label}`).toBeGreaterThan(-1);
  const rows = table(page).locator('tbody tr').filter({ hasText: rowText });
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  return rows.locator(`td:nth-child(${index + 1})`).allInnerTexts();
}

async function savedCols(page: Page, prefsKey: string): Promise<string[] | null> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), `tempolens.columns.${prefsKey}`);
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

async function openPicker(page: Page) {
  await page.getByText('Columns', { exact: true }).click();
  return page.getByRole('group', { name: 'Visible columns' });
}

for (const view of VIEWS) {
  test.describe(`${view.name}`, () => {
    test('a header click cycles text sort: ascending, descending, then off', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.owner])));
      const header = page.getByRole('columnheader', { name: /owner/ });
      const sort = page.getByTitle('Sort by owner');

      // Text columns start ascending.
      await sort.click();
      await expect(header).toHaveAttribute('aria-sort', 'ascending');
      await expect(page.getByText(/Sorted locally across/).first()).toBeVisible();
      expect(await columnValues(page, 'owner')).toEqual(expectedOwners(view, 'asc'));

      await sort.click();
      await expect(header).toHaveAttribute('aria-sort', 'descending');
      expect(await columnValues(page, 'owner')).toEqual(expectedOwners(view, 'desc'));

      await sort.click();
      await expect(header).toHaveAttribute('aria-sort', 'none');
      expect(page.url()).not.toContain('sort=');
      await context.close();
    });

    test('a numeric memo column starts descending and sorts as numbers', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.priority])));
      // The table is loaded, but the memo values may still be decoding. The first click is not held for them.
      await headerLabels(page);
      await page.getByTitle('Sort by priority').click();
      await expect(page.getByRole('columnheader', { name: /priority/ })).toHaveAttribute('aria-sort', 'descending');
      // Text order would put 10 after 1 and before 2, so this checks the number order.
      expect(await columnValues(page, 'priority')).toEqual(expectedPriorities(view, 'desc'));

      await page.getByTitle('Sort by priority').click();
      await expect(page.getByRole('columnheader', { name: /priority/ })).toHaveAttribute('aria-sort', 'ascending');
      expect(await columnValues(page, 'priority')).toEqual(expectedPriorities(view, 'asc'));
      await context.close();
    });

    test('the picker adds a discovered memo key and a free-text key with a comma', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id])));
      const panel = await openPicker(page);
      // owner is discovered from the loaded rows, so it is listed without typing.
      // A plain click, then an assertion on the state: check() waits for navigations the picker never starts.
      const owner = panel.getByRole('checkbox', { name: 'owner', exact: true });
      await owner.click();
      await expect(owner).toBeChecked();
      await page.getByRole('textbox', { name: 'Memo key' }).fill('team,region');
      await page.getByRole('button', { name: 'Add memo column' }).click();

      const ownerHeader = page.getByRole('columnheader', { name: /owner/ });
      await expect(ownerHeader).toBeVisible();
      // A memo header carries the memo tag and says it is not server-filterable.
      await expect(ownerHeader).toHaveAttribute('title', /filter/i);
      expect((await columnValues(page, 'owner')).sort()).toEqual(expectedRows(view).map((f) => f.owner).sort());
      expect((await columnValues(page, 'team,region')).sort()).toEqual(expectedRows(view).map((f) => f.teamRegion).sort());
      // The URL the page wrote must restore the comma key on a fresh load.
      await page.reload();
      await expect(page.getByRole('columnheader', { name: /team,region/ })).toBeVisible();
      await context.close();
    });

    test('a hand-written single-encoded link shows one team,region memo column', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      // colsParam encodes each id once, so this is cols=id,memo%3Ateam%2Cregion as a person would type it.
      await page.goto(viewUrl(view, colsParam([COL.id, COL.teamRegion])));
      const headers = await headerLabels(page);
      expect(headers.filter((h) => h.includes('team,region'))).toHaveLength(1);
      expect(headers.filter((h) => h.trim() === 'region' || h.trim() === 'team')).toHaveLength(0);
      // Memo cells show a placeholder until they decode, so poll for the values rather than reading them once.
      await expect.poll(async () => (await columnValues(page, 'team,region')).sort()).toEqual(expectedRows(view).map((f) => f.teamRegion).sort());
      await context.close();
    });

    test('memo arrays and objects render as readable values', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.tags, COL.deploy])));
      // alice is the first fixture: tags ["blue"] and deploy {"env":"dev"}. Containment, since the format is not fixed.
      const alice = page.getByRole('row').filter({ hasText: `seed-memo-${RUN_ID}-1` }).first();
      await expect(alice).toContainText('blue');
      await expect(alice).toContainText('dev');
      await context.close();
    });

    test('the ↑ and ↓ buttons reorder columns, and the order survives a reload and a saved-preference load', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.owner, COL.priority])));
      const panel = await openPicker(page);
      await panel.getByRole('button', { name: 'Move owner down' }).click();
      const order = [COL.id, COL.priority, COL.owner];
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual(['priority', 'owner']);
      expect(await savedCols(page, view.prefsKey)).toEqual(order);

      await page.reload();
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual(['priority', 'owner']);

      // No cols param: the saved preference supplies the same order.
      await page.goto(viewUrl(view));
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual(['priority', 'owner']);
      expect(page.url()).not.toContain('cols=');
      await context.close();
    });

    test('a header drag reorders columns, and the order survives a reload', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.owner, COL.priority])));
      const before = await headerOrder(page, ['owner', 'priority']);
      await page.getByRole('columnheader', { name: /priority/ }).dragTo(page.getByRole('columnheader', { name: /owner/ }));
      const after = await headerOrder(page, ['owner', 'priority']);
      expect(after).not.toEqual(before);

      await page.reload();
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual(after);
      await context.close();
    });

    test('removing a column survives a reload through the saved preference, with no URL params', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.owner, COL.priority])));
      const panel = await openPicker(page);
      const priority = panel.getByRole('checkbox', { name: 'priority', exact: true });
      await priority.click();
      await expect(priority).not.toBeChecked();
      expect(await headerOrder(page, ['priority'])).toEqual([]);

      await page.goto(viewUrl(view));
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual(['owner']);
      expect(await savedCols(page, view.prefsKey)).toEqual([COL.id, COL.owner]);
      await context.close();
    });

    test('Reset columns clears the URL param and the saved preference', async ({ browser }) => {
      const { context, page } = await signedIn(browser, 'writer');
      await page.goto(viewUrl(view, colsParam([COL.id, COL.priority, COL.owner])));
      const panel = await openPicker(page);
      await panel.getByRole('button', { name: 'Reset columns' }).click();

      await expect(page).not.toHaveURL(/cols=/);
      expect(await savedCols(page, view.prefsKey)).toBeNull();
      expect(await headerOrder(page, ['owner', 'priority'])).toEqual([]);
      expect(await headerLabels(page)).toContain('Workflow ID');
      await context.close();
    });
  });
}

test.describe('property columns (single namespace)', () => {
  const view = VIEWS[0];

  test('task queue and history length render the values of the memo workflows', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(viewUrl(view, colsParam([COL.id, COL.taskQueue, COL.historyLength])));
    expect(await columnValues(page, 'Task queue')).toEqual(FIXTURES.filter((f) => f.namespaces.includes(NS)).map(() => 'tempolens-seed'));
    // A workflow that runs one workflow task and completes has five history events:
    // WorkflowExecutionStarted, WorkflowTaskScheduled, WorkflowTaskStarted, WorkflowTaskCompleted, WorkflowExecutionCompleted.
    expect(await columnValues(page, 'History length')).toEqual(FIXTURES.filter((f) => f.namespaces.includes(NS)).map(() => '5'));
    await context.close();
  });

  test('root workflow and parent columns show the parent of the memo child', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    const parentId = `seed-memo-parent-${RUN_ID}`;
    await page.goto(`${BASE}${view.path}?query=${encodeURIComponent(`WorkflowType = 'SeedChild' AND SeedRun = '${RUN_ID}'`)}${colsParam([COL.id, COL.parent, COL.root])}`);
    const childRow = `${parentId}-child`;
    expect(await columnValues(page, 'Parent workflow', childRow)).toEqual([parentId]);
    expect(await columnValues(page, 'Root workflow', childRow)).toEqual([parentId]);
    await context.close();
  });

  test('the end column is labelled as the close time', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(viewUrl(view, colsParam([COL.id, COL.end])));
    await expect(page.getByRole('columnheader', { name: /End \(close time\)/ })).toBeVisible();
    await context.close();
  });
});
