// LOCAL TEST ONLY. Opens the columns HTML report from disk in headless Chromium and checks that every image loads.
import { chromium } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT = path.resolve(import.meta.dirname, '../../plans/reports/tester-261029-0816-columns-console-e2e.html');
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(pathToFileURL(REPORT).href);
const loaded = await page.$$eval('img', (imgs) => imgs.map((i) => i.naturalWidth > 0));
await browser.close();
console.log(`images=${loaded.length} loaded=${loaded.filter(Boolean).length} consoleErrors=${errors.length}`);
if (loaded.length === 0 || loaded.some((x) => !x) || errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('report OK');
