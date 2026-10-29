// LOCAL TEST ONLY. Screenshots of the command console states, for the columns and console HTML report.
// Writes out/console/<shot>.png. Needs the reader and writer cookies from test/e2e/out. Nothing here submits a
// mutating call: the dialog shot is cancelled, and the workflow it names does not exist.
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'out', 'console');
const cookie = (user: string) => readFileSync(path.join(HERE, '..', 'e2e', 'out', `${user}.cookie`), 'utf8').trim();
const NS = 'tui-seed-a';
const CONSOLE = `${BASE}/namespaces/${NS}/console`;

// The per-user limit is 5 requests per second with a burst of 10, so each shot waits before it loads.
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
});

test.beforeAll(() => {
  if (!RUN_ID) throw new Error('RUN_ID must be set');
  mkdirSync(OUT, { recursive: true });
});

async function signIn(page: Page, user: string) {
  await page.context().addCookies([
    { name: '__Host-tempolens_session', value: cookie(user), domain: 'localhost', path: '/', httpOnly: true, secure: true },
  ]);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}

const command = (page: Page) => page.getByRole('combobox', { name: 'Command' });
const result = (page: Page) => page.getByRole('region', { name: 'Result' });

test.describe('console states', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('CLI result as a table', async ({ page }) => {
    await signIn(page, 'reader');
    await page.goto(CONSOLE);
    await command(page).fill(`workflow list --query 'WorkflowType = "SeedGreet"'`);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(result(page).getByRole('status')).toHaveText(/^Done/, { timeout: 20_000 });
    await expect(result(page).getByRole('table')).toBeVisible();
    await shot(page, '05-console-cli-result-table');
  });

  test('read user sees the write reason on a mutating command', async ({ page }) => {
    await signIn(page, 'reader');
    await page.goto(CONSOLE);
    await command(page).fill('workflow terminate --workflow-id seed-running-1 --reason test');
    await expect(page.locator('#console-cli-denied')).toBeVisible();
    await shot(page, '06-console-read-denied');
  });

  test('confirm dialog for a terminate, before anything is sent', async ({ page }) => {
    await signIn(page, 'writer');
    await page.goto(CONSOLE);
    await command(page).fill('workflow terminate --workflow-id tui-test-console-shot --reason "screenshot"');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm TerminateWorkflowExecution' });
    await expect(dialog).toBeVisible();
    await shot(page, '07-console-confirm-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('raw mode with one read method and its result', async ({ page }) => {
    await signIn(page, 'reader');
    await page.goto(CONSOLE);
    await page.getByRole('tab', { name: 'Raw gRPC' }).click();
    await page.getByLabel('Method').selectOption({ label: 'DescribeWorkflowExecution' });
    await page.getByLabel('Request JSON').fill(JSON.stringify({ namespace: NS, execution: { workflowId: 'seed-completed-1' } }));
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(result(page)).toContainText('WORKFLOW_EXECUTION_STATUS_COMPLETED', { timeout: 20_000 });
    await shot(page, '08-console-raw-mode');
  });
});
