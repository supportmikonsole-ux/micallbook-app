'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: calling the show (Show mode)
   Standby = the next GO point to be called. GO advances it (calling mode:
   with DRIVE on it also fires the cues in MiKonsole / MiKue: drive.js), Back
   steps it back. Clicking a tab or a list row in Show mode
   sets Standby there.

   On the script the standby GO is highlighted and the GO points already
   called are dimmed; the script scrolls smoothly to keep the standby GO
   about a third of the way down (Follow, on by default; Mike 2026-10-20).

   Warn and Standby calls (Mike, 2026-10-20): a GO point's Warn and Standby
   points are calling steps too. GO steps through them in script order:
   WARN LX 5 → STANDBY LX 5 → LX 5 GO. Only the GO step fires cues, logs a
   milestone or counts as a GO for operators; Back steps back one step. A
   Warn or Standby placed before an earlier GO point is called before that
   GO point (script order), never after its own GO.
   Position = (standby GO, stepK): stepK counts the Warn / Standby steps
   already called before the standby GO; stepK = their number = at the GO.

   Uses app.js / marks.js globals.
   ════════════════════════════════════════════════════════════════════ */

const GO_GUARD_MS = 300;    // ignore a second GO this soon (double-press protection, same as MiKue)

// GO / Back work in Show mode and in Operator mode. While an operator's
// computer follows the SM (link.js), they come from the SM instead.
function isCalling() { return mode === 'show' || mode === 'operator'; }

let standbyGoId = null;     // null with GO points = past the last one (end of show)
let atEnd = false;
let stepK = 0;              // Warn / Standby steps called before the standby GO (callSteps)
let lastGoAt = 0;
let goFlash = 0;            // counts GOs, so the Booth View knows to flash

function callList() { return orderedGoPoints(); }
function standbyIndex() {
  const list = callList();
  return standbyGoId ? list.findIndex(g => g.id === standbyGoId) : (atEnd ? list.length : -1);
}

// Keep Standby pointing at a GO that exists
function ensureStandby() {
  const list = callList();
  if (!list.length) { standbyGoId = null; atEnd = false; stepK = 0; return; }
  if (atEnd) return;
  if (!standbyGoId || !list.some(g => g.id === standbyGoId)) { standbyGoId = list[0].id; stepK = 0; }
}

// ── Warn and Standby steps ────────────────────────────────────────────
// pre[i]: the Warn / Standby steps called before GO i (calling order), in
// script order: { kind: 'warn' | 'standby', gp, p }
function cmpPos(a, b) { return (a.page - b.page) || (a.y - b.y) || (a.x - b.x); }
function isPagePos(p) { return !!p && typeof p.page === 'number' && typeof p.y === 'number'; }
function callSteps() {
  const list = callList();
  const pre = list.map(() => []);
  const gpos = list.map(g => { const p = goPos(g); return isPagePos(p) ? p : null; });
  list.forEach((gp, own) => {
    for (const kind of ['warn', 'standby']) {
      if (!gp[kind]) continue;
      const p = anchorPos(gp[kind]);
      if (!isPagePos(p)) continue;                  // not placed (or a running order)
      // Called before the first GO (in calling order) that comes after it on the script, at the latest before its own
      let slot = own;
      for (let j = 0; j < own; j++) if (gpos[j] && cmpPos(gpos[j], p) > 0) { slot = j; break; }
      pre[slot].push({ kind, gp, p });
    }
  });
  pre.forEach(a => a.sort((x, y) => cmpPos(x.p, y.p) || (x.kind === 'warn' ? -1 : 1)));
  return { list, pre };
}
// Where calling stands: { kind: 'warn' | 'standby' | 'go' | 'end', gp, p, i, k, pre, list }
function curStep() {
  const { list, pre } = callSteps();
  const i = standbyIndex();
  if (atEnd || i < 0 || i >= list.length) return { kind: 'end', gp: null, i, k: 0, list, pre };
  const ps = pre[i];
  const k = Math.max(0, Math.min(stepK, ps.length));
  if (k < ps.length) return { kind: ps[k].kind, gp: ps[k].gp, p: ps[k].p, i, k, list, pre };
  return { kind: 'go', gp: list[i], p: goPos(list[i]), i, k, list, pre };
}
// Has this GO point's Warn / Standby step been called? (Operator mode, Booth View)
function stepCalled(st, gpId, kind) {
  if (atEnd) return true;
  for (let j = 0; j < st.pre.length; j++) {
    const m = st.pre[j].findIndex(x => x.gp.id === gpId && x.kind === kind);
    if (m >= 0) return j < st.i || (j === st.i && m < st.k);
  }
  return false;
}
function hasSteps(st, gpId) { return st.pre.some(a => a.some(x => x.gp.id === gpId)); }

