// LOCAL TEST ONLY. Functional E2E against the Tempolens image (auth on), as writer and reader.
// Assertions are scoped to tui-seed-a and the current RUN_ID. Requires:
//   RUN_ID (seed run), PARENT_RUN_ID (run of seed-parent-1), and cookies in out/<user>.cookie.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const PARENT_RUN_ID = process.env.PARENT_RUN_ID ?? '';
const NS = 'tui-seed-a';
const OUT = path.join(__dirname, 'out');

test.beforeAll(() => {
  if (!RUN_ID || !PARENT_RUN_ID) throw new Error('RUN_ID and PARENT_RUN_ID must be set');
});

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

// Reads a JSON response from the Tempolens API as the given user.
async function apiGet<T>(user: string, pathAndQuery: string): Promise<T> {
  let res = await fetch(`${BASE}${pathAndQuery}`, { headers: { Cookie: `__Host-tempolens_session=${cookieFor(user)}` } });
  // The per-user rate limit (5 requests per second, burst 10) answers 429; wait for Retry-After and retry.
  for (let i = 0; res.status === 429 && i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    res = await fetch(`${BASE}${pathAndQuery}`, { headers: { Cookie: `__Host-tempolens_session=${cookieFor(user)}` } });
  }
  expect(res.ok, `GET ${pathAndQuery}: ${res.status}`).toBeTruthy();
  return (await res.json()) as T;
}

async function runIdOf(user: string, workflowId: string): Promise<string> {
  const d = await apiGet<{ workflowExecutionInfo: { execution: { runId: string } } }>(
    user,
    `/api/v1/namespaces/${NS}/workflows/${encodeURIComponent(workflowId)}`,
  );
  return d.workflowExecutionInfo.execution.runId;
}

async function statusOf(user: string, workflowId: string): Promise<string> {
  const d = await apiGet<{ workflowExecutionInfo: { status: string } }>(
    user,
    `/api/v1/namespaces/${NS}/workflows/${encodeURIComponent(workflowId)}`,
  );
  return d.workflowExecutionInfo.status;
}

function listUrl(query: string, ns = NS): string {
  return `/namespaces/${ns}/workflows?query=${encodeURIComponent(query)}`;
}

test.describe('login and roles', () => {
  test('writer sees the write role in the header', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces`);
    await expect(page.getByText('writer', { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/^write$/).first()).toBeVisible();
    await context.close();
  });

  test('reader sees the read role and no enabled write action on a running run', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(`${BASE}/namespaces`);
    await expect(page.getByText(/^read$/).first()).toBeVisible();

    const runId = await runIdOf('reader', 'tempolens-e2e-disposable-15');
    await page.goto(`${BASE}/namespaces/${NS}/workflows/tempolens-e2e-disposable-15/${runId}/timeline`);
    await page.waitForLoadState('load');
    // Write actions are either absent or disabled for read users.
    const enabledWrite = page
      .locator('button:not([disabled])')
      .filter({ hasText: /^(Signal|Update|Request cancellation|Terminate|Reset)$/ });
    await expect(enabledWrite).toHaveCount(0);
    await context.close();
  });

  test('padded and nogroups users get the read role', async ({ browser }) => {
    for (const user of ['padded', 'nogroups'] as const) {
      const { context, page } = await signedIn(browser, user);
      await page.goto(`${BASE}/namespaces`);
      await expect(page.getByText(/^read$/).first()).toBeVisible();
      await context.close();
    }
  });
});

test.describe('namespaces and the cross-namespace list', () => {
  test('the namespace list shows tui-seed-a, tui-seed-b and default', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces`);
    for (const name of ['tui-seed-a', 'tui-seed-b', 'default']) {
      await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible({ timeout: 20_000 });
    }
    await context.close();
  });

  test('the all-namespaces list returns rows from both seed namespaces', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/workflows?query=${encodeURIComponent("WorkflowType = 'SeedGreet' AND ExecutionStatus = 'Completed'")}`);
    const rows = page.getByRole('row').filter({ hasText: 'seed-completed-' });
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await expect(rows.filter({ hasText: 'tui-seed-a' }).first()).toBeVisible();
    await expect(rows.filter({ hasText: 'tui-seed-b' }).first()).toBeVisible();
    await context.close();
  });
});

test.describe('list filters and sort', () => {
  test('the builder query returns exactly the three failed runs of this RUN_ID', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    const q = `WorkflowType = 'SeedFailing' AND SeedRun = '${RUN_ID}'`;
    await page.goto(`${BASE}${listUrl(q)}`);
    const rows = page.getByRole('row').filter({ hasText: `seed-failed-${RUN_ID}-` });
    await expect(rows).toHaveCount(3, { timeout: 20_000 });
    await context.close();
  });

  test('the filter survives a reload', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    const q = `WorkflowType = 'SeedFailing' AND SeedRun = '${RUN_ID}'`;
    await page.goto(`${BASE}${listUrl(q)}`);
    await expect(page.getByRole('row').filter({ hasText: `seed-failed-${RUN_ID}-` })).toHaveCount(3, { timeout: 20_000 });
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: `seed-failed-${RUN_ID}-` })).toHaveCount(3, { timeout: 20_000 });
    expect(page.url()).toContain('query=');
    await context.close();
  });

  test('the quick filter "Failed, 24 h" writes the query into the URL', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/workflows`);
    await page.getByRole('button', { name: 'Failed, 24 h' }).click();
    await expect(page).toHaveURL(/query=/);
    await expect(page.getByRole('row').filter({ hasText: 'Failed' }).first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('sorting a column on SQL visibility shows the local-sort banner', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/workflows`);
    await page.getByTitle('Sort by Type').click();
    await expect(page.getByText(/Sorted locally across/).first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('custom attributes filter the seeded runs: SeedPriority on failures and SeedCustomer in tui-seed-b', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}${listUrl(`SeedRun = '${RUN_ID}' AND SeedPriority >= 2 AND ExecutionStatus = 'Failed'`)}`);
    await expect(page.getByRole('row').filter({ hasText: `seed-failed-${RUN_ID}-` })).toHaveCount(2, { timeout: 20_000 });
    await page.goto(`${BASE}${listUrl("SeedCustomer = 'acme'", 'tui-seed-b')}`);
    await expect(page.getByRole('row').filter({ hasText: 'seed-' })).toHaveCount(2, { timeout: 20_000 });
    await context.close();
  });
});

