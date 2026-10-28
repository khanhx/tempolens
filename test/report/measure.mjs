// LOCAL TEST ONLY. First-load weight of the workflow list and the workflow history page, upstream
// temporalio/ui 2.53.0 against Tempolens. Run by measure.sh, which has already written
// out/metrics-runtime.json (image sizes and cold idle memory). This script adds the first-load
// numbers and writes out/metrics.json.
//
// Each page is loaded three times in a fresh context with the cache disabled. The median of the
// three runs is reported. Script and stylesheet responses are counted; the transfer size is the
// CDP encodedDataLength, the raw size is the decoded body, and the gzip size is the decoded body
// gzipped at level 9.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'out');
const NEW_BASE = process.env.NEW_BASE ?? 'http://127.0.0.1:8238';
const UP_BASE = process.env.UP_BASE ?? 'http://127.0.0.1:8235';
const NAMESPACE = process.env.NAMESPACE ?? 'tui-seed-a';
const PARENT = 'seed-parent-1';
const RUNS = 3;
// Targets from the plan: first load <= 60 KB gzip, any route <= 120 KB gzip.
const FIRST_LOAD_TARGET = 60 * 1024;
const ROUTE_TARGET = 120 * 1024;

async function parentRunId(base) {
  const res = await fetch(`${base}/api/v1/namespaces/${NAMESPACE}/workflows/${PARENT}`);
  if (!res.ok) throw new Error(`describe ${PARENT} on ${base}: ${res.status}`);
  const body = await res.json();
  return body.workflowExecutionInfo.execution.runId;
}

// Loads one URL in a fresh context with the cache disabled, then returns the script and
// stylesheet sizes that the page loaded before the wait selector and network idle.
async function measureOnce(browser, url, waitFor) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const assets = new Map();
  cdp.on('Network.responseReceived', (e) => {
    if (e.type === 'Script' || e.type === 'Stylesheet') {
      assets.set(e.requestId, { url: e.response.url, type: e.type, status: e.response.status });
    }
  });
  cdp.on('Network.loadingFinished', (e) => {
    const asset = assets.get(e.requestId);
    if (asset) asset.transfer = e.encodedDataLength;
  });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector(waitFor, { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));

  const files = [];
  for (const [requestId, asset] of assets) {
    if (asset.transfer === undefined) continue;
    const body = await cdp.send('Network.getResponseBody', { requestId });
    const raw = body.base64Encoded ? Buffer.from(body.body, 'base64') : Buffer.from(body.body);
    files.push({
      url: new URL(asset.url).pathname,
      type: asset.type,
      transfer: asset.transfer,
      raw: raw.length,
      gzip: zlib.gzipSync(raw, { level: 9 }).length,
    });
  }
  await context.close();
  const sum = (key) => files.reduce((acc, f) => acc + f[key], 0);
  return { transfer: sum('transfer'), raw: sum('raw'), gzip: sum('gzip'), files };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measurePage(browser, base, route, waitFor) {
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) {
    runs.push(await measureOnce(browser, `${base}${route}`, waitFor));
  }
  return {
    route,
    runs: runs.map(({ transfer, raw, gzip }) => ({ transfer, raw, gzip })),
    medianTransfer: median(runs.map((r) => r.transfer)),
    medianRaw: median(runs.map((r) => r.raw)),
    medianGzip: median(runs.map((r) => r.gzip)),
    files: runs[runs.length - 1].files,
  };
}

async function measureUi(browser, base) {
  const runId = await parentRunId(base);
  const list = await measurePage(browser, base, `/namespaces/${NAMESPACE}/workflows`, 'tbody tr');
  const history = await measurePage(
    browser,
    base,
    `/namespaces/${NAMESPACE}/workflows/${PARENT}/${runId}/history`,
    'tbody tr',
  );
  const largest = history.medianGzip > list.medianGzip ? history : list;
  return {
    list,
    history,
    largestRoute: { route: largest.route, medianGzip: largest.medianGzip },
  };
}

const browser = await chromium.launch();
let firstLoad;
try {
  firstLoad = {
    tempolens: await measureUi(browser, NEW_BASE),
    upstream: await measureUi(browser, UP_BASE),
  };
} finally {
  await browser.close();
}

const runtime = JSON.parse(await readFile(path.join(out, 'metrics-runtime.json'), 'utf8'));
const metrics = {
  measuredAt: new Date().toISOString(),
  ...runtime,
  firstLoad,
  targets: {
    firstLoadGzipBytes: FIRST_LOAD_TARGET,
    routeGzipBytes: ROUTE_TARGET,
    firstLoadPass: firstLoad.tempolens.list.medianGzip <= FIRST_LOAD_TARGET,
    largestRoutePass: firstLoad.tempolens.largestRoute.medianGzip <= ROUTE_TARGET,
  },
};
await writeFile(path.join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify(metrics.targets));