// Calling position from a click: a GO tab or list row = at that GO (GO 1 = the start of
// the show, its Warns first); a W / SB tab = at that step
function setStandbyStep(id, kind, scroll) {
  if (linkLocked()) { linkNudge(); return; }
  const { list, pre } = callSteps();
  if (kind === 'warn' || kind === 'standby') {
    for (let j = 0; j < pre.length; j++) {
      const m = pre[j].findIndex(x => x.gp.id === id && x.kind === kind);
      if (m >= 0) { setStandby(list[j].id, scroll, m); return; }
    }
  }
  setStandby(id, scroll);
}

// k: the step to stand at (default: at the GO itself; GO 1: the start, its Warns first)
function setStandby(id, scroll, k) {
  if (linkLocked()) { linkNudge(); return; }   // following the SM (link.js)
  standbyGoId = id;
  atEnd = false;
  const { list, pre } = callSteps();
  const i = list.findIndex(g => g.id === id);
  stepK = typeof k === 'number' ? k : (i <= 0 ? 0 : (pre[i] || []).length);
  renderStandby();
  decorateCalling();
  renderCalling();
  if (scroll !== false) followStandby(true);
  if (typeof syncMicueStandby === 'function') syncMicueStandby();
}

// ── GO / Back ─────────────────────────────────────────────────────────
function go() {
  if (!isCalling()) return;
  if (linkLocked()) { linkNudge(); return; }
  const now = performance.now();
  if (now - lastGoAt < GO_GUARD_MS) return;
  lastGoAt = now;
  ensureStandby();
  const st = curStep();
  const list = st.list;
  const i = st.i;
  if (i < 0 || i >= list.length) return;

  // A Warn or Standby step: called, nothing fires
  if (st.kind === 'warn' || st.kind === 'standby') {
    stepK = st.k + 1;
    const btn = document.getElementById('btnGo');
    btn.classList.add('flash-step');
    setTimeout(() => btn.classList.remove('flash-step'), 180);
    renderStandby();
    decorateCalling();
    renderCalling();
    followStandby(true);
    return;
  }

  // DRIVE armed + Show mode: fire list[i]'s cues in MiKonsole / MiKue (drive.js)
  if (typeof driveGo === 'function') driveGo(list[i]);
  // A milestone on this GO point: log it in the session (timing.js)
  if (typeof timingOnGo === 'function') timingOnGo(list[i]);

  const btn = document.getElementById('btnGo');
  btn.classList.add('flash');
  setTimeout(() => btn.classList.remove('flash'), 180);
  goFlash++;

  if (i + 1 < list.length) { standbyGoId = list[i + 1].id; atEnd = false; }
  else { standbyGoId = null; atEnd = true; }
  stepK = 0;
  renderStandby();
  decorateCalling();
  renderCalling();
  followStandby(true);
}

