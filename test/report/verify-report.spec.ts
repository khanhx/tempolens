// LOCAL TEST ONLY. Checks the comparison report's interactions headless, opened from disk (file://).
import { expect, test } from '@playwright/test';
import path from 'node:path';

const REPORT = path.resolve(import.meta.dirname, '../../plans/reports/tester-261027-2121-comparison.html');
const SHOT_PATH = path.join(import.meta.dirname, 'out', 'report-verify.png');

test('report interactions work from disk', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`file://${REPORT}`);

  const shots = page.locator('.shot');
  const count = await shots.count();
  expect(count, 'report has image panels').toBeGreaterThanOrEqual(3);

  // Image 3 must have overlays, or the per-image check proves nothing.
  const boxesIn = (i: number) => shots.nth(i).locator('.box');
  const visibleIn = (i: number) => shots.nth(i).locator('.box:visible');
  expect(await boxesIn(2).count(), 'image 3 has overlay boxes').toBeGreaterThan(0);

  const totalVisible = () => page.locator('.shot .box:visible').count();
  const totalBoxes = await page.locator('.shot .box').count();
  expect(await totalVisible(), 'all overlays visible on load').toBe(totalBoxes);

  // H toggles every overlay, and a second press restores them.
  await page.keyboard.press('h');
  expect(await totalVisible(), 'H hides every overlay').toBe(0);
  await page.keyboard.press('H');
  expect(await totalVisible(), 'H restores every overlay').toBe(totalBoxes);

  // "Ảnh gốc" on image 3 hides only that image's overlay.
  const before1 = await visibleIn(0).count();
  const before3 = await visibleIn(2).count();
  const toggle3 = page.locator('figure.side:has(.shot)').nth(2).locator('button.orig');
  await toggle3.click();
  expect(await toggle3.getAttribute('aria-pressed'), 'Ảnh gốc pressed on image 3').toBe('true');
  expect(await visibleIn(2).count(), 'image 3 overlay hidden').toBe(0);
  expect(await visibleIn(0).count(), 'image 1 overlay unchanged').toBe(before1);
  expect(await totalVisible(), 'only image 3 lost overlays').toBe(totalBoxes - before3);
  await toggle3.click();
  expect(await visibleIn(2).count(), 'image 3 overlay restored').toBe(before3);

  // Lightbox: open image 1, step with the arrow keys and the buttons, then close with Esc.
  const lb = page.locator('#lightbox');
  const lbCaption = page.locator('#lb-cap');
  const lbSrc = () => page.locator('#lb-img').getAttribute('src');
  await shots.nth(0).click();
  await expect(lb).toBeVisible();
  const src1 = await shots.nth(0).locator('img').getAttribute('src');
  const src2 = await shots.nth(1).locator('img').getAttribute('src');
  expect(await lbSrc(), 'lightbox shows image 1').toBe(src1);

  await page.keyboard.press('ArrowRight');
  expect(await lbSrc(), '→ shows image 2').toBe(src2);
  await expect(lbCaption).toContainText('2 / ');
  await page.keyboard.press('ArrowLeft');
  expect(await lbSrc(), '← goes back to image 1').toBe(src1);

  await page.locator('#lb-next').click();
  expect(await lbSrc(), '› advances to image 2').toBe(src2);
  await page.locator('#lb-prev').click();
  expect(await lbSrc(), '‹ goes back to image 1').toBe(src1);

  // Focus stays inside the lightbox while it is open.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('#lightbox'));
    expect(inside, `focus stays in the lightbox after Tab ${i + 1}`).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(lb).toBeHidden();

  await page.screenshot({ path: SHOT_PATH, fullPage: false });
  expect(errors, 'no console errors').toEqual([]);
});
