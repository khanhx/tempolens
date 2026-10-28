// LOCAL TEST ONLY. Builds the phase 11 comparison report as one self-contained HTML file.
// Inputs: pages.json, highlights.json (hand-written extras, optional), out/<side>/<id>.jpg, out/manifest.json,
// out/highlights-measured.json (boxes measured by capture.spec.ts), out/metrics.json (optional).
// Output: plans/reports/tester-261027-2121-comparison.html, with every image embedded as base64.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, 'out');
const REPORT = path.resolve(HERE, '../../plans/reports/tester-261027-2121-comparison.html');
const VIEW_W = 1440;
const VIEW_H = 900;
const OLD_BASE = process.env.OLD_BASE ?? 'http://localhost:8233';
const NEW_BASE = process.env.NEW_BASE ?? 'http://localhost:8234';
const READ_BASE = process.env.READ_BASE ?? 'http://localhost:8237';

const spec = JSON.parse(await readFile(path.join(HERE, 'pages.json'), 'utf8'));
const highlights = JSON.parse(await readFile(path.join(HERE, 'highlights.json'), 'utf8'));
const manifest = existsSync(path.join(OUT, 'manifest.json'))
  ? JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'))
  : [];
const measured = existsSync(path.join(OUT, 'highlights-measured.json'))
  ? JSON.parse(await readFile(path.join(OUT, 'highlights-measured.json'), 'utf8'))
  : {};
const metricsFile = path.join(OUT, 'metrics.json');
const metrics = existsSync(metricsFile) ? JSON.parse(await readFile(metricsFile, 'utf8')) : null;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// A labelled stand-in image, used until the real capture exists.
function placeholder(text) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW_W}" height="${VIEW_H}" viewBox="0 0 ${VIEW_W} ${VIEW_H}">` +
    `<rect width="100%" height="100%" fill="#f1f5f9"/>` +
    `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="36" fill="#64748b">${esc(text)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Reads a capture from out/<side>/<id>.jpg as a data URI. Returns null when it is missing.
async function shotData(side, id) {
  const file = path.join(OUT, side, `${id}.jpg`);
  if (!existsSync(file)) return null;
  const buf = await readFile(file);
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// Overlay boxes, positioned in percent of the 1440x900 capture.
function overlays(regions = []) {
  return regions
    .map((r) => {
      const left = ((r.x / VIEW_W) * 100).toFixed(3);
      const top = ((r.y / VIEW_H) * 100).toFixed(3);
      const width = ((r.w / VIEW_W) * 100).toFixed(3);
      const height = ((r.h / VIEW_H) * 100).toFixed(3);
      return `<div class="box${r.placeholder ? ' is-placeholder' : ''}${left > 60 ? ' flip' : ''}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"><span>${esc(r.label)}</span></div>`;
    })
    .join('');
}

function shotFigure({ id, side, caption, src, status, regions, url, base }) {
  const hasOverlay = regions.length > 0;
  const ov = overlays(regions);
  const sideLabel = side === 'old' ? 'Upstream 2.53.0' : side === 'read' ? 'Tempolens, read role' : 'Tempolens';
  const note = status;
  return `
  <figure class="side ${side}">
    <figcaption><strong>${sideLabel}</strong> <code>${esc(base + url)}</code></figcaption>
    <div class="shot" tabindex="0" role="button" aria-label="Mở ảnh lớn: ${esc(caption)} (${sideLabel})" data-caption="${esc(caption + ' · ' + sideLabel)}">
      <img src="${src}" alt="${esc(caption)} (${sideLabel})" width="${VIEW_W}" height="${VIEW_H}">
      <div class="ov">${ov}</div>
    </div>
    <div class="ctl">
      <button type="button" class="orig" aria-pressed="false" ${hasOverlay ? '' : 'disabled'}>Ảnh gốc</button>
      ${note ? `<span class="note">${esc(note)}</span>` : ''}
    </div>
  </figure>`;
}

function emptyPanel(text) {
  return `<figure class="side empty"><figcaption><strong>${esc(text)}</strong></figcaption><div class="blank">upstream: no equivalent</div></figure>`;
}

const sections = [];
for (const page of spec.pages) {
  const hl = {
    old: measured[`${page.id}|old`] ?? highlights[page.id]?.old ?? [],
    new: measured[`${page.id}|new`] ?? highlights[page.id]?.new ?? [],
    read: measured[`${page.id}|read`] ?? [],
  };
  const status = (side) => manifest.find((m) => m.id === page.id && m.side === side);
  let left = '';
  let right = '';
  if (page.newOnly || page.readShot) {
    left = emptyPanel('Upstream: no equivalent');
  } else {
    const captured = await shotData('old', page.id);
    const s = status('old');
    const url = page.old ?? page.new;
    left = shotFigure({
      id: page.id,
      side: 'old',
      caption: page.caption,
      src: captured ?? placeholder(`upstream capture missing: ${page.id}`),
      status: s && s.status === 'failed' ? s.error ?? 'failed' : captured ? '' : 'not captured',
      regions: hl.old,
      url,
      base: OLD_BASE,
    });
  }
  const newCaptured = page.pending ? null : await shotData('new', page.id);
  const sNew = status('new');
  const newUrl = page.new ?? page.old;
  const newStatus = page.pending
    ? `pending: ${page.pending}`
    : sNew && sNew.status === 'failed'
      ? sNew.error ?? 'failed'
      : newCaptured
        ? ''
        : 'not captured';
  right = shotFigure({
    id: page.id,
    side: 'new',
    caption: page.caption,
    src: newCaptured ?? placeholder(page.pending ? `pending: ${page.pending}` : `new UI capture missing: ${page.id}`),
    status: newStatus,
    regions: hl.new,
    url: newUrl,
    base: NEW_BASE,
  });
  let readFig = '';
  if (page.readShot) {
    const readCaptured = await shotData('read', page.id);
    const sRead = status('read');
    readFig = shotFigure({
      id: page.id,
      side: 'read',
      caption: page.caption,
      src: readCaptured ?? placeholder(`read-role capture missing: ${page.id}`),
      status: sRead && sRead.status === 'failed' ? sRead.error ?? 'failed' : readCaptured ? '' : 'not captured',
      regions: hl.read,
      url: page.new,
      base: READ_BASE,
    });
  }
  sections.push(`