function back() {
  if (!isCalling()) return;
  if (linkLocked()) { linkNudge(); return; }
  const st = curStep();
  const list = st.list;
  if (!list.length) return;
  // Back over a Warn or Standby step: nothing fires
  if (st.kind !== 'end' && st.k > 0) {
    stepK = st.k - 1;
    renderStandby();
    decorateCalling();
    renderCalling();
    followStandby(true);
    return;
  }
  const i = standbyIndex();
  const j = atEnd ? list.length - 1 : i - 1;
  if (j < 0) return;
  if (typeof driveBack === 'function') driveBack(list[j]);   // MiKonsole Back when driving (drive.js)
  if (typeof timingOnBack === 'function') timingOnBack(list[j]);   // take its milestone time out (timing.js)
  setStandby(list[j].id, true, st.pre[j].length);              // at that GO again (its Warns stay called)
}

// ── Display ───────────────────────────────────────────────────────────
function renderStandby() {
  ensureStandby();
  const list = callList();
  const cuesEl = document.getElementById('standbyCues');
  const meta = document.getElementById('standbyMeta');
  const notes = document.getElementById('standbyNotes');
  const goBtn = document.getElementById('btnGo');
  const backBtn = document.getElementById('btnBack');
  cuesEl.innerHTML = '';
  notes.textContent = '';

  if (!list.length) {
    cuesEl.textContent = '-';
    meta.textContent = 'No GO points yet';
  } else if (atEnd) {
    cuesEl.innerHTML = '<span class="sb-end">END</span>';
    meta.textContent = `All ${list.length} GO point${list.length === 1 ? '' : 's'} called`;
  } else {
    const i = standbyIndex();
    const st = curStep();
    const step = st.kind === 'warn' || st.kind === 'standby' ? st.kind : null;
    const gp = step ? st.gp : list[i];
    if (step) {
      const lab = document.createElement('span');
      lab.className = 'sb-step ' + step;
      lab.textContent = step === 'warn' ? 'WARNING' : 'STANDBY';
      cuesEl.appendChild(lab);
    }
    if (!gp.cues.length) cuesEl.insertAdjacentHTML('beforeend', '<span>GO</span>');
    displayCues(gp).forEach(({ c, sep }) => {
      if (sep === ' / ') {
        const sl = document.createElement('span');
        sl.className = 'sb-slash';
        sl.textContent = '/';
        cuesEl.appendChild(sl);
      }
      const sp = document.createElement('span');
      sp.className = 'sb-cue' + (c.mics ? ' mic' : '') + (isMsCue(c) ? ' ms' : '');
      sp.style.color = deptColor(c.dept);
      sp.textContent = cueText(c);
      cuesEl.appendChild(sp);
    });
    const p = step ? st.p : goPos(gp);
    meta.innerHTML = '';
    const gpN = list.findIndex(g => g.id === gp.id) + 1;
    meta.append((step ? `${step === 'warn' ? 'Warn' : 'Standby'} for GO ${gpN} of ${list.length}` : `GO ${i + 1} of ${list.length}`) +
      (p ? ` · ${posLabel(p)}` : isRO() ? ' · not on an item' : ' · not on the script'));
    if (gp.visual) {
      const v = document.createElement('span');
      v.className = 'sb-visual';
      v.textContent = 'VISUAL';
      meta.append(' ', v);
    }
    notes.textContent = gp.note || '';
  }
  const showing = isCalling();
  const locked = linkLocked();
  const cs = list.length && !atEnd ? curStep() : null;
  const stepKind = cs && (cs.kind === 'warn' || cs.kind === 'standby') ? cs.kind : null;
  goBtn.textContent = stepKind === 'warn' ? 'WARN' : stepKind === 'standby' ? 'STANDBY' : 'GO';
  goBtn.classList.toggle('step-warn', stepKind === 'warn');
  goBtn.classList.toggle('step-sb', stepKind === 'standby');
  goBtn.disabled = !showing || !list.length || atEnd || locked;
  backBtn.disabled = !showing || !list.length || (!atEnd && standbyIndex() <= 0 && !(cs && cs.k > 0)) || locked;
  goBtn.title = locked ? 'Following the SM: GO comes from the SM'
    : showing ? (stepKind ? `Call the ${stepKind === 'warn' ? 'Warning' : 'Standby'} (Space): nothing fires` : 'GO (Space)') : 'Switch to Show mode to call the show';
  sendBooth();
  if (typeof renderOperator === 'function') renderOperator();
  if (typeof linkAfterRender === 'function') linkAfterRender();
  if (typeof renderDrive === 'function') renderDrive();
  if (typeof renderTiming === 'function') renderTiming();
  if (typeof renderReportsButton === 'function') renderReportsButton();
}

