// LOCAL TEST ONLY. Real browser authorization-code login through Dex for each test user.
// Saves out/<user>.cookie for authz.sh and checks the role the server assigned.
import { expect, test } from '@playwright/test';
import { loginAs, TestUser } from './login';

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
