// LOCAL TEST ONLY. Logs in through the local Dex password connector and saves the Tempolens
// session cookie to out/<user>.cookie, which authz.sh sends as a header.
import { chromium, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const COOKIE_NAME = '__Host-tempolens_session';
export const TEST_PASSWORD = 'password'; // LOCAL TEST ONLY: static Dex password for every test user.
export const OUT_DIR = path.join(__dirname, "out");

export type TestUser = 'writer' | 'reader' | 'admin' | 'nogroups' | 'padded';

export function emailFor(user: TestUser): string {
  return `${user}@example.test`;
}

/** Signs in through the Dex password form on page and waits until it is back on baseURL. */
export async function signIn(page: Page, user: TestUser, baseURL: string): Promise<void> {
  await page.goto('/auth/sso?returnTo=/');
  // Dex shows the password form for the local connector. Field names follow Dex's login template.
  await page.waitForURL(/\/dex\//);
  await page.fill('input[name="login"]', emailFor(user));
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => url.origin === new URL(baseURL).origin);
}

export async function loginAs(user: TestUser, baseURL: string): Promise<string> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await signIn(page, user, baseURL);
    const cookie = (await context.cookies(baseURL)).find((c) => c.name === COOKIE_NAME);
    if (!cookie) {
      throw new Error(`no ${COOKIE_NAME} cookie after login as ${user}`);
    }
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(path.join(OUT_DIR, `${user}.cookie`), cookie.value, { mode: 0o600 });
    return cookie.value;
  } finally {
    await browser.close();
  }
}
