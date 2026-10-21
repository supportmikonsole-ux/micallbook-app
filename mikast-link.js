'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: the MiKast link (MiKast Phase 4, Mike 2026-10-19/20)
   A show can be linked to one MiKast production (Utilities › MiKast Link).
   MiKast owns the schedule; it flows one way, into MiKallbook:

   - Each MiKast call becomes a PLANNED session here: same kind and date,
     numbered by date (Rehearsal 1, 2, 3…). It shows in the Reports window
     under "Coming up (from MiKast)", where its report can be opened early.
     Start Session lists today's planned sessions by name and time first
     (the first milestone GO uses the one picked when Show mode started);
     a plain kind makes a session MiKast doesn't know about. Changing a
     session's Kind in the Session Log to that of a MiKast call that day
     offers to move it onto that call's session.
   - A planned session follows its call (date, kind) until it is started.
     A call deleted in MiKast takes its planned session with it when the
     session is still empty; otherwise the session stays, marked "call
     removed in MiKast". A session deleted here stays deleted (dismissed).
   - Report fields filled from MiKast: Call time, Absent / late, Next call
     and Called. Each is filled while it still holds what MiKast put there;
     once the SM types in it, it is theirs for that report.

   - Mic names (Mike, 2026-10-20): MiKast's Main mic plot (link.mics,
     { '<n>': personId }) puts names with MIC cues: the tab tooltip, Operator
     mode and the Booth View department view, and cue sheets.

   A planned session is stored like an untimed report (ended set, so it never
   counts as running) with planned: true and call: <MiKast call id>.
   show.mikast = { path, rel, prodId, name, dismissed: [callId] } | null

   mikast-link-main.js reads the files; this file never writes to MiKast.
   Uses app.js / timing.js / reports.js globals.
   ════════════════════════════════════════════════════════════════════ */

const MK_FIELDS = { call: 'call time', absent: 'absent / late', next: 'next call', called: 'called' };
const MK_KINDS = ['Rehearsal', 'Tech', 'Dress', 'Preview', 'Performance'];

let mk = { data: null, micSig: '' };   // the last read from mikast-link-main.js; micSig: mic names last drawn
let mkDlgOpen = false;

// ── Model ─────────────────────────────────────────────────────────────
function normalizeMikastRef(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) return null;
  return {
    path: raw.path,
    rel: typeof raw.rel === 'string' ? raw.rel : '',
    prodId: String(raw.prodId || ''),
    name: String(raw.name || ''),
    dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter(x => typeof x === 'string') : []
  };
}

function mkOk() { return !!(show.mikast && mk.data && mk.data.ok); }
function mkCalls() {
  if (!mkOk()) return [];
  const T = /^([01]\d|2[0-3]):[0-5]\d$/;
  return (mk.data.prod.link.calls || [])
    .filter(c => c && typeof c.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.date))
    .map(c => ({
      id: c.id, date: c.date, kind: MK_KINDS.includes(c.kind) ? c.kind : 'Rehearsal',
      start: T.test(c.start) ? c.start : '', end: T.test(c.end) ? c.end : '', show: T.test(c.show) ? c.show : '',
      place: String(c.place || ''), work: String(c.work || ''),
      called: Array.isArray(c.called) ? c.called.filter(x => typeof x === 'string') : []
    }))
    .sort((a, b) => (a.date + (a.start || '24:00')).localeCompare(b.date + (b.start || '24:00')));
}
function mkName(pid) { const n = mkOk() && mk.data.prod.link.names; return (n && n[pid]) || '(someone)'; }

