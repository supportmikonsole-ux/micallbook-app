'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: live cue lists from MiKonsole and MiKue
   While MiKonsole and MiKue run on this computer, MiKallbook reads their
   cue lists so the cue number fields offer them as a dropdown, cues that
   aren't in the other app's list are flagged, and MiKue cues that fire a
   MiKonsole cue become combo cues ("LX 1.5 / SQ 2").

   A department's Link (Departments panel) says which app its cues are in.

   MiKonsole: its phone-remote relay (port 8080), the same way MiKue reads
   it: GET /poll/remote?since=N long-polls for the state MiKonsole pushes,
   which only happens while MiKonsole's Phone Remote is set to Connect.
   Cue numbers come from MiKonsole 2026-10-17 on ("num" in each cue).

   MiKue: GET http://127.0.0.1:8090/status every 3 s. Continue/Follow
   ("then") and the MiKonsole cue a MiKonsole GO cue fires ("mk") come from
   MiKue 2026-10-17 on.

   Combo cue: a cue on a GO point { dept, number, via: 'micue', of, typed? }
   where "of" is the "<dept id>|<number>" of the MiKue cue that fires it.
   Added and removed automatically; an LX cue typed in by hand that MiKue
   also fires becomes the combo cue (typed: true) and goes back to a plain
   cue if MiKue stops firing it. When driving the apps (Phase 2) only the
   MiKue cue is sent, so the lighting cue never fires twice.

   Only reads: nothing here sends a command to either app.
   Uses app.js / marks.js / panels.js globals.
   ════════════════════════════════════════════════════════════════════ */

const MK_URL = 'http://localhost:8080';
const MC_URL = 'http://127.0.0.1:8090';
const APP_NAME = { mikonsole: 'MiKonsole', micue: 'MiKue' };

const live = {
  // status: 'off' (not running) | 'relay' (running, Phone Remote not connected) | 'linked'
  mikonsole: { status: 'off', cues: [], hasNums: true },
  // status: 'off' | 'on'
  micue: { status: 'off', cues: [], show: '', combos: true }
};
let liveSig = '';

function liveSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── MiKonsole ─────────────────────────────────────────────────────────
let mkSeq = -1;

async function mkProbe() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    // GET /remote only serves the phone page: harmless (unlike /poll/console,
    // which would take a command meant for MiKonsole)
    await fetch(`${MK_URL}/remote`, { signal: ctrl.signal, cache: 'no-store' });
    return true;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function mkLoop() {
  for (;;) {
    if (live.mikonsole.status === 'off') {
      if (!(await mkProbe())) { await liveSleep(3000); continue; }
      live.mikonsole = { status: 'relay', cues: [], hasNums: true };
      onLiveChanged();
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);      // the relay answers within 10 s
    try {
      const r = await fetch(`${MK_URL}/poll/remote?since=${mkSeq}`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      const msg = await r.json();
      if (msg && Array.isArray(msg.cues)) {
        if (Number.isFinite(msg.seq)) mkSeq = msg.seq;
        const cues = msg.cues
          .map((c, i) => ({
            idx: i,
            num: c && typeof c.num === 'number' && Number.isFinite(c.num) ? c.num : null,
            label: (c && c.label) || `Cue ${i + 1}`,
            divider: !!(c && c.divider)
          }))
          .filter(c => !c.divider);
        // Older MiKonsole doesn't send numbers at all
        const hasNums = !msg.cues.length || msg.cues.some(c => c && Object.prototype.hasOwnProperty.call(c, 'num'));
        live.mikonsole = { status: 'linked', cues, hasNums };
        onLiveChanged();
      } else if (live.mikonsole.status !== 'linked') {
        // heartbeat: running, but MiKonsole hasn't pushed its state
        live.mikonsole.status = 'relay';
        onLiveChanged();
      }
    } catch (_) {
      clearTimeout(t);
      mkSeq = -1;
      live.mikonsole = { status: 'off', cues: [], hasNums: true };
      onLiveChanged();
      await liveSleep(3000);
    }
  }
}

// ── MiKue ─────────────────────────────────────────────────────────────
async function mcLoop() {
  for (;;) {
    let ok = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const r = await fetch(`${MC_URL}/status`, { signal: ctrl.signal, cache: 'no-store' });
      const s = await r.json();
      if (s && s.ok && Array.isArray(s.cues)) {
        live.micue = {
          status: 'on',
          show: String(s.show || ''),
          // Older MiKue doesn't report Continue/Follow or MiKonsole targets
          combos: !s.cues.length || s.cues.some(c => c && Object.prototype.hasOwnProperty.call(c, 'then')),
          cues: s.cues.map(c => ({
            number: String(c.number == null ? '' : c.number).trim(),
            name: String(c.name || ''),
            type: String(c.type || ''),
            then: c.then === 'continue' || c.then === 'follow' ? c.then : 'none',
            mk: c.mk && typeof c.mk === 'object' ? { action: c.mk.action === 'go' ? 'go' : 'goto', idx: Number.isInteger(c.mk.idx) ? c.mk.idx : null } : null
          })).filter(c => c.number)
        };
        ok = true;
      } else if (s && s.ok === false && live.micue.status === 'on') {
        ok = true;            // MiKue is busy (loading): keep the list it gave last
      }
    } catch (_) {}
    clearTimeout(t);
    if (!ok) live.micue = { status: 'off', cues: [], show: '', combos: true };
    onLiveChanged();
    await liveSleep(ok ? 3000 : 5000);
  }
}