// ── Booth View ────────────────────────────────────────────────────────
// Shows either the full call or one department's Operator view (chosen in
// the Booth View itself, remembered on this computer by department code).
const BOOTH_VIEW_KEY = 'micallbook.boothView';
const BOOTH_EX_WIDTH = 1400;   // excerpt image width (px) sent to the Booth View
let boothView = 'all';         // 'all' or a department code
try { boothView = localStorage.getItem(BOOTH_VIEW_KEY) || 'all'; } catch (_) {}
let boothTracker = null;       // GO flash for the department view (operator.js makeFireTracker)
let boothEx = { key: null, data: null };   // excerpt being built / built
let boothSentExKey = null;     // excerpt the Booth View already has

// sep: what goes before this cue (' / ' joins a combo cue to its MiKue cue)
function cueView(c, sep) { return { text: cueText(c), color: deptColor(c.dept), via: !!c.via, sep: sep || '' }; }
function cueViews(gp) { return displayCues(gp).map(x => cueView(x.c, x.sep)); }
function pageOf(g) { const p = goPos(g); return p && !p.ro ? p.page + 1 : null; }   // Booth View page (none for a running order)
function boothDept() { return boothView === 'all' ? null : show.departments.find(d => d.code === boothView) || null; }

function boothModeText() {
  if (typeof linkRole !== 'undefined' && linkRole === 'client') {
    if (linkStatus === 'lost') return { text: 'LINK LOST', kind: 'lost' };
    return { text: linkStatus === 'linked' ? 'FOLLOWING THE SM' : 'LINKING…', kind: 'show' };
  }
  const base = mode === 'show' ? 'SHOW' : mode === 'operator' ? 'OPERATOR' : 'EDIT · not calling';
  const sharing = typeof linkRole !== 'undefined' && linkRole === 'host' ? ' · SHARING' : '';
  return { text: base + sharing, kind: mode === 'edit' ? '' : 'show' };
}

// The script excerpt for the department view: built once per GO point and
// sent as images; until it's ready the Booth View shows the rest.
function boothExcerpt(gp, dept) {
  if (!gp || !view.source) return null;
  const key = JSON.stringify([gp.id, gp.at, gp.standby, gp.warn, view._docGen, dept]);
  if (boothEx.key !== key) {
    boothEx = { key, data: null };
    if (!excerptClips(gp, false).length) {
      boothEx.data = { clips: [], none: 'Not placed on the script' };
    } else {
      buildExcerpt(gp, false, BOOTH_EX_WIDTH, 1).then(built => {
        if (boothEx.key !== key) return;
        boothEx.data = {
          color: excerptColor(gp, dept),
          clips: built.map(c => ({ src: c.canvas.toDataURL('image/png'), w: c.w, h: c.h, page: c.page, marks: c.marks }))
        };
        sendBooth();
      }).catch(err => console.error('[booth] excerpt failed:', err));
    }
  }
  if (!boothEx.data) return null;
  if (boothSentExKey === key) return { key, same: true };     // the Booth View has it already
  boothSentExKey = key;
  return Object.assign({ key }, boothEx.data);
}

