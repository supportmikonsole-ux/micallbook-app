'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: Operator mode (docked)
   One department's view of the show, for a light / sound / spot / deck
   operator: their next cue large with its state, a clip of the script
   around its Warn / Standby / GO lines, and their next two cues.

   States of "my next cue" against the SM's calling position (Standby):
     WAITING  2 or more GO points away
     WARN     it is the GO after the SM's standby
     STANDBY  it is the SM's standby
     GO       just fired (green, ~1.5 s), then the next one moves up

   Follows this computer's calling, which follows the SM's computer when
   linked (link.js).

   Uses app.js / marks.js / calling.js globals.
   ════════════════════════════════════════════════════════════════════ */

const OP_DEPT_KEY  = 'micallbook.operatorDept';
const GO_SHOW_MS   = 1500;     // how long the green GO stays up
const EX_LINES_BEFORE = 2.2;   // excerpt: lines above the first marked line
const EX_LINES_AFTER  = 2.6;   // and below the last
const EX_SPLIT     = 0.22;     // marks further apart than this (fraction of a page) get separate clips
const PAGE_CACHE_MAX = 12;      // Operator view and Booth View excerpts share it

let opDept = null;             // department id this computer operates

function opLoadDept() {
  let code = null;
  try { code = localStorage.getItem(OP_DEPT_KEY); } catch (_) {}
  const d = show.departments.find(x => x.code === code) || show.departments[0] || null;
  opDept = d ? d.id : null;
}
function opSaveDept() {
  const d = deptById(opDept);
  try { if (d) localStorage.setItem(OP_DEPT_KEY, d.code); } catch (_) {}
}

function cuesOf(gp, dept) { return gp.cues.filter(c => c.dept === dept); }
function notCuesOf(gp, dept) { return gp.cues.filter(c => c.dept !== dept); }
function myCues(gp) { return cuesOf(gp, opDept); }
function otherCues(gp) { return notCuesOf(gp, opDept); }

// ── Which cue is a department's "now", and its state ──────────────────
function deptModel(dept) {
  const list = callList();
  const si = atEnd ? list.length : standbyIndex();
  const mine = [];
  list.forEach((gp, k) => { if (cuesOf(gp, dept).length) mine.push({ gp, k }); });
  const upcoming = mine.filter(m => m.k >= Math.max(0, si));
  const cur = upcoming[0] || null;
  let state = 'none';
  if (cur) {
    state = cur.k === si ? 'standby' : (cur.k === si + 1 ? 'warn' : 'waiting');
    // A cue with its own Warn / Standby points follows the SM's calls of them (Mike, 2026-10-20):
    // WARN once the Warning is called, STANDBY once the Standby is (or when it is the next GO)
    const st = !atEnd && list.length && typeof curStep === 'function' ? curStep() : null;
    if (st && hasSteps(st, cur.gp.id)) {
      state = (cur.k === si && st.kind === 'go') || stepCalled(st, cur.gp.id, 'standby') ? 'standby'
        : stepCalled(st, cur.gp.id, 'warn') ? 'warn' : 'waiting';
    }
  }
  return { list, si, mine, cur, next: upcoming.slice(1, 3), state };
}
function opModel() { return deptModel(opDept); }

// Mic names for a department's cues (mikast-link.js; nothing when the show isn't linked to MiKast)
function micWhoTexts(cues) {
  if (typeof micWhoText !== 'function') return [];
  return cues.map(micWhoText).filter(Boolean);
}

// GO flash for one department's view: the calling position moved forward
// past a GO point with one of its cues. Holds the GO for GO_SHOW_MS, then
// calls onExpire so the view can redraw. One tracker per view.
function makeFireTracker(onExpire) {
  let lastFlash = goFlash, lastStandby = null, fired = null, timer = 0;
  return {
    update(m, dept) {
      if (goFlash !== lastFlash) {
        const prev = m.si > 0 ? m.list[m.si - 1] : null;
        if (prev && prev.id === lastStandby && cuesOf(prev, dept).length) {
          fired = { gpId: prev.id, until: performance.now() + GO_SHOW_MS };
          clearTimeout(timer);
          timer = setTimeout(onExpire, GO_SHOW_MS + 30);
        }
        lastFlash = goFlash;
      }
      lastStandby = m.si >= 0 && m.si < m.list.length ? m.list[m.si].id : null;
      const gp = fired && performance.now() < fired.until ? show.goPoints.find(g => g.id === fired.gpId) : null;
      if (!gp) fired = null;
      return gp || null;
    },
    reset() { fired = null; }
  };
}
const opTracker = makeFireTracker(() => renderOperator());

