// LOCAL TEST ONLY. The command console, per role. Reads run on tui-seed-a. Writes run only on tui-test-* data:
// a workflow this spec starts, and a namespace this spec creates and deletes. A read user's mutating command is
// disabled with the write reason and refused by the server. A write user's terminate needs the typed confirm, and
// an admin-only command is refused for write and runs for admin. Requires RUN_ID and cookies in out/<user>.cookie.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const OUT = path.join(__dirname, 'out');
const SEED_NS = 'tui-seed-a';
const INVOKE_PATH = '/api/x/console/invoke';
const WF = '/temporal.api.workflowservice.v1.WorkflowService/';
const OP = '/temporal.api.operatorservice.v1.OperatorService/';

// Every namespace and workflow these tests create is prefixed tui-test-, and only those are mutated or deleted.
const STAMP = `${RUN_ID}-${Date.now().toString(36)}`;
const TEST_NS = `tui-test-console-${STAMP}`;
const ADMIN_NS = `tui-test-console-admin-${STAMP}`;
const TEST_WF = `tui-test-console-wf-${STAMP}`;
const MISSING_WF = `tui-test-console-missing-${STAMP}`;

function cookieFor(user: string): string {
  return readFileSync(path.join(OUT, `${user}.cookie`), 'utf8').trim();
}

// Headers the API checks on writes: the session cookie, X-Tempolens, and the browser Origin.
function headersFor(user: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Cookie: `__Host-tempolens_session=${cookieFor(user)}`, 'X-Tempolens': '1', Origin: BASE, 'Content-Type': 'application/json', ...extra };
}

async function ensureNamespace(ns: string): Promise<void> {
  const reg = await fetch(`${BASE}/api/v1/namespaces`, {
    method: 'POST',
    headers: headersFor('admin'),
    body: JSON.stringify({ namespace: ns, workflowExecutionRetentionPeriod: '86400s' }),
  });
  expect(reg.status).toBe(200);
  // A new namespace needs a few seconds before its search attributes answer.
  await expect.poll(async () => (await fetch(`${BASE}/api/v1/namespaces/${ns}/search-attributes`, { headers: headersFor('admin') })).status, { timeout: 30_000 }).toBe(200);
}

async function deleteNamespace(ns: string): Promise<void> {
  await fetch(`${BASE}/api/x/namespace?namespace=${ns}`, { method: 'DELETE', headers: headersFor('admin', { 'X-Tempolens-Confirm': ns }) });
}