function boothDeptState(d) {
  if (!boothTracker) boothTracker = makeFireTracker(() => sendBooth());
  const m = deptModel(d.id);
  const firing = boothTracker.update(m, d.id);
  const gp = firing || (m.cur && m.cur.gp);
  const state = firing ? 'go' : m.state;
  const nexts = firing ? (m.cur && m.cur.gp !== firing ? [m.cur, ...m.next].slice(0, 2) : m.next) : m.next;
  let cue = null;
  if (gp) {
    const k = m.list.indexOf(gp);
    cue = {
      cues: cuesOf(gp, d.id).map(cueView),
      with: notCuesOf(gp, d.id).map(cueText).join(' · '),
      n: k + 1, page: pageOf(gp), away: state === 'waiting' ? k - m.si : 0,
      visual: !!gp.visual, note: gp.note || '',
      mics: micWhoTexts(cuesOf(gp, d.id)).join('\n')        // who wears the mics (MiKast)
    };
  }
  return {
    code: d.code, name: d.name, color: d.color, state, cue,
    sm: !m.list.length ? 'No GO points' : atEnd ? `SM: all ${m.list.length} GO points called` : `SM standby: GO ${m.si + 1} of ${m.list.length}`,
    done: gp ? '' : (m.mine.length ? `No more ${d.code} cues` : `No ${d.code} cues marked`),
    next: nexts.map(n => ({ n: n.k + 1, cues: cuesOf(n.gp, d.id).map(cueView), page: pageOf(n.gp), note: n.gp.note || '',
      mics: micWhoTexts(cuesOf(n.gp, d.id)).join('\n') })),
    excerpt: boothExcerpt(gp, d.id)
  };
}

function boothState() {
  const list = callList();
  const si = atEnd ? list.length : standbyIndex();
  const gp = !atEnd && si >= 0 ? list[si] : null;
  const d = boothDept();
  return {
    show: show.name || 'Untitled Show',
    mode,
    modeText: boothModeText(),
    view: d ? d.code : 'all',
    depts: show.departments.map(x => ({ code: x.code, name: x.name, color: x.color })),
    dept: d ? boothDeptState(d) : null,
    count: list.length,
    end: atEnd,
    standby: gp ? boothStandby(gp, si) : null,
    last: si > 0 ? { cues: cueViews(list[si - 1]) } : null,
    next: si >= 0 ? list.slice(si + 1, si + 4).map((g, k) => ({ n: si + 2 + k, cues: cueViews(g), page: pageOf(g) })) : [],
    flash: goFlash
  };
}
// The Standby box of the Booth View: the next step (a Warn or Standby call, or the GO)
function boothStandby(gp, si) {
  const st = curStep();
  if (st.kind === 'warn' || st.kind === 'standby') {
    const g = st.gp, n = st.list.findIndex(x => x.id === g.id) + 1;
    return { n, step: st.kind, cues: cueViews(g), note: g.note || '', visual: !!g.visual, page: st.p ? st.p.page + 1 : null };
  }
  return { n: si + 1, cues: cueViews(gp), note: gp.note || '', visual: !!gp.visual, page: pageOf(gp) };
}
let boothOpen = false;
function sendBooth() { if (boothOpen) bridge.popout.send(boothState()); }

function setBoothView(v) {
  boothView = typeof v === 'string' && v ? v : 'all';
  try { localStorage.setItem(BOOTH_VIEW_KEY, boothView); } catch (_) {}
  if (boothTracker) boothTracker.reset();
  boothSentExKey = null;
  sendBooth();
}

function boothBtnState() {
  const m = document.getElementById('miBooth');
  if (m) m.classList.toggle('on', boothOpen);
}

async function toggleBooth() {
  if (boothOpen) { await bridge.popout.close(); return; }
  await bridge.popout.open();
  boothOpen = true;
  boothSentExKey = null;
  boothBtnState();
  sendBooth();
}

