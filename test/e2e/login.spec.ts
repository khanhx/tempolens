// LOCAL TEST ONLY. Real browser authorization-code login through Dex for each test user.
// Saves out/<user>.cookie for authz.sh and checks the role the server assigned.
import { expect, test } from '@playwright/test';
import { COOKIE_NAME, loginAs, signIn, TestUser } from './login';

const users: TestUser[] = ['writer', 'reader', 'admin', 'nogroups', 'padded'];

for (const user of users) {
  test(`${user} logs in through Dex and saves the session cookie`, async ({ baseURL }) => {
    const value = await loginAs(user, baseURL!);
    expect(value.length).toBeGreaterThan(0);

    const res = await fetch(`${baseURL}/api/v1/settings`, {
      headers: { Cookie: `__Host-tempolens_session=${value}` },
    });
    expect(res.status).toBe(200);
    const settings = (await res.json()) as { DisableWriteActions: boolean };
    // Writer and admin get write actions. The padded group is not an exact match, and nogroups has no groups.
    expect(settings.DisableWriteActions).toBe(user !== 'writer' && user !== 'admin');
  });
}

test('two concurrent logins both succeed', async ({ baseURL }) => {
  const [writer, reader] = await Promise.all([loginAs('writer', baseURL!), loginAs('reader', baseURL!)]);
  expect(writer.length).toBeGreaterThan(0);
  expect(reader.length).toBeGreaterThan(0);
  expect(writer).not.toBe(reader);
});

// Dex keeps its own session and has no end-session endpoint, so sending the browser to '/' after
// logout would sign the user straight back in. The signed-out page must hold still.
test('sign out lands on the signed-out page and stays there', async ({ page, baseURL }) => {
  await signIn(page, 'writer', baseURL!);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/auth/signed-out');
  await expect(page.getByRole('heading', { name: 'You have been signed out' })).toBeVisible();

  await page.waitForTimeout(5000); // The production bounce back through Dex took about 3 s.
  expect(new URL(page.url()).pathname).toBe('/auth/signed-out');
  expect((await page.context().cookies(baseURL)).find((c) => c.name === COOKIE_NAME)).toBeUndefined();
  await expect(page.getByRole('link', { name: 'Sign in again' })).toHaveAttribute('href', '/auth/sso?returnTo=%2F');
});