// ── Mic names (MiKast's Main mic plot) ─────────────────────────────────
function mkMicMap() {
  if (!mkOk()) return null;
  const m = mk.data.prod.link.mics;
  return m && typeof m === 'object' && !Array.isArray(m) && Object.keys(m).length ? m : null;
}
// "4–8, 11" -> [4,5,6,7,8,11] (a range is capped at 200 mics)
function micNumbers(list) {
  const out = [];
  for (const part of String(list || '').split(',')) {
    const m = part.trim().match(/^(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?$/);
    if (!m) continue;
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (b < a) [a, b] = [b, a];
    for (let n = a; n <= Math.min(b, a + 199); n++) out.push(n);
  }
  return out;
}
// A cue called by mic numbers -> its groups (a cue typed before the department called by mics: its number)
function micGroupsOf(c) {
  if (!c || c.via || !deptCallsMics(c.dept)) return null;
  return Array.isArray(c.mics) ? c.mics : [{ m: String(c.number || ''), io: 'in' }];
}
// Who wears the mics of a cue: "4 Jane D., 5 Sam P., 6 —" ('' when not linked, no plot, or not a mic cue).
// With both IN and OUT in one cue, each part says which.
function micWhoText(c) {
  const map = mkMicMap();
  const groups = map && micGroupsOf(c);
  if (!groups) return '';
  const parts = groups.map(g => ({ io: g.io === 'out' ? 'OUT' : 'IN', nums: micNumbers(g.m) })).filter(g => g.nums.length);
  if (!parts.length) return '';
  const both = new Set(parts.map(g => g.io)).size > 1;
  return parts.map(g => (both ? g.io + ': ' : '') + g.nums.map(n => `${n} ${map[String(n)] ? mkName(map[String(n)]) : '—'}`).join(', ')).join(' · ');
}
// Lines for a list of cues: "MIC 4–8 IN: 4 Jane D., …" (mic cues only)
function micWhoLines(cues) {
  return (cues || []).map(c => { const t = micWhoText(c); return t ? `${cueText(c)}: ${t}` : ''; }).filter(Boolean);
}
// The names a show uses changed (linked, unlinked, or MiKast saved new mics / names): redraw what shows them
function micSig() { const m = mkMicMap(); return m ? JSON.stringify([m, mk.data.prod.link.names || {}]) : ''; }
function micNamesMaybeChanged() {
  const sig = micSig();
  if (sig === mk.micSig) return;
  mk.micSig = sig;
  if (typeof renderMarks === 'function') renderMarks();
  if (typeof renderOperator === 'function') renderOperator();
  if (typeof sendBooth === 'function') sendBooth();
  if (typeof csOpen !== 'undefined' && csOpen && typeof buildCueRows === 'function') buildCueRows();
}
function mkCall(id) { return mkCalls().find(c => c.id === id) || null; }

function mkToday() { return localDate(Date.now()); }
function mkHm(hm) {
  if (!/^\d{2}:\d{2}$/.test(hm || '')) return '';
  const [h, m] = hm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function mkClock(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function mkDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ── Sessions made from calls ──────────────────────────────────────────
// Planned sessions from today on, soonest first (the Reports window's "Coming up")
function comingUp() {
  const t = mkToday();
  return show.reports.filter(r => r.planned && r.date >= t).sort((a, b) => plannedKey(a).localeCompare(plannedKey(b)));
}
function plannedKey(s) { const c = s.call && mkCall(s.call); return s.date + ((c && c.start) || '24:00') + s.id; }

// Today's planned sessions as choices for Start Session and the Show-mode question,
// the one whose call time is nearest now first: [{ value:'plan:<id>', label, s }]
// (Mike, 2026-10-20: picking a kind by mistake made an unlinked session)
function todaysPlannedChoices() {
  const t = mkToday();
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes();
  const dist = s => {
    const c = s.call && mkCall(s.call);
    if (!c || !c.start) return 24 * 60;
    const [h, m] = c.start.split(':').map(Number);
    return Math.abs(h * 60 + m - nowMin);
  };
  return show.reports.filter(r => r.planned && r.date === t).sort((a, b) => dist(a) - dist(b)).map(s => {
    const c = s.call && mkCall(s.call);
    return { value: 'plan:' + s.id, s,
      label: [sessionTitle(s), c && c.start ? mkHm(c.start) : '', c && c.place ? c.place : ''].filter(Boolean).join(' · ') };
  });
}
// 'plan:<session id>' -> that planned session, if it is still planned
function plannedFromPick(v) {
  const m = /^plan:(.+)$/.exec(String(v || ''));
  const s = m && show.reports.find(r => r.id === m[1]);
  return s && s.planned ? s : null;
}

// A planned session becomes a real one (timing.js beginSession / sessionChanged)
function unplanSession(s) {
  s.planned = false;
  s.created = Date.now();
  if (typeof reportCarryForward === 'function') reportCarryForward(s, true);   // empty fields only
  renumberPlanned();
}

// Planned sessions are numbered by date, after the sessions of their kind that have happened
function renumberPlanned() {
  for (const kind of MK_KINDS) {
    const base = show.reports.filter(r => r.kind === kind && !r.planned).reduce((m, r) => Math.max(m, r.n), 0);
    show.reports.filter(r => r.kind === kind && r.planned)
      .sort((a, b) => plannedKey(a).localeCompare(plannedKey(b)))
      .forEach((s, i) => { s.n = base + 1 + i; });
  }
}

// ── A session started as the wrong kind (Mike, 2026-10-20) ────────────
// The Session Log's Kind changed to the kind of a planned session that day:
// offer to move everything onto that session. → Promise<'moved'|'kind'|'cancel'>
function plannedMatch(src, kind) {
  const d = new Date(src.created), at = d.getHours() * 60 + d.getMinutes();
  const dist = s => {
    const c = s.call && mkCall(s.call);
    if (!c || !c.start) return 24 * 60;
    const [h, m] = c.start.split(':').map(Number);
    return Math.abs(h * 60 + m - at);
  };
  return show.reports.filter(r => r.planned && r.kind === kind && r.date === src.date && r !== src).sort((a, b) => dist(a) - dist(b))[0] || null;
}

async function offerMoveToCall(src, kind) {
  const target = !src.planned && plannedMatch(src, kind);
  if (!target) return 'kind';
  const c = target.call && mkCall(target.call);
  const what = [c && c.start ? mkHm(c.start) : '', c && c.place].filter(Boolean).join(' · ');
  const ans = await ask(`Move this session onto ${sessionTitle(target)}?`,
    `${sessionTitle(target)} is the MiKast call for ${sessionDateText(target)}${what ? ` (${what})` : ''}. ` +
    `${sessionTitle(src)}’s times, holds and report notes move there, and ${sessionTitle(src)} is removed.\n\n` +
    `Just Change Kind only renames ${sessionTitle(src)}; it stays apart from the MiKast call.`, [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Just Change Kind', value: 'kind' },
    { label: `Move to ${sessionTitle(target)}`, value: 'move', cls: 'mi-btn-go' }], 'cancel');
  if (ans !== 'move') return ans;
  moveSessionInto(src, target);
  return 'moved';
}

function moveSessionInto(src, target) {
  target.events = src.events.concat(target.events);
  target.holds = src.holds.concat(target.holds);
  target.acts = src.acts;
  target.created = src.created;
  target.ended = src.ended;
  target.planned = false;
  delete target.callGone;
  // Report text: MiKast's own fields keep MiKast's values (the source's may only be carried
  // forward); other fields take the source's text, or both when both have something
  const mkIds = new Set(Object.keys(MK_FIELDS).map(k => mkField(k)).filter(Boolean).map(f => f.id));
  if (!target.fields || typeof target.fields !== 'object') target.fields = {};
  for (const [k, v] of Object.entries(src.fields || {})) {
    const sv = String(v || '').trim();
    if (!sv || mkIds.has(k)) continue;
    const tv = String(target.fields[k] || '').trim();
    target.fields[k] = !tv || tv === sv ? v : `${target.fields[k]}\n${v}`;
  }
  show.reports = show.reports.filter(r => r !== src);
  // The GO points this run logged point at the session that stays (Back still works)
  if (typeof msLogged !== 'undefined') msLogged.forEach(rec => { if (rec.sid === src.id) { rec.sid = target.id; rec.wasPlanned = false; } });
  if (typeof tmDlgId !== 'undefined' && tmDlgId === src.id) tmDlgId = target.id;
  if (typeof rpId !== 'undefined' && rpId === src.id) rpId = target.id;
  renumberPlanned();
  clearRecovery();
  sessionChanged(target);
  syncFromMikast();          // a call the source belonged to (if any) gets its planned session back
  toast(`Moved to ${sessionTitle(target)}`, 'ok');
}

// Deleting a session made from a call here: it doesn't come back at the next read
function mikastDismiss(callId) {
  if (!show.mikast || !callId) return;
  if (!show.mikast.dismissed.includes(callId)) show.mikast.dismissed.push(callId);
}

// Nothing typed in it (fields still as MiKast left them), no times
function reportUntouched(s) {
  if (s.events.length || s.holds.length) return false;
  const auto = s.auto || {};
  return Object.keys(s.fields || {}).every(k => !String(s.fields[k] || '').trim() || s.fields[k] === auto[k]);
}

// ── Report fields filled from MiKast ──────────────────────────────────
function mkField(key) { return reportFields().find(f => f.label.trim().toLowerCase() === MK_FIELDS[key]) || null; }

// The Called line goes after Absent / late, the first time a show is linked
function ensureCalledField() {
  if (mkField('called')) return;
  const fields = reportFields();
  const i = fields.findIndex(f => f.label.trim().toLowerCase() === MK_FIELDS.absent);
  const f = { id: uid(), label: 'Called', type: 'line', carry: false };
  fields.splice(i >= 0 ? i + 1 : fields.length, 0, f);
}

// Fills a field while it still holds what MiKast put there (or nothing)
function setAuto(s, key, value) {
  const f = mkField(key);
  if (!f) return false;
  if (!s.fields || typeof s.fields !== 'object') s.fields = {};
  if (!s.auto || typeof s.auto !== 'object') s.auto = {};
  const cur = String(s.fields[f.id] || '');
  const last = s.auto[f.id];
  if (cur !== '' && cur !== last) return false;          // the SM has written their own
  let changed = false;
  if (cur !== value) {
    if (value) s.fields[f.id] = value; else delete s.fields[f.id];
    changed = true;
  }
  if (value) s.auto[f.id] = value; else delete s.auto[f.id];
  return changed;
}

function mkAttendance(callId) {
  const a = mkOk() && mk.data.attendance && mk.data.attendance.calls;
  const ac = a && a[callId];
  return ac && typeof ac === 'object' ? { absentDone: !!ac.absentDone, att: ac.att && typeof ac.att === 'object' ? ac.att : {} } : null;
}

// "Absent: Sam P. (texted 6:45) · Late: Alex R. (7:12) · Excused: Jane D. (doctor)"
function absentLateText(c) {
  const ac = mkAttendance(c.id);
  if (!ac || (!Object.keys(ac.att).length && !ac.absentDone)) return '';     // nothing from sign-in yet
  const called = new Set(c.called);
  const by = { absent: [], late: [], excused: [] };
  const sortName = (x, y) => x.name.localeCompare(y.name);
  for (const pid of called) {
    const r = ac.att[pid];
    if (!r || !by[r.s]) continue;
    const bits = [];
    if (r.s === 'late' && r.at) bits.push(mkClock(r.at));
    if (r.note && String(r.note).trim()) bits.push(String(r.note).trim());
    by[r.s].push({ name: mkName(pid), text: mkName(pid) + (bits.length ? ` (${bits.join(', ')})` : '') });
  }
  const part = (label, list) => list.length ? `${label}: ${list.sort(sortName).map(x => x.text).join(', ')}` : '';
  const out = [part('Absent', by.absent), part('Late', by.late), part('Excused', by.excused)].filter(Boolean).join(' · ');
  return out || 'None';
}

// "27 called · 25 in · 1 late · 1 absent"
function calledText(c) {
  const ac = mkAttendance(c.id);
  const n = { in: 0, late: 0, absent: 0, excused: 0, expected: 0 };
  c.called.forEach(pid => { const r = ac && ac.att[pid]; n[r && n[r.s] !== undefined ? r.s : 'expected']++; });
  const parts = [`${c.called.length} called`];
  if (ac && (Object.keys(ac.att).length || ac.absentDone)) {
    parts.push(`${n.in} in`);
    if (n.late) parts.push(`${n.late} late`);
    if (n.absent) parts.push(`${n.absent} absent`);
    if (n.excused) parts.push(`${n.excused} excused`);
    if (n.expected) parts.push(`${n.expected} not in yet`);
  }
  return parts.join(' · ');
}

// "Thu Oct 22 · Rehearsal 7:00 PM · Main stage · Act 2"
function nextCallText(c) {
  const calls = mkCalls();
  const i = calls.findIndex(x => x.id === c.id);
  const nx = i >= 0 ? calls[i + 1] : null;
  if (!nx) return '';
  return [mkDay(nx.date), `${nx.kind}${nx.start ? ' ' + mkHm(nx.start) : ''}`, nx.place, nx.work].filter(Boolean).join(' · ');
}

function fillFromCall(s, c) {
  let ch = false;
  ch = setAuto(s, 'call', c.start) || ch;
  ch = setAuto(s, 'next', nextCallText(c)) || ch;
  ch = setAuto(s, 'absent', absentLateText(c)) || ch;
  ch = setAuto(s, 'called', calledText(c)) || ch;
  if (ch) s.updated = Date.now();
  return ch;
}

// ── Reading MiKast into the show ──────────────────────────────────────
function syncFromMikast() {
  if (!mkOk()) return;
  const before = JSON.stringify([show.reports, show.reportFields, show.mikast]);
  reportFields();
  ensureCalledField();
  const calls = mkCalls();
  const ids = new Set(calls.map(c => c.id));
  const dismissed = new Set(show.mikast.dismissed);
  show.mikast.name = mk.data.prod.name;
  show.mikast.prodId = mk.data.prod.id;

  for (const c of calls) {
    if (dismissed.has(c.id)) continue;
    let s = show.reports.find(r => r.call === c.id);
    // A session made here before linking, same date and kind: adopted, not doubled
    if (!s) s = show.reports.find(r => !r.call && r.date === c.date && r.kind === c.kind);
    if (s) s.call = c.id;
    else {
      const now = Date.now();
      s = normalizeReport({ id: uid(), kind: c.kind, n: 1, date: c.date, created: now, ended: now,
        acts: show.timing.acts, events: [], holds: [], fields: {}, planned: true, call: c.id });
      show.reports.push(s);
    }
    if (s.planned) { s.kind = c.kind; s.date = c.date; }
    delete s.callGone;
    fillFromCall(s, c);
  }
  // Calls deleted in MiKast
  show.reports = show.reports.filter(s => {
    if (!s.call || ids.has(s.call) || dismissed.has(s.call)) return true;
    if (s.planned && reportUntouched(s)) return false;
    s.callGone = true;
    return true;
  });
  renumberPlanned();

  if (JSON.stringify([show.reports, show.reportFields, show.mikast]) !== before) {
    markDirty();
    renderTiming();
    mkRefreshReports();
  }
}

// The Reports window: list, and the shown report's MiKast fields (not the one being typed in)
function mkRefreshReports() {
  if (typeof rpOpen === 'undefined' || !rpOpen) return;
  if (typeof reportsRefresh === 'function') reportsRefresh();
  const s = typeof rpSession === 'function' ? rpSession() : null;
  if (!s || rpMode !== 'report') return;
  for (const key of Object.keys(MK_FIELDS)) {
    const f = mkField(key);
    const el = f && document.querySelector(`#rpBody [data-fid="${f.id}"]`);
    if (!el) {
      if (f && key === 'called') renderReports();           // the field was just added to the template
      continue;
    }
    if (el === document.activeElement) continue;
    const v = String((s.fields || {})[f.id] || '');
    if (el.value !== v) { el.value = v; if (el.tagName === 'TEXTAREA' && typeof autoGrow === 'function') autoGrow(el); }
  }
}

function onMikastData(d) {
  if (!show.mikast) return;
  const was = mk.data;
  mk.data = d;
  if (d && d.ok) syncFromMikast();
  else if (!was || was.ok || was.error !== d.error) toast(`MiKast link: ${d ? d.message : 'no answer'}`, 'err');
  renderMikastStatus();
  micNamesMaybeChanged();
  if (mkDlgOpen) renderMikastDialog();
}

// Start (or stop) reading the linked production: after open, new, save and linking
async function mikastStart() {
  mk.data = null;
  if (!show.mikast) {
    try { await bridge.mikast.unwatch(); } catch (_) {}
    renderMikastStatus();
    micNamesMaybeChanged();
    return;
  }
  let r;
  try { r = await bridge.mikast.watch(showPath, show.mikast); } catch (_) { r = null; }
  // The relative path follows a first save or Save As (kept with the next save)
  if (r && r.ok && show.mikast) {
    if (r.path) show.mikast.path = r.path;
    if (typeof r.rel === 'string') show.mikast.rel = r.rel;
  }
  renderMikastStatus();
}

// ── Status pill (calling column) and the Utilities hint ───────────────
function mikastStatusText() {
  if (!show.mikast) return { cls: 'off', txt: 'not linked', tip: '' };
  if (!mk.data) return { cls: 'half', txt: 'reading…', tip: show.mikast.path };
  if (!mk.data.ok) return { cls: 'half', txt: mk.data.error === 'missing' ? 'file not found' : mk.data.error === 'old' ? 'save it in MiKast' : 'can’t read', tip: mk.data.message };
  const n = mkCalls().length;
  return { cls: 'on', txt: `${n} call${n === 1 ? '' : 's'}`, tip: `MiKast: ${mk.data.prod.name} · ${n} call${n === 1 ? '' : 's'}\n${mk.data.path}\nClick for the MiKast Link window` };
}
function renderMikastStatus() {
  const box = document.getElementById('mkStatus');
  if (!box) return;
  if (!show.mikast) { box.innerHTML = ''; box.dataset.html = ''; return; }
  const st = mikastStatusText();
  const html = `<button class="live-pill mk-pill ${st.cls}" id="btnMkPill" title="${esc(st.tip)}"><span class="live-dot"></span>MiKast <b>${esc(st.txt)}</b></button>`;
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}
function mikastMenuHint() {
  if (!show.mikast) return 'calls → sessions';
  const st = mikastStatusText();
  return st.cls === 'on' ? `${mk.data.prod.name} · ${st.txt}` : st.txt;
}

// ── MiKast Link window ────────────────────────────────────────────────
function mikastDialogIsOpen() { return mkDlgOpen; }
function openMikastDialog() {
  mkDlgOpen = true;
  document.getElementById('mkOverlay').classList.add('open');
  renderMikastDialog();
}
function closeMikastDialog() {
  mkDlgOpen = false;
  document.getElementById('mkOverlay').classList.remove('open');
}

function renderMikastDialog() {
  const el = document.getElementById('mkBody');
  const foot = btns => `<div class="modal-btns"><div class="tb-fill"></div>${btns}<button class="mi-btn mi-btn-go" data-mk="close" style="padding:9px 18px">Close</button></div>`;
  if (!show.mikast) {
    el.innerHTML = `
      <div class="modal-msg">MiKast Link</div>
      <div class="mk-help">Link this show to its MiKast production. Each call in MiKast (rehearsals, techs, dresses, previews, performances) becomes a session here, ready to start, and its report fills in the call time, who is absent or late, who was called and the next call.</div>
      <div class="mk-help">MiKallbook only reads MiKast’s files: calls as MiKast last saved them, and sign-ins the moment they happen. Run both on the same computer, or keep the production where this computer can open it.</div>
      ${foot('<button class="mi-btn" data-mk="pick">Choose Production…</button>')}`;
    return;
  }
  const st = mikastStatusText();
  const planned = show.reports.filter(r => r.planned).length;
  const up = comingUp().length;
  const linked = show.reports.filter(r => r.call).length;
  el.innerHTML = `
    <div class="modal-msg">MiKast Link</div>
    <div class="mk-row"><span class="mi-label">Production</span><span class="mk-val"><b>${esc((mk.data && mk.data.ok && mk.data.prod.name) || show.mikast.name || '')}</b></span></div>
    <div class="mk-row"><span class="mi-label">File</span><span class="mk-val mk-path">${esc((mk.data && mk.data.path) || show.mikast.path)}</span></div>
    <div class="mk-row"><span class="mi-label">Status</span><span class="mk-val"><span class="live-pill ${st.cls}"><span class="live-dot"></span>${esc(st.txt)}</span>
      ${mk.data && mk.data.ok ? `<span class="mk-dim">read ${esc(new Date(mk.data.read).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span>` : ''}</span></div>
    ${mk.data && !mk.data.ok ? `<div class="mk-warn">${esc(mk.data.message)}</div>` : ''}
    <div class="mk-row"><span class="mi-label">Sessions</span><span class="mk-val">${linked} from MiKast calls · ${up} coming up${planned - up > 0 ? ` · ${planned - up} past, never started` : ''}</span></div>
    <div class="mk-help">Calls change here when MiKast saves; sign-ins show the moment they happen. Report fields MiKast fills (Call time, Absent / late, Called, Next call) stay yours once you type in them.</div>
    ${foot('<button class="mi-btn mi-btn-exit" data-mk="unlink">Unlink</button><button class="mi-btn" data-mk="pick">Choose Another…</button>')}`;
}

async function mikastPickCmd() {
  let r;
  try { r = await bridge.mikast.pick(showPath); } catch (err) { toast('Couldn’t choose: ' + cleanErr(err), 'err'); return; }
  if (!r || r.canceled || !r.path) return;
  const same = show.mikast && show.mikast.path === r.path;
  if (show.mikast && !same) mikastUnlinkSessions();
  show.mikast = normalizeMikastRef({ path: r.path, rel: r.rel || '', dismissed: same ? show.mikast.dismissed : [] });
  markDirty();
  await mikastStart();
  if (mkDlgOpen) renderMikastDialog();
}

// Sessions made from calls lose their link: unused planned ones go, the rest stay as ordinary reports
function mikastUnlinkSessions() {
  show.reports = show.reports.filter(s => !(s.planned && reportUntouched(s)));
  show.reports.forEach(s => {
    if (s.planned) { s.planned = false; }
    delete s.call; delete s.callGone; delete s.auto;
  });
  renumberPlanned();
}

async function mikastUnlinkCmd() {
  const unused = show.reports.filter(s => s.planned && reportUntouched(s)).length;
  const ok = await ask('Unlink from MiKast?',
    `Sessions stop following MiKast’s calls.${unused ? `\n\n${unused} planned session${unused === 1 ? '' : 's'} not used yet ${unused === 1 ? 'is' : 'are'} removed.` : ''} Sessions already timed, or with anything written in their report, are kept.`, [
    { label: 'Cancel', value: false }, { label: 'Unlink', value: true, cls: 'mi-btn-exit' }], false);
  if (!ok) return;
  mikastUnlinkSessions();
  show.mikast = null;
  markDirty();
  await mikastStart();
  renderTiming();
  if (typeof reportsRefresh === 'function') reportsRefresh();
  renderMikastDialog();
}

function mikastDialogKey(e) {
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeMikastDialog(); }
}

function initMikastLink() {
  bridge.mikast.onData(onMikastData);
  document.getElementById('miMikast').addEventListener('click', () => openMikastDialog());
  document.getElementById('mkStatus').addEventListener('click', e => { if (e.target.closest('#btnMkPill')) openMikastDialog(); });
  const ov = document.getElementById('mkOverlay');
  ov.addEventListener('click', async e => {
    if (e.target === ov) { closeMikastDialog(); return; }
    const b = e.target.closest('[data-mk]');
    if (!b) return;
    if (b.dataset.mk === 'close') closeMikastDialog();
    else if (b.dataset.mk === 'pick') await mikastPickCmd();
    else if (b.dataset.mk === 'unlink') await mikastUnlinkCmd();
  });
  // Past midnight, yesterday's planned sessions move from "Coming up" to the sessions so far
  setInterval(() => { if (mkOk() && typeof rpOpen !== 'undefined' && rpOpen) renderReportList(); }, 60000);
  renderMikastStatus();
}