test.describe('history, timeline and graph', () => {
  test('the per-run timeline draws the parent and its child rows', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/workflows/seed-parent-1/${PARENT_RUN_ID}/timeline`);
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('SeedChild').first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('deep link to the history view opens directly', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/workflows/seed-parent-1/${PARENT_RUN_ID}/history`);
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByText('WorkflowExecutionCompleted').first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('the relationship graph for seed-parent-1 renders the tree', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/workflows/seed-parent-1/${PARENT_RUN_ID}/graph`);
    await expect(page.locator('svg').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('SeedChild').first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('the graph walks the reset base run and the signal edge of seed-signaler-1', async ({ browser }) => {
    const { context } = await signedIn(browser, 'writer');
    await context.close();
    // The reset base is the older of the two seed-reset-1 runs.
    const list = await apiGet<{ executions: { startTime: string; execution: { runId: string } }[] }>(
      'writer',
      `/api/v1/namespaces/${NS}/workflows?query=${encodeURIComponent("WorkflowId = 'seed-reset-1'")}&pageSize=10`,
    );
    const base = [...list.executions].sort((a, b) => a.startTime.localeCompare(b.startTime))[0].execution.runId;
    // The graph answers partial (not an error) while the user's scan budget is spent, so poll until it is complete.
    await expect.poll(async () => {
      const reset = await apiGet<{ edges: { kind: string }[]; partial: boolean }>(
        'writer',
        `/api/x/graph?namespace=${NS}&workflowId=seed-reset-1&runId=${base}&depth=2`,
      );
      return reset.partial ? false : reset.edges.some((e) => e.kind === 'reset');
    }, { message: 'reset edge from the base run', timeout: 30_000 }).toBeTruthy();

    const signaler = await runIdOf('writer', 'seed-signaler-1');
    await expect.poll(async () => {
      const sig = await apiGet<{ edges: { kind: string }[]; partial: boolean }>(
        'writer',
        `/api/x/graph?namespace=${NS}&workflowId=seed-signaler-1&runId=${signaler}&depth=2`,
      );
      return sig.partial ? false : sig.edges.some((e) => e.kind === 'signal');
    }, { message: 'signal edge from seed-signaler-1', timeout: 30_000 }).toBeTruthy();
  });
});

test.describe('writes on disposables (writer)', () => {
  test('signal a running disposable through the UI and see it in history', async ({ browser }) => {
    const wf = 'tempolens-e2e-disposable-18';
    const { context, page } = await signedIn(browser, 'writer');
    const runId = await runIdOf('writer', wf);
    await page.goto(`${BASE}/namespaces/${NS}/workflows/${wf}/${runId}/timeline`);
    await page.getByText(/^Actions/).first().click();
    await page.locator('button, [role=menuitem]').filter({ hasText: /^Signal$/ }).first().click();
    await page.locator('[role=dialog] input, dialog input').first().fill('tempolens-ui-check');
    await page.locator('button').filter({ hasText: /^Send signal$/ }).first().click();
    await expect
      .poll(async () => {
        const h = await apiGet<{ history: { events: { eventType: string }[] } }>(
          'writer',
          `/api/v1/namespaces/${NS}/workflows/${wf}/history?execution.runId=${runId}`,
        );
        return h.history.events.some((e) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED');
      }, { timeout: 30_000 })
      .toBeTruthy();
    await context.close();
  });

  test('terminate stays disabled until a reason is typed, then terminates the run', async ({ browser }) => {
    const wf = 'tempolens-e2e-disposable-19';
    const { context, page } = await signedIn(browser, 'writer');
    const runId = await runIdOf('writer', wf);
    await page.goto(`${BASE}/namespaces/${NS}/workflows/${wf}/${runId}/timeline`);
    await page.getByText(/^Actions/).first().click();
    await page.locator('button, [role=menuitem]').filter({ hasText: /^Terminate$/ }).first().click();
    const confirm = page.locator('button').filter({ hasText: /^Terminate$/ }).last();
    await expect(confirm).toBeDisabled();
    await expect.poll(() => statusOf('writer', wf)).toBe('WORKFLOW_EXECUTION_STATUS_RUNNING');

    await page.locator('dialog textarea, [role=dialog] textarea').first().fill('phase 10 UI terminate');
    // The dialog also needs the workflow ID typed (typed confirmation).
    await expect(confirm).toBeDisabled();
    await page.locator('dialog input, [role=dialog] input').first().fill(wf);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect.poll(() => statusOf('writer', wf), { timeout: 30_000 }).toBe('WORKFLOW_EXECUTION_STATUS_TERMINATED');
    await context.close();
  });
});

test.describe('pages', () => {
  test('schedules list and detail render', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/schedules`);
    await expect(page.getByText('tempolens-seed-sched-active').first()).toBeVisible({ timeout: 20_000 });
    await page.goto(`${BASE}/namespaces/${NS}/schedules/tempolens-seed-sched-active`);
    await expect(page.getByText('tempolens-seed-sched-active').first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('batch list and task queue pages render', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces/${NS}/batch-operations`);
    await expect(page.getByText('Batch operations').first()).toBeVisible({ timeout: 20_000 });
    await page.goto(`${BASE}/namespaces/${NS}/task-queues/tempolens-seed`);
    await expect(page.getByText('tempolens-seed').first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('the theme and time zone toggles change their labels', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(`${BASE}/namespaces`);
    const theme = page.getByRole('button', { name: /Theme: System/ });
    await theme.click();
    await expect(page.getByRole('button', { name: /Theme: Light/ })).toBeVisible();
    const tz = page.getByRole('button', { name: 'Local', exact: true });
    await tz.click();
    await expect(page.getByRole('button', { name: 'UTC', exact: true })).toBeVisible();
    await context.close();
  });
});

// Phase 15 flows: the admin role and the CLI-parity actions. Every namespace and workflow these tests
// create is prefixed tui-test-, and only those are mutated or deleted.
test.describe('admin and CLI-parity actions (phase 15)', () => {
  test('admin creates a tui-test namespace, adds and removes a search attribute, and deletes the namespace', async ({ browser }) => {
    // A fresh suffix each run: a renamed namespace from an earlier run must not be reused.
    const stamp = Date.now().toString(36);
    const ns = `tui-test-ui-${RUN_ID}-${stamp}`;
    const attr = `TuiTestUi_${stamp}`;
    const { context, page } = await signedIn(browser, 'admin');

    await page.goto(`${BASE}/namespaces`);
    await page.getByRole('button', { name: 'Create namespace' }).click();
    const create = page.locator('dialog').first();
    await create.getByLabel('Name', { exact: true }).fill(ns);
    await create.getByLabel(/^Retention/).fill('1d');
    await create.getByRole('button', { name: 'Create namespace' }).click();
    await expect.poll(() => apiGet<{ namespaceInfo: { name: string } }>('admin', `/api/v1/namespaces/${ns}`).then((d) => d.namespaceInfo.name).catch(() => ''), { timeout: 20_000 }).toBe(ns);

    // Temporal's frontend sees a new namespace a few seconds after RegisterNamespace answers.
    await expect.poll(async () => {
      const res = await fetch(`${BASE}/api/v1/namespaces/${ns}/search-attributes`, { headers: { Cookie: `__Host-tempolens_session=${cookieFor('admin')}` } });
      return res.status;
    }, { timeout: 30_000 }).toBe(200);

    await page.goto(`${BASE}/namespaces/${ns}`);
    await page.getByRole('button', { name: 'Add attribute' }).click();
    const add = page.locator('dialog').first();
    await add.getByRole('textbox').first().fill(attr);
    await add.locator('select').selectOption('Keyword');
    await add.getByRole('button', { name: 'Add attribute' }).click();
    await expect.poll(async () => {
      const sa = await apiGet<{ customAttributes: Record<string, string> }>('admin', `/api/v1/namespaces/${ns}/search-attributes`);
      return Object.keys(sa.customAttributes ?? {}).includes(attr);
    }, { timeout: 30_000 }).toBeTruthy();

    // Remove needs the typed attribute names before the submit enables.
    await page.reload();
    await page.getByRole('row').filter({ hasText: attr }).getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Remove selected' }).click();
    const remove = page.locator('dialog').first();
    await expect(remove.getByRole('button', { name: /^Remove/ })).toBeDisabled();
    await remove.getByRole('textbox').first().fill(attr);
    await expect(remove.getByRole('button', { name: /^Remove/ })).toBeEnabled();
    await remove.getByRole('button', { name: /^Remove/ }).click();
    await expect.poll(async () => {
      const sa = await apiGet<{ customAttributes: Record<string, string> }>('admin', `/api/v1/namespaces/${ns}/search-attributes`);
      return Object.keys(sa.customAttributes ?? {}).includes(attr);
    }, { timeout: 30_000 }).toBeFalsy();

    await page.goto(`${BASE}/namespaces/${ns}`);
    await page.getByRole('button', { name: 'Delete namespace', exact: true }).click();
    const del = page.locator('dialog').first();
    const submit = del.getByRole('button', { name: 'Delete namespace' });
    await expect(submit).toBeDisabled();
    await del.getByRole('textbox').first().fill(ns);
    await expect(submit).toBeEnabled();
    const deleted = page.waitForResponse((r) => r.url().includes('/api/x/namespace') && r.request().method() === 'DELETE');
    await submit.click();
    expect((await deleted).status()).toBe(200);
    await expect(page.getByText(/deleting|renamed/i).first()).toBeVisible({ timeout: 20_000 });
    await context.close();
  });

  test('the protected default namespace has its delete action disabled, with the reason shown', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'admin');
    await page.goto(`${BASE}/namespaces/default`);
    await expect(page.getByRole('button', { name: 'Delete namespace', exact: true })).toBeDisabled();
    await expect(page.getByText(/protected namespace/i).first()).toBeVisible();
    await context.close();
  });

  test('admin deletes a tui-test namespace from the ⋯ menu on the namespace list', async ({ browser }) => {
    const ns = `tui-test-ui-${RUN_ID}-menu-${Date.now().toString(36)}`;
    const { context, page } = await signedIn(browser, 'admin');
    await page.goto(`${BASE}/namespaces`);
    await page.getByRole('button', { name: 'Create namespace' }).click();
    const create = page.locator('dialog').first();
    await create.getByLabel('Name', { exact: true }).fill(ns);
    await create.getByLabel(/^Retention/).fill('1d');
    await create.getByRole('button', { name: 'Create namespace' }).click();
    await expect.poll(() => apiGet<{ namespaceInfo: { name: string } }>('admin', `/api/v1/namespaces/${ns}`).then((d) => d.namespaceInfo.name).catch(() => ''), { timeout: 20_000 }).toBe(ns);

    // Temporal's frontend sees a new namespace a few seconds after RegisterNamespace answers.
    await expect.poll(async () => {
      const res = await fetch(`${BASE}/api/v1/namespaces/${ns}/search-attributes`, { headers: { Cookie: `__Host-tempolens_session=${cookieFor('admin')}` } });
      return res.status;
    }, { timeout: 30_000 }).toBe(200);

    await page.goto(`${BASE}/namespaces`);
    const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: ns, exact: true }) });
    await expect(row.getByRole('link', { name: 'Details' })).toHaveAttribute('href', `/namespaces/${ns}`);
    await row.getByLabel(`Actions for ${ns}`).click();
    await row.getByRole('menuitem', { name: 'Delete namespace' }).click();
    const del = page.locator('dialog').first();
    const submit = del.getByRole('button', { name: 'Delete namespace' });
    await expect(submit).toBeDisabled();
    await del.getByRole('textbox').first().fill(ns);
    const deleted = page.waitForResponse((r) => r.url().includes('/api/x/namespace') && r.request().method() === 'DELETE');
    await submit.click();
    expect((await deleted).status()).toBe(200);
    await context.close();
  });

  test('the ⋯ menu disables Delete namespace for the reader and for a protected namespace', async ({ browser }) => {
    for (const [user, ns, reason] of [
      ['reader', NS, /write access/],
      ['admin', 'default', /protected namespace/],
    ] as const) {
      const { context, page } = await signedIn(browser, user);
      await page.goto(`${BASE}/namespaces`);
      const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: ns, exact: true }) });
      await row.getByLabel(`Actions for ${ns}`).click();
      const item = row.getByRole('menuitem', { name: 'Delete namespace' });
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute('title', reason);
      await context.close();
    }
  });

  test('the writer and the reader cannot create a namespace or change one', async ({ browser }) => {
    for (const user of ['writer', 'reader'] as const) {
      const { context, page } = await signedIn(browser, user);
      await page.goto(`${BASE}/namespaces`);
      await expect(page.getByRole('button', { name: 'Create namespace' })).toBeDisabled();
      await page.goto(`${BASE}/namespaces/${NS}`);
      await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Delete namespace', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Add attribute' })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Remove selected' })).toHaveCount(0);
      await context.close();
    }
  });

  test('the writer deletes a disposable run after typing its workflow ID and a reason', async ({ browser }) => {
    const wf = 'tempolens-e2e-disposable-17';
    const { context, page } = await signedIn(browser, 'writer');
    const runId = await runIdOf('writer', wf);
    await page.goto(`${BASE}/namespaces/${NS}/workflows/${wf}/${runId}/timeline`);
    await page.getByText(/^Actions/).first().click();
    await page.getByRole('menuitem', { name: 'Delete' }).first().click();
    const dialog = page.locator('dialog').first();
    const submit = dialog.getByRole('button', { name: 'Delete run' });
    await expect(submit).toBeDisabled();
    await dialog.locator('textarea').fill('phase 15 UI delete');
    await dialog.locator('input').first().fill(wf);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(async () => {
      const res = await fetch(`${BASE}/api/v1/namespaces/${NS}/workflows/${wf}`, { headers: { Cookie: `__Host-tempolens_session=${cookieFor('writer')}` } });
      return res.status;
    }, { timeout: 30_000 }).toBe(404);
    await context.close();
  });

  test('a pending activity offers Complete and Fail, and no pause or update on 1.24', async ({ browser }) => {
    const wf = 'seed-stuck-1';
    const { context, page } = await signedIn(browser, 'writer');
    const runId = await runIdOf('writer', wf);
    await page.goto(`${BASE}/namespaces/${NS}/workflows/${wf}/${runId}/timeline`);
    await page.getByRole('link', { name: /^Pending activities/ }).click();
    await page.getByText(/^Activity actions/).first().click();
    await expect(page.getByRole('menuitem', { name: 'Complete' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fail' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /pause|unpause|reset|update options/i })).toHaveCount(0);
    await context.close();
  });

  test('the reader sees the activity actions disabled', async ({ browser }) => {
    const wf = 'seed-stuck-1';
    const { context, page } = await signedIn(browser, 'reader');
    const runId = await runIdOf('reader', wf);
    await page.goto(`${BASE}/namespaces/${NS}/workflows/${wf}/${runId}/timeline`);
    await page.getByRole('link', { name: /^Pending activities/ }).click();
    await page.getByText(/^Activity actions/).first().click();
    const complete = page.getByRole('menuitem', { name: 'Complete' });
    if (await complete.count()) await expect(complete).toBeDisabled();
    await context.close();
  });
});

// The three CLI-parity rows that the earlier runs had not verified: the cluster page, the task-queue
// partitions, and the admin bulk delete. The bulk delete runs on its own tui-test- namespace.
test.describe('CLI-parity rows verified in the UI (phase 11)', () => {
  test('the cluster page shows the server version and the health checks', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(`${BASE}/cluster`);
    await expect(page.getByText('SERVER VERSION').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/1\.24\.3/).first()).toBeVisible();
    await expect(page.getByText('TEMPORAL FRONTEND').first()).toBeVisible();
    await context.close();
  });

  test('the task-queue page lists the partitions of tempolens-seed', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(`${BASE}/namespaces/${NS}/task-queues/tempolens-seed`);
    await expect(page.getByText(/partition/i).first()).toBeVisible({ timeout: 20_000 });
    const partitions = await apiGet<{ activityTaskQueuePartitions?: unknown[]; workflowTaskQueuePartitions?: unknown[] }>(
      'reader',
      `/api/x/task-queue-partitions?namespace=${NS}&taskQueue=tempolens-seed`,
    );
    expect(Object.keys(partitions).length, 'partition response has keys').toBeGreaterThan(0);
    await context.close();
  });

  test('the admin bulk-deletes two tui-test workflows after typing the count and a reason', async ({ browser }) => {
    const stamp = Date.now().toString(36);
    const ns = `tui-test-batch-${RUN_ID}-${stamp}`;
    const ids = [`tui-test-bd-${stamp}-1`, `tui-test-bd-${stamp}-2`];
    const admin = await signedIn(browser, 'admin');
    const adminHeaders = { Cookie: `__Host-tempolens_session=${cookieFor('admin')}`, 'X-Tempolens': '1', Origin: BASE, 'Content-Type': 'application/json' };
    try {
      const reg = await fetch(`${BASE}/api/v1/namespaces`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ namespace: ns, workflowExecutionRetentionPeriod: '86400s' }),
      });
      expect(reg.status).toBe(200);
      // A new namespace needs a few seconds before its search attributes answer.
      await expect.poll(async () => (await fetch(`${BASE}/api/v1/namespaces/${ns}/search-attributes`, { headers: adminHeaders })).status, { timeout: 30_000 }).toBe(200);
      for (const id of ids) {
        const start = await fetch(`${BASE}/api/v1/namespaces/${ns}/workflows/${id}`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ workflowType: { name: 'SeedWaiting' }, taskQueue: { name: 'tempolens-seed' } }),
        });
        expect(start.status).toBe(200);
      }

      const { page } = admin;
      const query = encodeURIComponent(`WorkflowId = '${ids[0]}' OR WorkflowId = '${ids[1]}'`);
      await page.goto(`${BASE}/namespaces/${ns}/workflows?query=${query}`);
      await expect(page.getByText(ids[0]).first()).toBeVisible({ timeout: 20_000 });
      const rows = page.getByRole('table', { name: /^Workflows/ }).locator('tbody input[type=checkbox]');
      await rows.nth(0).check();
      await rows.nth(1).check();
      await page.getByText(/^Bulk actions/).first().click();
      await page.getByText('Delete 2 selected').click();
      const dialog = page.locator('dialog').first();
      const submit = dialog.getByRole('button', { name: 'Delete 2 workflows' });
      await expect(submit).toBeDisabled();
      await dialog.locator('textarea').fill('phase 11 bulk delete check');
      await expect(submit).toBeDisabled();
      await dialog.locator('input').first().fill('2');
      await expect(submit).toBeEnabled();
      await submit.click();

      // The batch runs in the background: poll until both runs are gone.
      await expect.poll(async () => {
        const res = await fetch(`${BASE}/api/v1/namespaces/${ns}/workflows?query=${query}&pageSize=10`, { headers: adminHeaders });
        const body = (await res.json()) as { executions?: unknown[] };
        return body.executions?.length ?? 0;
      }, { timeout: 60_000 }).toBe(0);
    } finally {
      await fetch(`${BASE}/api/x/namespace?namespace=${ns}`, {
        method: 'DELETE',
        headers: { ...adminHeaders, 'X-Tempolens-Confirm': ns },
      });
      await admin.context.close();
    }
  });
});