// ── Lookups ───────────────────────────────────────────────────────────
function deptTarget(id) { const d = deptById(id); return d ? d.target : 'none'; }

function liveAvailable(target) {
  if (target === 'mikonsole') return live.mikonsole.status === 'linked' && live.mikonsole.hasNums;
  if (target === 'micue') return live.micue.status === 'on';
  return false;
}

// Why a list isn't available, in plain words
function liveOffText(target) {
  if (target === 'mikonsole') {
    const s = live.mikonsole.status;
    if (s === 'off') return 'MiKonsole isn’t running on this computer';
    if (s === 'relay') return 'In MiKonsole, open Phone Remote and click Connect to see its cues';
    return 'This MiKonsole is an older version that doesn’t send cue numbers. Use MiKonsole from 2026-10-17 on.';
  }
  if (target === 'micue') return 'MiKue isn’t running on this computer';
  return '';
}

const NUM_RE = /^\s*\d+(\.\d+)?\s*$/;
function sameNum(a, b) {
  const x = String(a == null ? '' : a), y = String(b == null ? '' : b);
  if (NUM_RE.test(x) && NUM_RE.test(y)) return parseFloat(x) === parseFloat(y);
  return x.trim().toLowerCase() === y.trim().toLowerCase();
}
function fmtNum(n) { return String(n); }

function liveFind(target, number) {
  if (target === 'mikonsole') return live.mikonsole.cues.find(c => c.num !== null && sameNum(c.num, number)) || null;
  if (target === 'micue') return live.micue.cues.find(c => sameNum(c.number, number)) || null;
  return null;
}

// Where a cue on a GO point stands against its app's list:
// { state: 'none' | 'unknown' | 'ok' | 'missing', text }
function cueSource(c) {
  const t = deptTarget(c.dept);
  if (t !== 'mikonsole' && t !== 'micue') return { state: 'none', text: '' };
  if (c.via === 'micue' && c.number === 'next') return { state: 'ok', text: 'the next MiKonsole cue (MiKue sends GO)' };
  if (!liveAvailable(t)) return { state: 'unknown', text: liveOffText(t) };
  const hit = liveFind(t, c.number);
  if (!hit) return { state: 'missing', text: `Not in ${APP_NAME[t]}’s cue list` };
  const fires = t === 'micue' ? micueFires(c.number) : null;
  const extra = fires && fires.length ? ` · fires LX ${fires.join(', ')}` : '';
  return { state: 'ok', text: (t === 'mikonsole' ? hit.label : hit.name) + extra };
}

// ── Combo cues ────────────────────────────────────────────────────────
function lxDept() { return show.departments.find(d => d.target === 'mikonsole') || null; }
function comboKey(c) { return c.dept + '|' + c.number; }