// Classes on the script: standby GO highlighted, called ones dimmed, plus a
// highlighter band on the standby GO's line. Re-applied after every redraw.
function decorateCalling() {
  view.pagesEl.querySelectorAll('.mk-band').forEach(b => b.remove());
  const showing = isCalling();
  const list = callList();
  const idx = new Map(list.map((g, k) => [g.id, k]));
  const si = atEnd ? list.length : standbyIndex();
  const st = showing && list.length ? curStep() : null;
  view.pagesEl.querySelectorAll('.mk-tab, .mk-line, .mk-dot').forEach(el => {
    const k = idx.get(el.dataset.id);
    const kind = el.dataset.kind || 'at';
    if (kind === 'warn' || kind === 'standby') {
      // A Warn / Standby mark: dimmed once called, highlighted when it is the next step
      el.classList.toggle('called', !!st && stepCalled(st, el.dataset.id, kind));
      el.classList.toggle('standby', !!st && st.kind === kind && st.gp && st.gp.id === el.dataset.id);
      return;
    }
    el.classList.toggle('called', showing && k != null && k < si);
    el.classList.toggle('standby', showing && !atEnd && el.dataset.id === standbyGoId && (!st || st.kind === 'go'));
  });
  if (!showing || atEnd || !standbyGoId) return;
  const gp = list[si];
  const p = st && st.kind !== 'go' && st.p ? st.p : gp && goPos(gp);
  const s = p && view.slots[p.page];
  if (!s) return;
  const g = (p.gap || GAP_PT) * view.scale;
  const band = document.createElement('div');
  band.className = 'mk-band';
  const x = Math.max(0, p.x * s.w - 4);
  band.style.left = x + 'px';
  band.style.top = (p.y * s.h - g * 0.95) + 'px';
  band.style.height = (g * 1.9) + 'px';
  band.style.width = Math.max(20, s.w - x - 8) + 'px';
  s.layer.prepend(band);
}

// Keep the next step (the standby GO, or a Warn / Standby call) about a third of the
// way down the script view. Follow off (script bar, Show mode): the script stays put,
// unless force (Follow turned back on).
function followStandby(smooth, force) {
  if (!force && typeof viewPrefs !== 'undefined' && viewPrefs.follow === false) return;
  if (typeof isRO === 'function' && isRO()) { if (mode === 'show') roFollow(smooth); return; }
  if (mode !== 'show' || atEnd || !standbyGoId) return;
  const st = curStep();
  const p = st.kind === 'warn' || st.kind === 'standby' ? st.p : (st.gp && goPos(st.gp));
  const s = p && view.slots[p.page];
  if (!s) return;
  const top = s.slot.parentElement.offsetTop + p.y * s.h - view.el.clientHeight / 3;
  view.el.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

// Called when Show mode starts or ends
function onModeChanged() {
  ensureStandby();
  renderStandby();
  decorateCalling();
  renderCalling();
  if (mode === 'show') followStandby(false);
  if (mode === 'show' && typeof syncMicueStandby === 'function') { lastMicueStandby = null; syncMicueStandby(); }
}

// Clock in the Standby box (shown in Show mode)
function tickClock() {
  const el = document.getElementById('sbClock');
  if (el) el.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function initCalling() {
  tickClock();
  setInterval(tickClock, 1000);
  document.getElementById('btnGo').addEventListener('click', go);
  document.getElementById('btnBack').addEventListener('click', back);
  // Booth View is opened and closed from Utilities (app.js); the menu item shows when it's open
  bridge.popout.onWantState(() => { boothOpen = true; boothSentExKey = null; boothBtnState(); sendBooth(); });
  bridge.popout.onClosed(() => { boothOpen = false; boothSentExKey = null; boothBtnState(); });
  bridge.popout.onView(setBoothView);
  // Space / Backspace pressed while the Booth View is in front
  bridge.popout.onKey(k => {
    if (modalOpen() || textEditorOpen || linkDialogIsOpen() || timingDialogIsOpen() || reportsDialogIsOpen() || cueSheetsDialogIsOpen() || notesQrDialogIsOpen()) return;
    if (k === 'go') go();
    else if (k === 'back') back();
  });
}