// ── Rendering ─────────────────────────────────────────────────────────
function renderOperator() {
  if (mode !== 'operator') return;
  if (!opDept || !deptById(opDept)) opLoadDept();
  renderOpDeptSelect();

  const m = opModel();
  const d = deptById(opDept);

  // GO flash: the SM's standby moved forward past a GO point that had my cue
  const firing = opTracker.update(m, opDept);

  // Top line
  document.getElementById('opDeptName').textContent = d ? `${d.code}${d.name ? ' · ' + d.name : ''}` : 'No department';
  document.getElementById('opDeptName').style.color = d ? d.color : '';
  document.getElementById('opSm').textContent = !m.list.length ? 'No GO points'
    : atEnd ? `SM: all ${m.list.length} GO points called` : `SM standby: GO ${m.si + 1} of ${m.list.length}`;

  // Main card
  const card = document.getElementById('opMain');
  const gp = firing || (m.cur && m.cur.gp);
  const state = firing ? 'go' : m.state;
  card.className = 'op-main st-' + state;
  const label = { go: 'GO', standby: 'STANDBY', warn: 'WARN', waiting: 'WAITING', none: '' }[state];
  document.getElementById('opState').textContent = label;
  const cueEl = document.getElementById('opCue');
  const meta = document.getElementById('opMeta');
  const note = document.getElementById('opNote');
  const micsEl = document.getElementById('opMics');
  cueEl.innerHTML = ''; meta.innerHTML = ''; note.textContent = ''; micsEl.textContent = '';

  if (!d) {
    cueEl.textContent = 'Add a department';
  } else if (!gp) {
    cueEl.innerHTML = `<span class="op-done">${m.mine.length ? `No more ${esc(d.code)} cues` : `No ${esc(d.code)} cues marked`}</span>`;
  } else {
    myCues(gp).forEach(c => {
      const s = document.createElement('span');
      s.style.color = deptColor(c.dept);
      s.textContent = cueText(c);
      cueEl.appendChild(s);
    });
    micsEl.textContent = micWhoTexts(myCues(gp)).join('\n');   // who wears these mics (MiKast)
    const others = otherCues(gp);
    if (others.length) {
      const w = document.createElement('span');
      w.className = 'op-with';
      w.textContent = 'with ' + others.map(cueText).join(' · ');
      cueEl.appendChild(w);
    }
    const p = goPos(gp);
    const k = m.list.indexOf(gp);
    const away = k - m.si;
    meta.append(`GO ${k + 1} of ${m.list.length}` + (p ? ` · ${posLabel(p)}` : '') +
      (state === 'waiting' && away > 0 ? ` · in ${away} GO${away === 1 ? '' : 's'}` : ''));
    if (gp.visual) {
      const v = document.createElement('span');
      v.className = 'sb-visual';
      v.textContent = 'VISUAL';
      meta.append(' ', v);
    }
    note.textContent = gp.note || '';
  }

  // Next two
  const nextBox = document.getElementById('opNext');
  nextBox.innerHTML = '';
  const nexts = firing ? (m.cur && m.cur.gp !== firing ? [m.cur, ...m.next].slice(0, 2) : m.next) : m.next;
  if (!nexts.length) nextBox.innerHTML = '<div class="op-empty">Nothing after this</div>';
  nexts.forEach(n => {
    const box = document.createElement('div');
    box.className = 'op-card';
    const head = document.createElement('div');
    head.className = 'op-card-head';
    myCues(n.gp).forEach(c => {
      const s = document.createElement('span');
      s.style.color = deptColor(c.dept);
      s.textContent = cueText(c);
      head.appendChild(s);
    });
    const p = goPos(n.gp);
    const meta2 = document.createElement('span');
    meta2.className = 'op-card-meta';
    meta2.textContent = `GO ${n.k + 1}` + (p ? ` · ${posLabel(p, true)}` : '');
    head.appendChild(meta2);
    box.appendChild(head);
    const who = micWhoTexts(myCues(n.gp)).join('\n');
    if (who) {
      const mm = document.createElement('div');
      mm.className = 'op-card-mics';
      mm.textContent = who;
      box.appendChild(mm);
    }
    if (n.gp.note) {
      const nn = document.createElement('div');
      nn.className = 'op-card-note';
      nn.textContent = n.gp.note;
      box.appendChild(nn);
    }
    const ex = document.createElement('div');
    ex.className = 'op-excerpt small';
    box.appendChild(ex);
    nextBox.appendChild(box);
    queueExcerpt(ex, n.gp, true);
  });

  const mainEx = document.getElementById('opExcerpt');
  if (gp) queueExcerpt(mainEx, gp, false);
  else { mainEx.innerHTML = ''; mainEx.dataset.key = ''; }
}