// The MiKonsole cue numbers a MiKue cue fires, itself or along its
// Continue / Follow chain ('next' for "GO next MiKonsole cue").
// [] = fires none; null = can't tell right now.
function micueFires(number) {
  if (live.micue.status !== 'on' || !live.micue.combos) return null;
  const list = live.micue.cues;
  const i = list.findIndex(c => sameNum(c.number, number));
  if (i < 0) return [];
  const out = [];
  for (let k = i; k < list.length; k++) {
    const c = list[k];
    if (c.type === 'mikonsole' && c.mk) {
      if (c.mk.action === 'go') out.push('next');
      else if (Number.isInteger(c.mk.idx)) {
        if (!liveAvailable('mikonsole')) return null;           // need MiKonsole's list to know the number
        const m = live.mikonsole.cues.find(x => x.idx === c.mk.idx);
        if (!m || m.num === null) return null;
        out.push(fmtNum(m.num));
      }
    }
    if (c.then === 'none') break;
  }
  return [...new Set(out)];
}

// Bring a GO point's combo cues in line with MiKue. Combo cues whose MiKue
// cue left the GO are always removed; the rest are only changed when both
// lists can be read. Returns true if anything changed.
function syncCombos(gp) {
  let changed = false;
  const sources = gp.cues.filter(c => !c.via && deptTarget(c.dept) === 'micue');
  const keys = new Set(sources.map(comboKey));
  // A combo cue that was typed in by hand goes back to being a plain cue; one
  // MiKallbook added is removed
  const unCombo = c => { delete c.via; delete c.of; delete c.typed; };
  for (const c of gp.cues) if (c.via && c.typed && !keys.has(c.of)) { unCombo(c); changed = true; }
  const kept = gp.cues.filter(c => !c.via || keys.has(c.of));
  if (kept.length !== gp.cues.length) { gp.cues = kept; changed = true; }
  const lx = lxDept();
  if (!lx) return changed;
  for (const s of sources) {
    const want = micueFires(s.number);
    if (want === null) continue;                                // can't tell now: leave as is
    const key = comboKey(s);
    for (const h of gp.cues.filter(c => c.via && c.of === key)) {
      if (h.dept !== lx.id || !want.some(n => sameNum(n, h.number))) {
        if (h.typed) unCombo(h); else gp.cues.splice(gp.cues.indexOf(h), 1);
        changed = true;
      }
    }
    for (const n of want) {
      if (gp.cues.some(c => c.via && c.of === key && c.dept === lx.id && sameNum(c.number, n))) continue;   // already there
      // Typed in by hand: it becomes the combo cue, so driving the apps never fires it twice
      const typed = gp.cues.find(c => !c.via && c.dept === lx.id && sameNum(c.number, n));
      if (typed) { typed.via = 'micue'; typed.of = key; typed.typed = true; changed = true; continue; }
      gp.cues.splice(gp.cues.indexOf(s), 0, { dept: lx.id, number: n, via: 'micue', of: key });
      changed = true;
    }
  }
  return changed;
}

// Would syncing change this GO point? (MiKue's cues changed since it was set)
function comboStale(gp) { return syncCombos(JSON.parse(JSON.stringify(gp))); }

// The cue a combo cue comes from
function comboSource(gp, c) {
  return c.via ? gp.cues.find(s => !s.via && comboKey(s) === c.of) || null : null;
}

// Cues in display order, each with the separator before it: combo cues sit
// just before the MiKue cue that fires them, joined by " / ".
function displayCues(gp) {
  const out = [];
  const used = new Set();
  for (const c of gp.cues) {
    if (c.via) continue;
    const vias = gp.cues.filter(v => v.via && v.of === comboKey(c));
    vias.forEach((v, k) => { out.push({ c: v, sep: out.length ? (k ? ' / ' : ' · ') : '' }); used.add(v); });
    out.push({ c, sep: out.length ? (vias.length ? ' / ' : ' · ') : '' });
  }
  for (const c of gp.cues) if (c.via && !used.has(c)) out.push({ c, sep: out.length ? ' · ' : '' });
  return out;
}