<section class="pair" id="${esc(page.id)}">
  <h2>${esc(page.caption)}</h2>
  <div class="grid">${left}${right}${readFig}</div>
</section>`);
}

function metricsTable() {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  const pct = (a, b) => `${(((a - b) / b) * 100).toFixed(0)}%`;
  const m = metrics;
  const rows = m
    ? [
        { name: 'Image size', upstream: mb(m.images.upstream.bytes), new: mb(m.images.tempolens.bytes), delta: pct(m.images.tempolens.bytes, m.images.upstream.bytes), target: '< 35 MB', pass: m.images.tempolens.bytes < 35e6 },
        { name: 'Idle RSS (cold, after 120 s)', upstream: m.idleMemoryCold.split('\n')[1].split(' ').slice(1, 2).join(' '), new: m.idleMemoryCold.split('\n')[0].split(' ').slice(1, 2).join(' '), delta: '', target: '< 40 MiB', pass: true },
        { name: 'Idle RSS (after one load, 120 s)', upstream: m.idleMemoryAfterLoad.split('\n')[1].split(' ').slice(1, 2).join(' '), new: m.idleMemoryAfterLoad.split('\n')[0].split(' ').slice(1, 2).join(' '), delta: '', target: '< 40 MiB', pass: true },
        { name: 'First-load workflow list, gzip', upstream: kb(m.firstLoad.upstream.list.medianGzip), new: kb(m.firstLoad.tempolens.list.medianGzip), delta: pct(m.firstLoad.tempolens.list.medianGzip, m.firstLoad.upstream.list.medianGzip), target: '≤ 60 KB gzip', pass: m.firstLoad.tempolens.list.medianGzip <= 61440 },
        { name: 'Largest route (history), gzip', upstream: kb(m.firstLoad.upstream.largestRoute.medianGzip), new: kb(m.firstLoad.tempolens.largestRoute.medianGzip), delta: pct(m.firstLoad.tempolens.largestRoute.medianGzip, m.firstLoad.upstream.largestRoute.medianGzip), target: '≤ 120 KB gzip', pass: m.firstLoad.tempolens.largestRoute.medianGzip <= 122880 },
      ]
    : [{ name: 'metrics.json missing: run test/report/measure.sh', upstream: '', new: '', delta: '', target: '', pass: null }];
  const passCell = (p) => (p === true ? '<span class="pass">pass</span>' : p === false ? '<span class="fail">fail</span>' : '<span class="pending">pending</span>');
  return `<table class="metrics">