function renderOpDeptSelect() {
  const sel = document.getElementById('opDeptSelect');
  const html = show.departments.map(d => `<option value="${d.id}"${d.id === opDept ? ' selected' : ''}>${esc(d.code)}${d.name ? ' · ' + esc(d.name) : ''}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  sel.value = opDept || '';
}

// ── Script excerpts ───────────────────────────────────────────────────
// A clip of the page around a cue's Warn / Standby / GO points, cut from a
// full-page render (cached), with labels and the GO line highlighted.
const pageCache = new Map();   // key "doc:page@widthPx x dpr" -> canvas
let excerptSeq = 0;

function pageCanvas(page, widthPx, dprWanted) {
  const dpr = dprWanted || window.devicePixelRatio || 1;
  const key = `${view._docGen}:${page}@${widthPx}x${dpr}`;
  if (pageCache.has(key)) {
    const c = pageCache.get(key);
    pageCache.delete(key); pageCache.set(key, c);          // most recently used last
    return Promise.resolve(c);
  }
  const src = view.source;
  const sz = src.size(page);
  const scale = widthPx / sz.w;
  const canvas = document.createElement('canvas');
  return src.render(page, canvas, scale, dpr).then(() => {
    pageCache.set(key, canvas);
    while (pageCache.size > PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value);
    return canvas;
  });
}

// Group the cue's points into clips: one per page, split when far apart
function excerptClips(gp, compact) {
  const pts = [];
  const add = (a, kind) => { const p = anchorPos(a); if (p) pts.push({ ...p, kind }); };
  if (!compact) { add(gp.warn, 'W'); add(gp.standby, 'SB'); }
  add(gp.at, 'GO');
  pts.sort((a, b) => (a.page - b.page) || (a.y - b.y));
  const clips = [];
  for (const p of pts) {
    const last = clips[clips.length - 1];
    if (last && last.page === p.page && p.y - last.pts[last.pts.length - 1].y <= EX_SPLIT) last.pts.push(p);
    else clips.push({ page: p.page, pts: [p] });
  }
  // Keep the GO clip and at most two before it
  const goIdx = clips.findIndex(c => c.pts.some(p => p.kind === 'GO'));
  return clips.slice(Math.max(0, goIdx - 2), goIdx + 1);
}

// Build an excerpt: for each clip, a cropped canvas and the marks on it
// (positions in CSS px of that canvas). width = CSS px wide; dpr = canvas
// pixels per CSS px (null = the screen's).
function buildExcerpt(gp, compact, width, dpr) {
  const clips = excerptClips(gp, compact);
  if (!clips.length) return Promise.resolve([]);
  // Small cards show only part of the line width, around the GO word, so the
  // text stays readable: the page is drawn wider and a window is cut from it.
  const span = compact ? 0.62 : 1;                           // fraction of the page width shown
  const pageW = Math.round(width / span);
  return Promise.all(clips.map(c => pageCanvas(c.page, pageW, dpr))).then(canvases => clips.map((clip, i) => {
    const src = canvases[i];
    const sz = view.source.size(clip.page);
    const scale = pageW / sz.w;                               // CSS px per point
    const goPt = clip.pts.find(p => p.kind === 'GO') || clip.pts[0];
    const x0 = compact ? Math.max(0, Math.min(1 - span, goPt.x - 0.1)) : 0;   // left edge of the window (fraction of the page)
    const offX = x0 * pageW;                                  // px cut from the left
    const lineH = Math.max(10, (clip.pts[0].gap ? clip.pts[0].gap * 2 : 14));   // points
    const top = Math.max(0, clip.pts[0].y * sz.h - lineH * (compact ? 1.3 : EX_LINES_BEFORE));
    const bottom = Math.min(sz.h, clip.pts[clip.pts.length - 1].y * sz.h + lineH * (compact ? 1.4 : EX_LINES_AFTER));
    const hPx = Math.max(10, Math.round((bottom - top) * scale));
    const dprX = src.width / pageW;
    const c = document.createElement('canvas');
    c.width = Math.round(width * dprX);
    c.height = Math.round(hPx * dprX);
    c.getContext('2d').drawImage(src, Math.round(offX * dprX), Math.round(top * scale * dprX), c.width, c.height, 0, 0, c.width, c.height);
    const marks = clip.pts.map(p => ({
      kind: p.kind,
      x: Math.max(0, p.x * pageW - offX),                     // the marked word's left edge
      y: (p.y * sz.h - top) * scale,                          // its line's middle
      half: (p.gap ? p.gap : 6.5) * scale                     // half a line
    }));
    const showPage = clip.page !== clips[clips.length - 1].page || i < clips.length - 1;
    return { canvas: c, w: width, h: hPx, marks, page: showPage ? clip.page + 1 : null };
  }));
}

// Draw built clips into a box: canvas plus tags, arrows and the GO band
function drawExcerpt(box, built, color) {
  box.innerHTML = '';
  for (const clip of built) {
    const wrap = document.createElement('div');
    wrap.className = 'op-clip';
    wrap.style.height = clip.h + 'px';
    clip.canvas.style.width = clip.w + 'px';
    clip.canvas.style.height = clip.h + 'px';
    wrap.appendChild(clip.canvas);
    for (const p of clip.marks) {
      if (p.kind === 'GO') {
        const band = document.createElement('div');
        band.className = 'op-band';
        band.style.left = Math.max(0, p.x - 4) + 'px';
        band.style.top = (p.y - p.half * 0.95) + 'px';
        band.style.height = (p.half * 1.9) + 'px';
        band.style.right = '6px';
        wrap.appendChild(band);
      }
      const tag = document.createElement('div');
      tag.className = 'op-tag op-tag-' + p.kind.toLowerCase();
      tag.textContent = p.kind;
      tag.style.top = (p.y - 9) + 'px';
      tag.style.borderColor = color;
      tag.style.color = p.kind === 'GO' ? '#111' : color;
      if (p.kind === 'GO') tag.style.background = color;
      wrap.appendChild(tag);
      const arrow = document.createElement('div');
      arrow.className = 'op-arrow';
      arrow.style.left = Math.max(0, p.x - 7) + 'px';
      arrow.style.top = (p.y - p.half * 1.1) + 'px';
      arrow.style.borderTopColor = color;
      wrap.appendChild(arrow);
    }
    if (clip.page) {
      const pg = document.createElement('div');
      pg.className = 'op-clip-page';
      pg.textContent = `page ${clip.page}`;
      wrap.appendChild(pg);
    }
    box.appendChild(wrap);
  }
}

// The color a cue's marks are drawn in, for one department's view
function excerptColor(gp, dept) {
  return gp.cues.length ? deptColor((cuesOf(gp, dept)[0] || gp.cues[0]).dept) : '#c0b090';
}

function queueExcerpt(box, gp, compact) {
  if (typeof isRO === 'function' && isRO()) { roExcerpt(box, gp); return; }   // the item, not a script excerpt
  if (!view.source) { box.innerHTML = '<div class="op-empty">No script</div>'; box.dataset.key = ''; return; }
  const width = Math.max(200, Math.floor(box.clientWidth || box.parentElement.clientWidth || 600));
  const key = JSON.stringify([gp.id, gp.at, gp.standby, gp.warn, width, compact, view._docGen, viewPrefs.dark]);
  if (box.dataset.key === key) return;                       // already showing this
  box.dataset.key = key;
  const seq = ++excerptSeq;
  if (!excerptClips(gp, compact).length) { box.innerHTML = '<div class="op-empty">Not placed on the script</div>'; return; }
  buildExcerpt(gp, compact, width, null).then(built => {
    if (box.dataset.key !== key) return;                     // superseded
    drawExcerpt(box, built, excerptColor(gp, opDept));
  }).catch(err => {
    if (seq === excerptSeq) box.innerHTML = '<div class="op-empty">Could not draw the script</div>';
    console.error('[operator] excerpt failed:', err);
  });
}

function opClearCache() { pageCache.clear(); document.querySelectorAll('.op-excerpt').forEach(b => { b.dataset.key = ''; }); }

// ── Clock and wiring ──────────────────────────────────────────────────
function initOperator() {
  const sel = document.getElementById('opDeptSelect');
  sel.addEventListener('change', () => {
    opDept = sel.value;
    opSaveDept();
    opTracker.reset();
    renderOperator();
    linkDeptChanged();
    sel.blur();
  });
  const tick = () => {
    const el = document.getElementById('opClock');
    if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };
  tick();
  setInterval(tick, 1000);
  // Re-cut excerpts when the window is resized
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (mode === 'operator') { opClearCache(); renderOperator(); } }, 200); })
    .observe(document.getElementById('operator'));
}