// Sends one console call straight to the server, as the given user, and returns the response.
function invokeAs(user: string, method: string, request: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${INVOKE_PATH}`, { method: 'POST', headers: headersFor(user, extra), body: JSON.stringify({ method, request }) });
}

test.beforeAll(async () => {
  if (!RUN_ID) throw new Error('RUN_ID must be set');
  // The write tests run in this namespace. Created here so file order does not matter.
  await ensureNamespace(TEST_NS);
});

// Deletes only namespaces that still exist. Deleting one that is already gone hangs for about 30 s and then returns 500.
async function deleteNamespaceIfPresent(ns: string): Promise<void> {
  const res = await fetch(`${BASE}/api/v1/namespaces/${ns}`, { headers: headersFor('admin') });
  if (res.status === 200) await deleteNamespace(ns);
}

test.afterAll(async () => {
  await deleteNamespaceIfPresent(TEST_NS);
  await deleteNamespaceIfPresent(ADMIN_NS);
});

// The per-user limit is 5 requests per second with a burst of 10, and each console call counts toward it.
// Each test waits before it loads a page, so the bucket refills and the tests do not see "too many requests".
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

async function signedIn(browser: Browser, user: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: '__Host-tempolens_session', value: cookieFor(user), domain: 'localhost', path: '/', httpOnly: true, secure: true },
  ]);
  return { context, page: await context.newPage() };
}

const consoleUrl = (ns: string) => `${BASE}/namespaces/${ns}/console`;
const command = (page: Page) => page.getByRole('combobox', { name: 'Command' });
const runButton = (page: Page) => page.getByRole('button', { name: 'Run', exact: true });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });

// Clicks a button that calls the console endpoint, waits for that response, and checks the result says Done.
// Waiting for the response means the result read afterwards is this call's, not the one before it.
async function invokeFrom(page: Page, click: () => Promise<void>): Promise<void> {
  const reply = page.waitForResponse((r) => r.url().endsWith(INVOKE_PATH) && r.request().method() === 'POST');
  await click();
  await reply;
  await expect(result(page).getByRole('status')).toHaveText(/^Done/, { timeout: 20_000 });
}

async function runCli(page: Page, line: string): Promise<void> {
  await command(page).fill(line);
  await invokeFrom(page, () => runButton(page).click());
}

test.describe('console, read role', () => {
  test('a read command runs and its result names the workflow', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(consoleUrl(SEED_NS));
    await runCli(page, 'workflow describe --workflow-id seed-completed-1');
    // The result header repeats the CLI line, so check a field of the response itself.
    await expect(result(page)).toContainText('WORKFLOW_EXECUTION_STATUS_COMPLETED');
    await context.close();
  });

  test('a list shows a table, the JSON and Table toggles switch views, and Copy as CLI copies the line', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await page.goto(consoleUrl(SEED_NS));
    await runCli(page, `workflow list --query 'WorkflowType = "SeedGreet"'`);

    // A list response opens as a table by default.
    await expect(result(page).getByRole('table').getByRole('cell', { name: 'seed-completed-1', exact: true })).toBeVisible();
    await result(page).getByRole('button', { name: 'JSON', exact: true }).click();
    await expect(result(page).getByRole('button', { name: 'JSON', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(result(page)).toContainText('"executions"');
    await result(page).getByRole('button', { name: 'Table', exact: true }).click();
    await expect(result(page).getByRole('table')).toBeVisible();

    await page.getByRole('button', { name: 'Copy as CLI' }).click();
    await expect(page.getByRole('button', { name: 'Copy as CLI' })).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('workflow list');
    await context.close();
  });

  test('a mutating command is disabled for read with the write reason', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(consoleUrl(SEED_NS));
    await command(page).fill('workflow terminate --workflow-id seed-running-1 --reason test');
    await expect(runButton(page)).toBeDisabled();
    await expect(runButton(page)).toHaveAttribute('aria-describedby', 'console-cli-denied');
    await expect(page.locator('#console-cli-denied')).toHaveText('This action needs write access: sign in with a user in a write group.');
    await context.close();
  });

  test('the server refuses a read user a terminate, and the same call from write is not refused for the role', async () => {
    const terminate = { namespace: TEST_NS, workflowExecution: { workflowId: MISSING_WF }, reason: 'read check' };
    const confirm = { 'X-Tempolens-Confirm': MISSING_WF };
    const read = await invokeAs('reader', `${WF}TerminateWorkflowExecution`, terminate, confirm);
    expect(read.status).toBe(403);
    // The control: the same call from write gets past the role check and fails on the missing workflow.
    const write = await invokeAs('writer', `${WF}TerminateWorkflowExecution`, terminate, confirm);
    expect(write.status).not.toBe(403);
  });

  test('a parse error shows the alert and runs nothing', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(consoleUrl(SEED_NS));
    await command(page).fill('workflow describe');
    await runButton(page).click();
    await expect(page.getByRole('alert').filter({ hasText: 'needs --workflow-id' })).toBeVisible();
    await expect(result(page)).toHaveCount(0);
    await context.close();
  });
});

test.describe('console, raw mode', () => {
  test('the Raw gRPC tab runs one read method with a JSON request', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(consoleUrl(SEED_NS));
    await page.getByRole('tab', { name: 'Raw gRPC' }).click();
    await page.getByLabel('Method').selectOption({ label: 'DescribeWorkflowExecution' });
    await page.getByLabel('Request JSON').fill(JSON.stringify({ namespace: SEED_NS, execution: { workflowId: 'seed-completed-1' } }));
    await invokeFrom(page, () => runButton(page).click());
    // The JSON view opens two levels deep, so the workflow ID inside the execution is collapsed. Check a shallow field.
    await expect(result(page)).toContainText('WORKFLOW_EXECUTION_STATUS_COMPLETED');
    await context.close();
  });

  test('a read user sees a write method disabled in raw mode with the reason', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(consoleUrl(SEED_NS));
    await page.getByRole('tab', { name: 'Raw gRPC' }).click();
    await page.getByLabel('Method').selectOption({ label: 'TerminateWorkflowExecution (write)' });
    await expect(runButton(page)).toBeDisabled();
    await expect(page.locator('#console-raw-denied')).toContainText('needs write access');
    await context.close();
  });
});

test.describe('console, write role', () => {
  test('a write user starts, signals and terminates a tui-test workflow, and terminate needs the typed confirm', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(consoleUrl(TEST_NS));
    await runCli(page, `workflow start --namespace ${TEST_NS} --workflow-id ${TEST_WF} --type SeedWaiting --task-queue tempolens-seed`);
    await runCli(page, `workflow signal --namespace ${TEST_NS} --workflow-id ${TEST_WF} --name note --input '"console check"'`);

    await command(page).fill(`workflow terminate --namespace ${TEST_NS} --workflow-id ${TEST_WF} --reason "console e2e"`);
    await runButton(page).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm TerminateWorkflowExecution' });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole('button', { name: 'Confirm and run' });
    const typed = dialog.getByLabel(/to confirm the workflow ID/);
    await expect(confirm).toBeDisabled();
    await typed.fill('not-the-workflow');
    await expect(confirm).toBeDisabled();
    await typed.fill(TEST_WF);
    await invokeFrom(page, () => confirm.click());

    // The server state, not only the console's Done, shows the terminate landed.
    await expect
      .poll(async () => (await fetch(`${BASE}/api/v1/namespaces/${TEST_NS}/workflows/${TEST_WF}`, { headers: headersFor('writer') })).text(), { timeout: 20_000 })
      .toContain('TERMINATED');
    await context.close();
  });

  test('a write user sees an admin-only command disabled with the admin reason', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(consoleUrl(TEST_NS));
    await command(page).fill(`operator namespace create --namespace ${ADMIN_NS} --retention 1d`);
    await expect(runButton(page)).toBeDisabled();
    await expect(page.locator('#console-cli-denied')).toContainText('needs admin access');
    await context.close();
  });

  test('the server refuses a write user an admin-only call', async () => {
    const del = { namespace: MISSING_WF };
    const confirm = { 'X-Tempolens-Confirm': MISSING_WF };
    const write = await invokeAs('writer', `${OP}DeleteNamespace`, del, confirm);
    expect(write.status).toBe(403);
    const admin = await invokeAs('admin', `${OP}DeleteNamespace`, del, confirm);
    expect(admin.status).not.toBe(403);
  });
});

test.describe('console, admin role', () => {
  test('admin creates and deletes a tui-test namespace through operator commands', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'admin');
    await page.goto(consoleUrl(SEED_NS));
    await runCli(page, `operator namespace create --namespace ${ADMIN_NS} --retention 1d`);
    await expect
      .poll(async () => (await fetch(`${BASE}/api/v1/namespaces/${ADMIN_NS}`, { headers: headersFor('admin') })).status, { timeout: 30_000 })
      .toBe(200);

    await command(page).fill(`operator namespace delete --namespace ${ADMIN_NS}`);
    await runButton(page).click();
    const dialog = page.getByRole('dialog', { name: /Confirm DeleteNamespace/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/to confirm the namespace name/).fill(ADMIN_NS);
    await invokeFrom(page, () => dialog.getByRole('button', { name: 'Confirm and run' }).click());

    // A second delete of the same namespace must answer 404 at once. It used to hang for about 30 s and then return 500.
    const started = Date.now();
    const again = await fetch(`${BASE}/api/x/namespace?namespace=${ADMIN_NS}`, { method: 'DELETE', headers: headersFor('admin', { 'X-Tempolens-Confirm': ADMIN_NS }) });
    expect(again.status).toBe(404);
    expect(Date.now() - started).toBeLessThan(5_000);
    await context.close();
  });
});