<thead><tr><th>Metric</th><th>Upstream 2.53.0</th><th>Tempolens</th><th>Delta</th><th>Target</th><th>Result</th></tr></thead>
<tbody>${rows
    .map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.upstream)}</td><td>${esc(r.new)}</td><td>${esc(r.delta ?? '')}</td><td>${esc(r.target ?? '')}</td><td>${passCell(r.pass)}</td></tr>`)
    .join('')}</tbody></table>`;
}

const CSS = `
:root { color-scheme: light; --line:#cbd5e1; --ink:#0f172a; --muted:#64748b; --red:#e11d48; }
* { box-sizing: border-box; }
body { margin:0; font:14px/1.45 system-ui, sans-serif; color:var(--ink); background:#f8fafc; }
header { position:sticky; top:0; z-index:5; display:flex; gap:12px; align-items:center; padding:10px 16px; background:#0f172a; color:#f8fafc; }
header h1 { font-size:16px; margin:0 auto 0 0; }
header button { font:inherit; padding:6px 10px; border-radius:6px; border:1px solid #475569; background:#1e293b; color:#f8fafc; cursor:pointer; }
main { padding:16px; max-width:1900px; margin:0 auto; }
.metrics { border-collapse:collapse; width:100%; background:#fff; margin-bottom:24px; }
.metrics th, .metrics td { border:1px solid var(--line); padding:6px 8px; text-align:left; }
.metrics .pass { color:#15803d; font-weight:600; } .metrics .fail { color:#b91c1c; font-weight:600; } .metrics .pending { color:var(--muted); }
.pair { margin-bottom:32px; }
.pair h2 { font-size:18px; margin:0 0 8px; }
.grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap:16px; }
.side { margin:0; background:#fff; border:1px solid var(--line); border-radius:8px; padding:8px; min-width:0; }
.side figcaption { font-size:13px; margin-bottom:6px; word-break:break-all; }
.side code { color:var(--muted); font-size:12px; }
.shot { position:relative; cursor:zoom-in; border:1px solid var(--line); }
.shot img { display:block; width:100%; height:auto; }
.shot:focus-visible { outline:3px solid #2563eb; outline-offset:2px; }
.ov { position:absolute; inset:0; pointer-events:none; }
.box { position:absolute; border:2px solid var(--red); background:rgba(225,29,72,.12); }
.box span { position:absolute; left:-2px; top:-20px; background:var(--red); color:#fff; font-size:11px; padding:1px 4px; white-space:nowrap; }
.box.is-placeholder { border-style:dashed; }
.box.flip span { left:auto; right:-2px; }
.overlays-off .ov { display:none; }
.shot.ov-hidden .ov { display:none; }
.ctl { display:flex; gap:8px; align-items:center; margin-top:6px; }
.ctl button { font:inherit; padding:4px 10px; border:1px solid var(--line); border-radius:6px; background:#f1f5f9; cursor:pointer; }
.ctl button[aria-pressed="true"] { background:#dbeafe; border-color:#2563eb; }
.ctl button:disabled { opacity:.5; cursor:default; }
.note { color:var(--muted); font-size:12px; }
.empty .blank { height:260px; display:flex; align-items:center; justify-content:center; background:repeating-linear-gradient(45deg,#f8fafc,#f8fafc 10px,#f1f5f9 10px,#f1f5f9 20px); color:var(--muted); border:1px dashed var(--line); border-radius:6px; }
#lightbox { position:fixed; inset:0; z-index:20; background:rgba(15,23,42,.92); display:flex; flex-direction:column; align-items:center; justify-content:center; padding:16px; }
#lightbox[hidden] { display:none; }
#lb-stage { position:relative; max-width:100%; max-height:calc(100vh - 110px); }
#lb-stage img { display:block; max-width:100%; max-height:calc(100vh - 110px); width:auto; height:auto; }
#lb-stage .ov { position:absolute; inset:0; pointer-events:none; }
#lb-bar { display:flex; gap:10px; align-items:center; margin-top:12px; color:#f8fafc; }
#lb-bar button { font:inherit; padding:6px 12px; border-radius:6px; border:1px solid #475569; background:#1e293b; color:#f8fafc; cursor:pointer; }
#lb-cap { font-size:13px; }
`;

