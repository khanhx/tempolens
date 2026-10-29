// LOCAL TEST ONLY. Task queue index: the combobox suggests the seed workflows' task queue, inferred from
// recent workflows, and choosing it (by mouse or keyboard) opens that queue's workers page. Free text still works.
// Requires the seed (test/seed) in tui-seed-a and cookies in out/reader.cookie, as functional.spec.ts does.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:8236';
const NS = 'tui-seed-a';
// The queue test/seed/main.go runs every seed workflow and its worker on.
const QUEUE = 'tempolens-seed';
const OUT = path.join(__dirname, 'out');

// Loading suggestions makes a few sequential requests; the per-user limit is 5 per second with a burst of 10.
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

test.describe('task queue suggestions', () => {
  test('the seed queue is suggested and choosing it opens its workers page', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(`${BASE}/namespaces/${NS}/task-queues`);
    await expect(page.getByText('the list may be incomplete')).toBeVisible();
    const box = page.getByRole('combobox', { name: 'Task queue name' });
    await box.fill('SEED');
    const option = page.getByRole('option', { name: new RegExp(QUEUE) });
    await expect(option).toBeVisible();
    // The seed worker keeps workflows running on the queue, so the count comes from the rows already read.
    await expect(option).toContainText('running');
    await option.click();
    await expect(page).toHaveURL(`${BASE}/namespaces/${NS}/task-queues/${QUEUE}`);
    await expect(page.getByRole('heading', { level: 1, name: QUEUE })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workflow pollers' })).toBeVisible();
    await context.close();
  });

  test('keyboard choice and free text both open a workers page', async ({ browser }) => {
    const { context, page } = await signedIn(browser, 'reader');
    await page.goto(`${BASE}/namespaces/${NS}/task-queues`);
    const box = page.getByRole('combobox', { name: 'Task queue name' });
    await box.fill(QUEUE);
    await expect(page.getByRole('option', { name: new RegExp(QUEUE) })).toBeVisible();
    await box.press('ArrowDown');
    await expect(box).toHaveAttribute('aria-activedescendant', /.+/);
    await box.press('Enter');
    await expect(page).toHaveURL(`${BASE}/namespaces/${NS}/task-queues/${QUEUE}`);

    await page.goto(`${BASE}/namespaces/${NS}/task-queues`);
    await box.fill('e2e-no-such-queue');
    await box.press('Enter');
    await expect(page).toHaveURL(`${BASE}/namespaces/${NS}/task-queues/e2e-no-such-queue`);
    await expect(page.getByRole('heading', { level: 1, name: 'e2e-no-such-queue' })).toBeVisible();

    // Both queues were opened in this browser, so they come back as recent suggestions.
    await page.goto(`${BASE}/namespaces/${NS}/task-queues`);
    await box.focus();
    await expect(page.getByRole('option').first()).toContainText('e2e-no-such-queue');
    await context.close();
  });
});