// ── Dropdowns (datalists for the cue number fields) ───────────────────
function refreshDatalists() {
  const fill = (id, items) => {
    const el = document.getElementById(id);
    const html = items.map(o => `<option value="${esc(o.v)}" label="${esc(o.t)}"></option>`).join('');
    if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  };
  fill('dl-mikonsole', liveAvailable('mikonsole')
    ? live.mikonsole.cues.filter(c => c.num !== null).map(c => ({ v: fmtNum(c.num), t: c.label }))
    : []);
  fill('dl-micue', liveAvailable('micue')
    ? live.micue.cues.map(c => {
        const f = micueFires(c.number);
        return { v: c.number, t: c.name + (f && f.length ? `  → LX ${f.join(', ')}` : '') };
      })
    : []);
}
// The datalist a department's number field uses
function datalistFor(deptId) {
  const t = deptTarget(deptId);
  return t === 'mikonsole' || t === 'micue' ? 'dl-' + t : '';
}

// ── Status pills (script toolbar) and missing cues ────────────────────
function missingCues() {
  const out = [];
  for (const gp of orderedGoPoints()) for (const c of gp.cues) {
    if (cueSource(c).state === 'missing') out.push({ gp, c });
  }
  return out;
}

function renderLiveStatus() {
  const box = document.getElementById('liveStatus');
  if (!box) return;
  const used = new Set(show.departments.map(d => d.target));
  const parts = [];
  for (const t of ['mikonsole', 'micue']) {
    if (!used.has(t)) continue;
    const L = live[t];
    let cls = 'off', txt = 'off', tip = liveOffText(t);
    if (liveAvailable(t)) {
      cls = 'on';
      txt = `${L.cues.length} cue${L.cues.length === 1 ? '' : 's'}`;
      tip = t === 'micue' ? `MiKue: ${L.show || 'show'} · ${txt}` : `MiKonsole · ${txt}`;
      if (t === 'micue' && !L.combos) {
        // An older MiKue: its cues are listed, but combo cues can't be worked out
        cls = 'half';
        txt += ' · older version';
        tip = 'This MiKue doesn’t report Continue / Follow or which MiKonsole cue it fires, so combo cues can’t be added. Use MiKue from 2026-10-17 on.';
      }
    } else if (t === 'mikonsole' && L.status !== 'off') {
      cls = 'half'; txt = L.status === 'relay' ? 'not connected' : 'older version';
    }
    parts.push(`<span class="live-pill ${cls}" title="${esc(tip)}"><span class="live-dot"></span>${APP_NAME[t]} <b>${esc(txt)}</b></span>`);
  }
  const miss = missingCues();
  if (miss.length) {
    const list = miss.slice(0, 12).map(m => cueText(m.c)).join(', ') + (miss.length > 12 ? '…' : '');
    parts.push(`<button class="live-miss" id="btnLiveMiss" title="Not in the other app's cue list: ${esc(list)}. Click to show the first.">${miss.length} not found</button>`);
  }
  const html = parts.join('');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}

// ── Change handling ───────────────────────────────────────────────────
function onLiveChanged() {
  const sig = JSON.stringify([live.mikonsole.status, live.mikonsole.hasNums, live.mikonsole.cues,
    live.micue.status, live.micue.combos, live.micue.cues]);
  if (sig === liveSig) return;
  liveSig = sig;
  refreshDatalists();
  renderMarks();                                   // tabs flag missing cues; also updates the inspector and status
  // MiKue came up (or changed): put its standby where MiKallbook's is (drive.js)
  if (typeof syncMicueStandby === 'function') { lastMicueStandby = null; syncMicueStandby(); }
  if (typeof updatePickerSource === 'function') updatePickerSource();
}

function initCueLists() {
  document.getElementById('liveStatus').addEventListener('click', e => {
    if (!e.target.closest('#btnLiveMiss')) return;
    const m = missingCues()[0];
    if (!m) return;
    if (mode === 'edit') selectGo(m.gp.id, true);
    else scrollToGo(m.gp.id);
  });
  renderLiveStatus();
  mkLoop();
  mcLoop();
}