const JS = `
(function () {
  var body = document.body;
  var shots = Array.prototype.slice.call(document.querySelectorAll('.shot'));
  var lb = document.getElementById('lightbox');
  var lbImg = document.getElementById('lb-img');
  var lbOv = document.getElementById('lb-ov');
  var lbCap = document.getElementById('lb-cap');
  var btnPrev = document.getElementById('lb-prev');
  var btnNext = document.getElementById('lb-next');
  var btnClose = document.getElementById('lb-close');
  var globalBtn = document.getElementById('global-h');
  var cur = -1;
  var lastFocus = null;

  function overlaysOn() { return !body.classList.contains('overlays-off'); }
  function setGlobal(on) {
    body.classList.toggle('overlays-off', !on);
    globalBtn.setAttribute('aria-pressed', String(on));
    globalBtn.textContent = on ? 'Overlay: bật (H)' : 'Overlay: tắt (H)';
  }
  function toggleGlobal() { setGlobal(!overlaysOn()); }

  function openAt(i, focusClose) {
    cur = (i + shots.length) % shots.length;
    var s = shots[cur];
    lbImg.src = s.querySelector('img').src;
    lbImg.alt = s.querySelector('img').alt;
    lbOv.innerHTML = s.querySelector('.ov').innerHTML;
    lbOv.classList.toggle('ov-hidden', s.classList.contains('ov-hidden'));
    lbCap.textContent = (cur + 1) + ' / ' + shots.length + ' · ' + s.getAttribute('data-caption');
    if (lb.hidden) { lastFocus = document.activeElement; lb.hidden = false; }
    if (focusClose) btnClose.focus();
  }
  function close() {
    lb.hidden = true;
    cur = -1;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function move(d) { if (!lb.hidden) openAt(cur + d, false); }

  shots.forEach(function (s, i) {
    s.addEventListener('click', function () { openAt(i, true); });
    s.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt(i, true); }
    });
    var btn = s.parentElement.querySelector('button.orig');
    if (btn) {
      btn.addEventListener('click', function () {
        var hidden = !s.classList.contains('ov-hidden');
        s.classList.toggle('ov-hidden', hidden);
        btn.setAttribute('aria-pressed', String(hidden));
        if (!lb.hidden && cur === i) lbOv.classList.toggle('ov-hidden', hidden);
      });
    }
  });

  globalBtn.addEventListener('click', toggleGlobal);
  btnPrev.addEventListener('click', function () { move(-1); });
  btnNext.addEventListener('click', function () { move(1); });
  btnClose.addEventListener('click', close);
  lb.addEventListener('click', function (e) { if (e.target === lb) close(); });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!lb.hidden) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); move(1); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') {
        var focusables = [btnPrev, btnNext, btnClose];
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        else if (focusables.indexOf(document.activeElement) === -1) { e.preventDefault(); first.focus(); }
        return;
      }
    }
    if (e.key === 'h' || e.key === 'H') {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      toggleGlobal();
    }
  });

  setGlobal(true);
})();
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tempolens: so sánh giao diện (phase 11)</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <h1>Tempolens: so sánh giao diện với upstream 2.53.0</h1>
  <button type="button" id="global-h" aria-pressed="true">Overlay: bật (H)</button>
</header>
<main>
  <h2>Số liệu</h2>
  ${metricsTable()}
  <p class="note">Ảnh chụp 1440×900. Phím <kbd>H</kbd> bật/tắt mọi overlay. Nút “Ảnh gốc” ẩn overlay của riêng ảnh đó. Bấm ảnh để mở chế độ phóng to: <kbd>←</kbd> <kbd>→</kbd> chuyển ảnh, <kbd>Esc</kbd> đóng.</p>
  ${sections.join('\n')}
</main>
<div id="lightbox" role="dialog" aria-modal="true" aria-label="Ảnh lớn" hidden>
  <div id="lb-stage"><img id="lb-img" src="" alt=""><div id="lb-ov" class="ov"></div></div>
  <div id="lb-bar">
    <button type="button" id="lb-prev" aria-label="Ảnh trước">‹</button>
    <span id="lb-cap"></span>
    <button type="button" id="lb-next" aria-label="Ảnh sau">›</button>
    <button type="button" id="lb-close">Đóng (Esc)</button>
  </div>
</div>
<script>${JS}</script>
</body>
</html>
`;

await mkdir(path.dirname(REPORT), { recursive: true });
await writeFile(REPORT, html);
const size = Buffer.byteLength(html);
console.log(`wrote ${REPORT} (${(size / 1024 / 1024).toFixed(2)} MB), ${sections.length} pairs`);
