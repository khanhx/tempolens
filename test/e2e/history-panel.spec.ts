// LOCAL TEST ONLY. History tab detail panel on a seed run in tui-seed-a: a row opens the panel beside the list,
// Esc closes it, ↓/j move the selection, ?event survives a reload, and the JSON viewer offers Expand all.
// Requires RUN_ID (seed run) and cookies in out/writer.cookie, as functional.spec.ts does.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const RUN_ID = process.env.RUN_ID ?? '';
const NS = 'tui-seed-a';
const OUT = path.join(__dirname, 'out');

test.beforeAll(() => {
  if (!RUN_ID) throw new Error('RUN_ID must be set');
});

// The per-user limit is 5 requests per second with a burst of 10; let the bucket refill between tests.
test.beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 2500));
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

// A failed seed workflow: its history has activity, timer and workflow task groups.
const WF = `seed-failed-${RUN_ID}-1`;

async function historyUrl(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/namespaces/${NS}/workflows/${encodeURIComponent(WF)}`, {
    headers: { Cookie: `__Host-tempolens_session=${cookieFor('writer')}` },
  });
  expect(res.ok, `describe ${WF}: ${res.status}`).toBeTruthy();
  const d = (await res.json()) as { workflowExecutionInfo: { execution: { runId: string } } };
  return `${BASE}/namespaces/${NS}/workflows/${encodeURIComponent(WF)}/${d.workflowExecutionInfo.execution.runId}/history`;
}

const panelOf = (page: Page) => page.getByRole('complementary', { name: /^Event \d+ details$/ });

/** Clicks a cell of the first history row that is not its link, as a pointer user would. */
async function openFirstRow(page: Page): Promise<string> {
  const row = page.locator('tbody tr').filter({ has: page.locator('a.history-row-link') }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const id = (await row.locator('a.history-row-link').textContent())?.trim() ?? '';
  await row.locator('td').nth(2).click();
  return id;
}

test.describe('history detail panel', () => {
  test('a row opens the panel with Expand all, and Esc closes it', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(await historyUrl());
    const id = await openFirstRow(page);
    await expect(page).toHaveURL(new RegExp(`[?&]event=${id}(&|$)`));
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect(page.locator(`a.history-row-link[aria-current="true"]`)).toHaveText(id);
    await expect(panel.getByRole('link', { name: 'Open full page' })).toHaveAttribute('href', new RegExp(`/history/events/${id}`));
    await expect(panel.getByRole('button', { name: 'Expand all JSON nodes' }).first()).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]event=/);
    await context.close();
  });

  test('j moves the selection to the next row', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(await historyUrl());
    const id = await openFirstRow(page);
    await expect(panelOf(page)).toBeVisible();
    await page.keyboard.press('j');
    await expect(page).toHaveURL(/[?&]event=\d+/);
    await expect(page).not.toHaveURL(new RegExp(`[?&]event=${id}(&|$)`));
    await expect(panelOf(page)).toBeVisible();
    await context.close();
  });

  test('?event survives a reload', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'writer');
    await page.goto(await historyUrl());
    const id = await openFirstRow(page);
    await expect(panelOf(page)).toBeVisible();
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`[?&]event=${id}(&|$)`));
    await expect(panelOf(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`a.history-row-link[aria-current="true"]`)).toHaveText(id);
    await context.close();
  });
});
