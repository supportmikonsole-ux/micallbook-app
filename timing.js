'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: show clock and timing (Phase 3a)
   A session is one rehearsal or performance. In Show mode the timing box
   in the calling column starts a session, logs the milestones in order
   (House Open, Places, Act 1 Up, Act 1 Down, … last act Down) with one
   button, and times holds. Run times, intermissions and time held work
   themselves out. The Session Log dialog edits times afterwards (a
   milestone logged late, a hold that wasn't pressed), adds other moments,
   and ends or deletes the session.

   Sessions are saved in the show file (show.reports, one record per
   session; Phase 3b adds the report fields to the same record). Until the
   show is saved, an open session is also kept in this computer's
   localStorage, so a crash mid-performance doesn't lose the times: opening
   the show again offers to restore them.

   Hidden in Edit and Operator mode and on a computer that follows the SM.
   A session keeps running in Edit mode (fixing a mark at a rehearsal).

   Uses app.js globals (show, mode, markDirty, ask, toast, uid).
   ════════════════════════════════════════════════════════════════════ */

const SESSION_KINDS = ['Rehearsal', 'Tech', 'Dress', 'Preview', 'Performance'];
const HOLD_REASONS  = ['Late house', 'Technical', 'Cast', 'Audience', 'Weather', 'Other'];
const MAX_ACTS = 5;
const RECOVERY_PREFIX = 'micallbook.session.';

let tmDlgOpen = false;
let tmDlgId = null;          // the session the Session Log shows

// ── Model ─────────────────────────────────────────────────────────────
function normalizeTiming(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const acts = Math.round(Number(t.acts));
  return { acts: acts >= 1 && acts <= MAX_ACTS ? acts : 2 };
}

function normalizeReport(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const acts = Math.round(Number(raw.acts));
  return {
    id: raw.id,
    kind: SESSION_KINDS.includes(raw.kind) ? raw.kind : 'Rehearsal',
    n: Math.max(1, Math.round(Number(raw.n)) || 1),
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : localDate(num(raw.created) || Date.now()),
    created: num(raw.created) || Date.now(),
    updated: num(raw.updated) || num(raw.created) || Date.now(),
    ended: num(raw.ended),
    acts: acts >= 1 && acts <= MAX_ACTS ? acts : 2,
    events: (Array.isArray(raw.events) ? raw.events : [])
      .filter(e => e && typeof e.key === 'string' && num(e.t) !== null)
      .map(e => ({ id: typeof e.id === 'string' && e.id ? e.id : uid(), key: e.key, label: String(e.label || ''), t: e.t })),
    holds: (Array.isArray(raw.holds) ? raw.holds : [])
      .filter(h => h && num(h.start) !== null)
      .map(h => ({ id: typeof h.id === 'string' && h.id ? h.id : uid(), start: h.start, end: num(h.end), reason: String(h.reason || '') })),
    fields: raw.fields && typeof raw.fields === 'object' ? raw.fields : {},
    // MiKast link (mikast-link.js): a session made from a MiKast call
    ...(typeof raw.call === 'string' && raw.call ? { call: raw.call } : {}),
    ...(raw.planned ? { planned: true } : {}),                 // not started yet (stored as ended, never running)
    ...(raw.callGone ? { callGone: true } : {}),               // its call was deleted in MiKast
    ...(raw.auto && typeof raw.auto === 'object' ? { auto: raw.auto } : {})   // what MiKast last filled in, per field
  };
}

function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// The milestones of a session, in order: house, places, up1, down1, … downN
function milestoneKeys(acts) {
  const k = ['house', 'places'];
  for (let i = 1; i <= acts; i++) k.push('up' + i, 'down' + i);
  return k;
}
function milestoneLabel(key) {
  if (key === 'house') return 'House Open';
  if (key === 'places') return 'Places';
  const m = /^(up|down)(\d)$/.exec(key);
  if (m) return `Act ${m[2]} ${m[1] === 'up' ? 'Up' : 'Down'}`;
  return 'Other';
}
function eventLabel(e) { return e.key === 'other' ? (e.label || 'Other') : milestoneLabel(e.key); }

function sessionTitle(s) { return `${s.kind} ${s.n}`; }
function sessionDateText(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function openSession() { return show.reports.find(r => !r.ended) || null; }
function lastSession() {
  return show.reports.reduce((a, r) => (r.planned ? a : (!a || r.created > a.created ? r : a)), null);   // not planned ones
}
function sortedEvents(s) { return s.events.slice().sort((a, b) => a.t - b.t); }
function runningHold(s) { return s.holds.find(h => h.end === null) || null; }

// Where the session stands: the last milestone logged (by time; 'other'
// moments don't change it)
function sessionState(s) {
  const ev = sortedEvents(s).filter(e => e.key !== 'other');
  return ev.length ? ev[ev.length - 1] : null;
}

// The milestone the Next button logs: the one after the last logged
function nextMilestone(s) {
  const keys = milestoneKeys(s.acts);
  const st = sessionState(s);
  const i = st ? keys.indexOf(st.key) : -1;
  return i + 1 < keys.length ? keys[i + 1] : null;
}

// Hold time inside [a, b] (b null = now)
function heldWithin(s, a, b) {
  const now = Date.now();
  const end = b === null ? now : b;
  return s.holds.reduce((sum, h) => {
    const hs = Math.max(h.start, a), he = Math.min(h.end === null ? now : h.end, end);
    return sum + Math.max(0, he - hs);
  }, 0);
}

// Run times: each Act n Down paired with the latest Act n Up before it
function sessionSummary(s) {
  const ev = sortedEvents(s);
  const firstOf = k => ev.find(e => e.key === k) || null;
  const acts = [];
  for (let n = 1; n <= s.acts; n++) {
    const down = ev.filter(e => e.key === 'down' + n).pop() || null;
    const ups = ev.filter(e => e.key === 'up' + n && (!down || e.t <= down.t));
    const up = ups.length ? ups[ups.length - 1] : null;
    acts.push({ n, up: up ? up.t : null, down: down && up ? down.t : null,
                run: up && down ? down.t - up.t : null,
                held: up && down ? heldWithin(s, up.t, down.t) : 0 });
  }
  const intermissions = [];
  for (let n = 1; n < s.acts; n++) {
    const a = acts[n - 1], b = acts[n];
    if (a.down !== null && b.up !== null && b.up > a.down) intermissions.push({ after: n, len: b.up - a.down });
  }
  const ups = acts.filter(a => a.up !== null), downs = acts.filter(a => a.down !== null);
  const firstUp = ups.length ? Math.min(...ups.map(a => a.up)) : null;
  const lastDown = downs.length ? Math.max(...downs.map(a => a.down)) : null;
  const house = firstOf('house'), places = firstOf('places');
  return {
    house: house ? house.t : null,
    places: places ? places.t : null,
    acts, intermissions,
    total: firstUp !== null && lastDown !== null && lastDown > firstUp ? lastDown - firstUp : null,
    held: s.holds.reduce((sum, h) => sum + Math.max(0, (h.end === null ? Date.now() : h.end) - h.start), 0)
  };
}

function fmtDur(ms) {
  if (ms === null || !Number.isFinite(ms)) return '-';
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtTime(ms) {
  return ms === null ? '-' : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
// For <input type="time" step="1">: "HH:MM:SS"
function timeValue(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
}
// "HH:MM[:SS]" on the calendar day of baseMs; null if not a time
function parseTimeOn(str, baseMs) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(str || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2], se = m[3] ? +m[3] : 0;
  if (h > 23 || mi > 59 || se > 59) return null;
  const d = new Date(baseMs);
  d.setHours(h, mi, se, 0);
  return d.getTime();
}

// ── Changes ───────────────────────────────────────────────────────────
// soft: a field edited in the Session Log. Only the Times part is redrawn,
// so a click on the next field isn't lost to a re-render.
function sessionChanged(s, soft) {
  // A planned session (from MiKast) that gets times, or is reopened, has started
  if (s.planned && (s.ended === null || s.events.length || s.holds.length) && typeof unplanSession === 'function') unplanSession(s);
  s.updated = Date.now();
  markDirty();
  saveRecovery(s);
  renderTiming();
  if (typeof reportsRefresh === 'function') reportsRefresh();   // reports.js: list and times
  if (!tmDlgOpen) return;
  if (soft) {
    const box = document.getElementById('tmSumBox');
    const r = dlgSession();
    if (box && r) box.innerHTML = summaryHtml(r);
  } else {
    renderTimingDialog();
  }
}

// A new session record. untimed: a report written without the clock (Reports
// window, + New Report): it starts ended, so it never counts as running.
function createSession(kind, untimed) {
  const now = Date.now();
  const n = show.reports.filter(r => r.kind === kind && !r.planned).reduce((m, r) => Math.max(m, r.n), 0) + 1;
  const s = normalizeReport({
    id: uid(), kind, n, date: localDate(now), created: now, ended: untimed ? now : null,
    acts: show.timing.acts, events: [], holds: [], fields: {}
  });
  if (typeof reportCarryForward === 'function') reportCarryForward(s);   // reports.js
  show.reports.push(s);
  if (typeof renumberPlanned === 'function') renumberPlanned();   // planned sessions (MiKast) come after it
  sessionChanged(s);
  return s;
}

async function startSessionCmd() {
  if (openSession()) return;
  const kind = await askSessionKind();
  if (!kind) return;
  const r = beginSession(kind);
  toast(r.reused ? `Timing ${sessionTitle(r.s)} (its report so far is kept)` : `${sessionTitle(r.s)} started`, 'ok');
}

// Start timing a session of this kind. A report of the same kind made today
// without the clock (e.g. phone notes that came in before the SM started
// timing) is timed, rather than making a second one. → { s, reused }
// kind: a session kind, or 'plan:<id>' for a planned session from MiKast (picked by
// name in Start Session or the Show-mode question). A plain kind makes a session
// MiKast doesn't know about (Mike, 2026-10-20).
function beginSession(kind) {
  const planned = typeof plannedFromPick === 'function' ? plannedFromPick(kind) : null;
  if (/^plan:/.test(String(kind)) && !planned) kind = 'Rehearsal';   // gone since it was picked
  if (planned) {
    planned.ended = null;
    planned.acts = show.timing.acts;
    sessionChanged(planned);                 // starts it (unplanSession)
    return { s: planned, reused: true, planned: true };
  }
  const today = localDate(Date.now());
  const untimed = show.reports.filter(r => r.kind === kind && r.date === today && r.ended && !r.planned && !r.events.length && !r.holds.length)
    .sort((x, y) => y.created - x.created)[0];
  if (untimed) {
    untimed.ended = null;
    untimed.acts = show.timing.acts;
    sessionChanged(untimed);
    return { s: untimed, reused: true };
  }
  return { s: createSession(kind, false), reused: false };
}

// ── Milestones called as cues (Mike, 2026-10-18) ──────────────────────
// A GO point can carry a milestone (marks.js MS_DEPT). GO in Show mode, on
// the SM's computer, logs it: the first one starts a session (the kind
// chosen when Show mode started, else the last kind used, else
// Performance), and the last act's Down ends it. Back over that GO point
// takes its time out again. In a show with milestone cues the timing box
// keeps Hold and the Session Log, and its milestone button is hidden.
let sessionKindPick = null;          // set by the Show-mode prompt (drive.js)
const msLogged = new Map();          // GO point id -> { sid, evId, started, ended } (this run, for Back)

function bookHasMilestones() { return show.goPoints.some(g => goMilestone(g)); }
// The highest act in the book's milestones (0 = none)
function bookActs() {
  let n = 0;
  for (const g of show.goPoints) {
    const m = /^(up|down)(\d)$/.exec(goMilestone(g) || '');
    if (m) n = Math.max(n, +m[2]);
  }
  return n;
}
function autoSessionKind() {
  if (SESSION_KINDS.includes(sessionKindPick)) return sessionKindPick;
  if (typeof plannedFromPick === 'function' && plannedFromPick(sessionKindPick)) return sessionKindPick;
  // Nothing picked: today's MiKast call nearest now, if there is one
  const today = typeof todaysPlannedChoices === 'function' ? todaysPlannedChoices() : [];
  if (today.length) return today[0].value;
  const last = lastSession();
  return last ? last.kind : 'Performance';
}

// calling.js go(), after the GO point is called
function timingOnGo(gp) {
  if (mode !== 'show' || (typeof linkRole !== 'undefined' && linkRole === 'client')) return;
  const key = gp && goMilestone(gp);
  if (!key) return;
  let s = openSession(), started = false, reused = false, wasPlanned = false;
  if (!s) { const r = beginSession(autoSessionKind()); s = r.s; started = true; reused = r.reused; wasPlanned = !!r.planned; }
  // Acts: as many as the book's milestones have (never fewer than already logged)
  const acts = bookActs();
  if (acts) {
    const logged = s.events.reduce((n, e) => { const m = /^(up|down)(\d)$/.exec(e.key); return m ? Math.max(n, +m[2]) : n; }, 0);
    s.acts = Math.min(MAX_ACTS, Math.max(acts, logged));
    show.timing.acts = s.acts;
  }
  const now = Date.now();
  const ev = { id: uid(), key, label: '', t: now };
  s.events.push(ev);
  let note = '';
  const h = runningHold(s);
  if (h && /^up\d$/.test(key)) { h.end = now; note = ` · hold ended (${fmtDur(h.end - h.start)})`; }
  let ended = false;
  if (key === 'down' + s.acts) {
    // The last act is down: the session ends (Reopen in the Session Log if that was early)
    const hh = runningHold(s);
    if (hh) hh.end = now;
    s.ended = now;
    ended = true;
  }
  msLogged.set(gp.id, { sid: s.id, evId: ev.id, started, ended, wasPlanned });
  sessionChanged(s);
  const what = `${milestoneLabel(key)} · ${fmtTime(now)}`;
  if (ended) {
    const sum = sessionSummary(s);
    toast(`${what} · ${sessionTitle(s)} ended${sum.total !== null ? ` · running time ${fmtDur(sum.total)}` : ''}`, 'ok');
  } else if (started) {
    toast(`${sessionTitle(s)} ${reused ? 'timing (report kept)' : 'started'} · ${what}${note}`, 'ok');
  } else {
    toast(what + note, 'ok');
  }
}

// calling.js back(), with the GO point that becomes Standby again
function timingOnBack(gp) {
  const rec = gp && msLogged.get(gp.id);
  if (!rec) return;
  msLogged.delete(gp.id);
  const s = show.reports.find(r => r.id === rec.sid);
  if (!s) return;
  const ev = s.events.find(e => e.id === rec.evId);
  s.events = s.events.filter(e => e.id !== rec.evId);
  if (rec.ended && s.ended && !openSession()) s.ended = null;      // that GO ended it: running again
  // A planned session (MiKast) this GO started, with nothing logged now: planned again
  if (rec.started && rec.wasPlanned && !s.events.length && !s.holds.length) {
    s.ended = Date.now();
    s.planned = true;
    if (typeof renumberPlanned === 'function') renumberPlanned();
    clearRecovery();
    markDirty();
    renderTiming();
    if (typeof reportsRefresh === 'function') reportsRefresh();
    toast(`${sessionTitle(s)} is planned again (Back over its first milestone)`, 'ok');
    return;
  }
  // A session this GO started that holds nothing else: gone again
  const hasFields = Object.keys(s.fields || {}).some(k => String(s.fields[k] || '').trim());
  if (rec.started && !s.events.length && !s.holds.length && !hasFields) {
    show.reports = show.reports.filter(r => r !== s);
    clearRecovery();
    markDirty();
    renderTiming();
    if (typeof reportsRefresh === 'function') reportsRefresh();
    if (tmDlgOpen && tmDlgId === s.id) closeTimingDialog();
    toast(`${sessionTitle(s)} removed (Back over its first milestone)`, 'ok');
    return;
  }
  sessionChanged(s);
  if (ev) toast(`${milestoneLabel(ev.key)} time taken out (Back)`, 'ok');
}

// Small chooser: one button per kind (Performance last, as the default)
// Today's MiKast calls come first, by name (the nearest has the focus: Enter starts it);
// the plain kinds below make a session MiKast doesn't know about.
function askSessionKind() {
  const last = lastSession();
  const choices = typeof todaysPlannedChoices === 'function' ? todaysPlannedChoices() : [];
  const detail = `Times House Open, Places, each act and intermission, and holds. ` +
    `${show.timing.acts} act${show.timing.acts === 1 ? '' : 's'} (change in the Session Log).` +
    (last ? `\n\nLast session: ${sessionTitle(last)} · ${sessionDateText(last)}` : '');
  let extra = null;
  if (choices.length) {
    extra = document.createElement('div');
    extra.className = 'mk-choices';
    extra.innerHTML = `<div class="mi-label">Today’s calls from MiKast</div>` +
      choices.map(c => `<button class="mi-btn mk-choice" data-v="${esc(c.value)}">${esc(c.label)}</button>`).join('') +
      `<div class="mi-label mk-other">Or a session MiKast doesn’t know about:</div>`;
    extra.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) closeModal(b.dataset.v); });
    setTimeout(() => { const b = extra.querySelector('.mk-choice'); if (b) b.focus(); }, 30);   // after ask() focuses its last button
  }
  return ask('Start a session', detail, [
    { label: 'Cancel', value: null },
    ...SESSION_KINDS.map(k => ({ label: k, value: k, cls: k === 'Performance' && !choices.length ? 'mi-btn-go' : '' }))
  ], null, extra);
}

function logMilestone(s, key, label) {
  const now = Date.now();
  s.events.push({ id: uid(), key, label: key === 'other' ? String(label || 'Other') : '', t: now });
  // The curtain going up ends a hold
  const h = runningHold(s);
  let note = '';
  if (h && /^up\d$/.test(key)) { h.end = now; note = ` · hold ended (${fmtDur(h.end - h.start)})`; }
  sessionChanged(s);
  toast(`${milestoneLabel(key) === 'Other' ? label : milestoneLabel(key)} · ${fmtTime(now)}${note}`, 'ok');
}

const NEXT_GUARD_MS = 1000;   // a double click logs one milestone, not two
let lastNextAt = -Infinity;      // not 0: performance.now() starts near 0 when the window opens
async function nextCmd() {
  const now = performance.now();
  if (now - lastNextAt < NEXT_GUARD_MS) return;
  lastNextAt = now;
  const s = openSession();
  if (!s) { startSessionCmd(); return; }
  const key = nextMilestone(s);
  if (key) { logMilestone(s, key); return; }
  await endSessionCmd(s);
}

function holdCmd() {
  const s = openSession();
  if (!s) return;
  const h = runningHold(s);
  if (h) {
    h.end = Date.now();
    sessionChanged(s);
    toast(`Hold ended · ${fmtDur(h.end - h.start)}`, 'ok');
  } else {
    s.holds.push({ id: uid(), start: Date.now(), end: null, reason: '' });
    sessionChanged(s);
  }
}

async function endSessionCmd(s) {
  if (!s || s.ended) return;
  const sum = sessionSummary(s);
  const ok = await ask(`End ${sessionTitle(s)}?`,
    (sum.total !== null ? `Running time ${fmtDur(sum.total)}.\n` : '') +
    'The times are kept with the show (save to keep them). The Session Log can still change them.', [
    { label: 'Cancel', value: false },
    { label: 'End Session', value: true, cls: 'mi-btn-go' }
  ], false);
  if (!ok) return;
  const h = runningHold(s);
  if (h) h.end = Date.now();
  s.ended = Date.now();
  sessionChanged(s);
}

// Exit with a session still running: end it, or leave it to resume
async function timingBeforeExit() {
  const s = openSession();
  if (!s) return true;
  const ans = await ask(`${sessionTitle(s)} is still running`, 'End it now, or leave it running to carry on when this show is opened again.', [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Leave Running', value: 'leave' },
    { label: 'End Session', value: 'end', cls: 'mi-btn-go' }
  ], 'cancel');
  if (ans === 'cancel') return false;
  if (ans === 'end') {
    const h = runningHold(s);
    if (h) h.end = Date.now();
    s.ended = Date.now();
    sessionChanged(s);
  }
  return true;
}

// ── Crash recovery (this computer) ────────────────────────────────────
function saveRecovery(s) {
  if (!showPath) return;        // a show never saved can't be reopened to restore
  try { localStorage.setItem(RECOVERY_PREFIX + show.id, JSON.stringify({ report: s })); } catch (_) {}
}
function clearRecovery(id) {
  try { localStorage.removeItem(RECOVERY_PREFIX + (id || show.id)); } catch (_) {}
}
// After a save: the file has the times
function timingAfterSave() { clearRecovery(); }

// After opening a show: times this computer logged but never saved?
async function timingAfterOpen() {
  let rec = null;
  try { rec = JSON.parse(localStorage.getItem(RECOVERY_PREFIX + show.id) || 'null'); } catch (_) {}
  const r = rec && normalizeReport(rec.report);
  if (!r) { clearRecovery(); return; }
  const have = show.reports.find(x => x.id === r.id);
  if (have && have.updated >= r.updated) { clearRecovery(); return; }
  const ans = await ask('Restore unsaved session times?',
    `${sessionTitle(r)} · ${sessionDateText(r)} has times logged on this computer that were never saved to the show file ` +
    `(${r.events.length} milestone${r.events.length === 1 ? '' : 's'}, ${r.holds.length} hold${r.holds.length === 1 ? '' : 's'}` +
    `${r.ended ? '' : ', still running'}).`, [
    { label: 'Discard', value: false },
    { label: 'Restore', value: true, cls: 'mi-btn-go' }
  ], false);
  if (!ans) { clearRecovery(); return; }
  if (have) Object.assign(have, r);
  else {
    // Only one session runs at a time
    if (!r.ended && openSession()) r.ended = r.updated;
    show.reports.push(r);
  }
  markDirty();
  renderTiming();
  toast(`${sessionTitle(r)} restored · save to keep it`, 'ok');
}

// ── Timing box (calling column) ───────────────────────────────────────
function timingVisible() {
  return mode === 'show' && !(typeof linkRole !== 'undefined' && linkRole === 'client');
}

function stateText(s) {
  const h = runningHold(s);
  if (h) return { text: 'HOLD', since: h.start, cls: 'hold' };
  const st = sessionState(s);
  if (!st) return { text: 'READY', since: s.created, cls: '' };
  const m = /^(up|down)(\d)$/.exec(st.key);
  if (st.key === 'house') return { text: 'HOUSE OPEN', since: st.t, cls: '' };
  if (st.key === 'places') return { text: 'PLACES', since: st.t, cls: '' };
  if (m && m[1] === 'up') return { text: `ACT ${m[2]}`, since: st.t, cls: 'run' };
  if (m && +m[2] < s.acts) return { text: 'INTERMISSION', since: st.t, cls: 'int' };
  const sum = sessionSummary(s);
  return { text: 'SHOW DOWN', since: null, total: sum.total, cls: 'done' };
}

function summaryText(s) {
  const sum = sessionSummary(s);
  const parts = [];
  sum.acts.forEach((a, i) => {
    if (a.run !== null) parts.push(`Act ${a.n} ${fmtDur(a.run)}`);
    const im = sum.intermissions.find(x => x.after === a.n);
    if (im) parts.push(`Int ${fmtDur(im.len)}`);
  });
  if (sum.held > 0) parts.push(`Held ${fmtDur(sum.held)}`);
  return parts.join(' · ');
}

function renderTiming() {
  const box = document.getElementById('timing');
  if (!box) return;
  const vis = timingVisible();
  box.classList.toggle('hidden', !vis);
  if (!vis) return;
  const s = openSession();
  const next = document.getElementById('btnTmNext');
  const hold = document.getElementById('btnTmHold');
  const reason = document.getElementById('tmReason');
  const sess = document.getElementById('tmSession');
  const logBtn = document.getElementById('btnTmLog');
  box.classList.remove('hold', 'run', 'int', 'done');
  box.classList.toggle('idle', !s);
  if (!s) {
    const last = lastSession();
    sess.textContent = 'No session running.';
    logBtn.classList.toggle('hidden', !last);
    logBtn.textContent = show.reports.length > 1 ? 'All Sessions' : 'Last Session';
    logBtn.title = last ? `Session Log: ${sessionTitle(last)} · ${sessionDateText(last)}` +
      (show.reports.length > 1 ? `\nPick any of the ${show.reports.length} sessions at the top of the log` : '') : '';
    document.getElementById('tmState').textContent = '';
    document.getElementById('tmSum').textContent = '';      // no detail line while idle (Mike, 2026-10-18)
    next.textContent = 'Start Session';
    next.title = 'Start timing a rehearsal or performance';
    next.classList.remove('end');
    // Milestones are cues in this show: the first milestone GO starts the session
    next.classList.toggle('hidden', bookHasMilestones());
    sess.title = bookHasMilestones() ? 'The first milestone GO (House Open, Places, Act 1 Up…) starts a session' : '';
    hold.classList.add('hidden');
    reason.classList.add('hidden');
    tickTiming();
    return;
  }
  sess.textContent = `${sessionTitle(s)} · ${sessionDateText(s)}`;
  sess.title = '';
  logBtn.classList.remove('hidden');
  logBtn.textContent = 'Session Log';
  logBtn.title = 'Session Log: change times, add a moment, end the session' +
    (show.reports.length > 1 ? `\nOther sessions: pick at the top of the log` : '');
  const st = stateText(s);
  if (st.cls) box.classList.add(st.cls);
  document.getElementById('tmState').textContent = st.text;
  document.getElementById('tmSum').textContent = summaryText(s);
  const key = nextMilestone(s);
  next.textContent = key ? milestoneLabel(key) : 'End Session';
  next.title = key ? `Log ${milestoneLabel(key)} now` : 'All acts are down: end the session';
  next.classList.toggle('end', !key);
  next.classList.toggle('hidden', bookHasMilestones());      // milestones come from GO (timingOnGo)
  const h = runningHold(s);
  hold.classList.remove('hidden');
  hold.classList.toggle('on', !!h);
  hold.textContent = h ? 'End Hold' : 'Hold';
  hold.title = h ? 'End the hold' : 'Start a hold (time is kept apart from the run time)';
  reason.classList.toggle('hidden', !h);
  if (h && document.activeElement !== reason) reason.value = HOLD_REASONS.includes(h.reason) ? h.reason : (h.reason ? 'Other' : '');
  tickTiming();
}

// Every second: the running time in the box
function tickTiming() {
  const el = document.getElementById('tmElapsed');
  if (!el || !timingVisible()) return;
  const s = openSession();
  if (!s) { el.textContent = ''; return; }
  const st = stateText(s);
  el.textContent = st.since !== null ? fmtDur(Date.now() - st.since) : (st.total !== null && st.total !== undefined ? fmtDur(st.total) : '');
  // Held time grows during a hold
  if (runningHold(s)) document.getElementById('tmSum').textContent = summaryText(s);
}

// ── Session Log dialog ────────────────────────────────────────────────
function timingDialogIsOpen() { return tmDlgOpen; }

function openTimingDialog(id) {
  const s = (id && show.reports.find(r => r.id === id)) || openSession() || lastSession();
  if (!s) return;
  tmDlgId = s.id;
  tmDlgOpen = true;
  document.getElementById('tmOverlay').classList.add('open');
  renderTimingDialog();
}
function closeTimingDialog() {
  tmDlgOpen = false;
  tmDlgId = null;
  document.getElementById('tmOverlay').classList.remove('open');
}

function renderTimingDialog() {
  const s = show.reports.find(r => r.id === tmDlgId);
  const body = document.getElementById('tmBody');
  if (!s) { closeTimingDialog(); return; }
  // Keep focus and scroll across re-renders (a field being typed in isn't re-rendered: see onTmChange)
  const scroller = body.querySelector('.tm-scroll');
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const keys = milestoneKeys(s.acts);

  const evRows = sortedEvents(s).map(e => `
    <div class="tm-row" data-ev="${e.id}">
      <input class="mi-input tm-time" type="time" step="1" value="${timeValue(e.t)}" data-f="evTime">
      ${e.key === 'other'
        ? `<input class="mi-input tm-label" value="${esc(e.label)}" data-f="evLabel" placeholder="What happened">`
        : `<span class="tm-what">${esc(milestoneLabel(e.key))}</span>`}
      <button class="dp-btn tm-x" data-act="delEv" title="Delete">✕</button>
    </div>`).join('');

  const holdRows = s.holds.slice().sort((a, b) => a.start - b.start).map(h => `
    <div class="tm-row" data-hold="${h.id}">
      <input class="mi-input tm-time" type="time" step="1" value="${timeValue(h.start)}" data-f="holdStart" title="Hold started">
      <span class="tm-to">to</span>
      ${h.end === null
        ? `<span class="tm-what tm-running">running</span>`
        : `<input class="mi-input tm-time" type="time" step="1" value="${timeValue(h.end)}" data-f="holdEnd" title="Hold ended">`}
      <span class="tm-len">${fmtDur((h.end === null ? Date.now() : h.end) - h.start)}</span>
      <input class="mi-input tm-label" list="tmReasons" value="${esc(h.reason)}" data-f="holdReason" placeholder="Reason">
      <button class="dp-btn tm-x" data-act="delHold" title="Delete">✕</button>
    </div>`).join('');

  const used = new Set(s.events.map(e => e.key));
  const addOpts = keys.map(k => `<option value="${k}"${used.has(k) ? ' class="tm-used"' : ''}>${milestoneLabel(k)}${used.has(k) ? ' (logged)' : ''}</option>`).join('') +
    '<option value="other">Other…</option>';
  const firstFree = keys.find(k => !used.has(k)) || 'other';

  // Every session of this show, newest first
  const all = show.reports.slice().sort((a, b) => b.created - a.created);
  const pick = all.map(r => `<option value="${r.id}"${r.id === s.id ? ' selected' : ''}>` +
    `${esc(sessionTitle(r))} · ${esc(sessionDateText(r))}${r.ended ? (r.planned ? ' · planned' : '') : ' · running'}</option>`).join('');

  body.innerHTML = `
    <div class="tm-dlg-head">
      <div class="modal-msg">Session Log</div>
      <select class="mi-select tm-pick" id="tmPick" title="${all.length} session${all.length === 1 ? '' : 's'} in this show">${pick}</select>
      <div class="tm-status">${s.planned ? 'Planned (from MiKast)' : s.ended ? `Ended ${fmtTime(s.ended)}` : '<span class="tm-live">Running</span>'}</div>
    </div>
    <div class="tm-meta">
      <label>Kind <select class="mi-select" data-f="kind">${SESSION_KINDS.map(k => `<option${k === s.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
      <label>No. <input class="mi-input tm-num" type="number" min="1" max="999" value="${s.n}" data-f="n"></label>
      <label>Date <input class="mi-input" type="date" value="${s.date}" data-f="date"></label>
      <label>Acts <input class="mi-input tm-num" type="number" min="1" max="${MAX_ACTS}" value="${s.acts}" data-f="acts"></label>
    </div>
    <div class="tm-scroll mi-scroll">
      <div class="tm-sec">Milestones</div>
      ${evRows || '<div class="in-empty">Nothing logged yet</div>'}
      <div class="tm-row tm-add">
        <input class="mi-input tm-time" type="time" step="1" value="${timeValue(Date.now())}" id="tmAddTime">
        <select class="mi-select" id="tmAddKey">${addOpts}</select>
        <input class="mi-input tm-label${firstFree === 'other' ? '' : ' hidden'}" id="tmAddLabel" placeholder="What happened">
        <button class="mi-btn" data-act="addEv">Add</button>
      </div>
      <div class="tm-sec">Holds</div>
      ${holdRows || '<div class="in-empty">No holds</div>'}
      <div class="tm-row tm-add">
        <input class="mi-input tm-time" type="time" step="1" id="tmHoldStart" title="Hold started">
        <span class="tm-to">to</span>
        <input class="mi-input tm-time" type="time" step="1" id="tmHoldEnd" title="Hold ended">
        <button class="mi-btn" data-act="addHold">Add Hold</button>
      </div>
      <div class="tm-sec">Times</div>
      <div id="tmSumBox">${summaryHtml(s)}</div>
    </div>
    <div class="modal-btns">
      <button class="mi-btn mi-btn-exit" data-act="delete">Delete Session</button>
      <div class="tb-fill"></div>
      <button class="mi-btn" data-act="report" title="This session's report">Report</button>
      ${s.ended
        ? (openSession() ? '' : s.planned ? '<button class="mi-btn" data-act="reopen" title="Start timing this session now">Start</button>'
          : '<button class="mi-btn" data-act="reopen" title="Carry on timing this session">Reopen</button>')
        : '<button class="mi-btn" data-act="end">End Session</button>'}
      <button class="mi-btn mi-btn-go" data-act="close" style="padding:9px 18px">Close</button>
    </div>`;
  document.getElementById('tmAddKey').value = firstFree;
  const sc = body.querySelector('.tm-scroll');
  if (sc) sc.scrollTop = scrollTop;
}

// The Times part of the Session Log (and of the report)
function summaryHtml(s) {
  const sumLines = summaryLines(s);
  return sumLines.length
    ? sumLines.map(([k, v]) => `<div class="tm-sum-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')
    : '<div class="in-empty">No times yet</div>';
}

// [label, value] pairs: house, places, each act and intermission, totals
function summaryLines(s) {
  const sum = sessionSummary(s);
  const sumLines = [];
  if (sum.house !== null) sumLines.push(['House open', fmtTime(sum.house)]);
  if (sum.places !== null) sumLines.push(['Places', fmtTime(sum.places)]);
  sum.acts.forEach(a => {
    if (a.up === null && a.down === null) return;
    sumLines.push([`Act ${a.n}`, a.run !== null
      ? `${fmtTime(a.up)} – ${fmtTime(a.down)} · ${fmtDur(a.run)}${a.held ? ` (incl. ${fmtDur(a.held)} held)` : ''}`
      : `up ${fmtTime(a.up)} · not down yet`]);
    const im = sum.intermissions.find(x => x.after === a.n);
    if (im) sumLines.push(['Intermission', fmtDur(im.len)]);
  });
  if (sum.total !== null) sumLines.push(['Running time', fmtDur(sum.total)]);
  if (sum.held > 0) sumLines.push(['Held in all', fmtDur(sum.held)]);
  return sumLines;
}

function dlgSession() { return show.reports.find(r => r.id === tmDlgId) || null; }

async function onTmClick(e) {
  if (e.target === e.currentTarget) { closeTimingDialog(); return; }   // backdrop
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const s = dlgSession();
  if (!s) return;
  const act = b.dataset.act;
  if (act === 'close') { closeTimingDialog(); return; }
  if (act === 'report') {
    closeTimingDialog();
    if (typeof openReports === 'function') openReports(s.id);
    return;
  }
  if (act === 'delEv') {
    const id = b.closest('[data-ev]').dataset.ev;
    s.events = s.events.filter(x => x.id !== id);
    sessionChanged(s);
  } else if (act === 'delHold') {
    const id = b.closest('[data-hold]').dataset.hold;
    s.holds = s.holds.filter(x => x.id !== id);
    sessionChanged(s);
  } else if (act === 'addEv') {
    const key = document.getElementById('tmAddKey').value;
    const label = document.getElementById('tmAddLabel').value.trim();
    const t = parseTimeOn(document.getElementById('tmAddTime').value, dayBase(s));
    if (t === null) { toast('Enter a time.', 'err'); return; }
    if (key === 'other' && !label) { toast('Say what happened.', 'err'); document.getElementById('tmAddLabel').focus(); return; }
    s.events.push({ id: uid(), key, label: key === 'other' ? label : '', t: afterMidnight(s, t) });
    sessionChanged(s);
  } else if (act === 'addHold') {
    const a = parseTimeOn(document.getElementById('tmHoldStart').value, dayBase(s));
    const z = parseTimeOn(document.getElementById('tmHoldEnd').value, dayBase(s));
    if (a === null || z === null) { toast('Enter when the hold started and ended.', 'err'); return; }
    const start = afterMidnight(s, a);
    let end = afterMidnight(s, z);
    if (end < start) end += 86400000;
    s.holds.push({ id: uid(), start, end, reason: '' });
    sessionChanged(s);
  } else if (act === 'end') {
    await endSessionCmd(s);
  } else if (act === 'reopen') {
    if (openSession()) return;
    s.ended = null;
    sessionChanged(s);
  } else if (act === 'delete') {
    const ok = await ask(`Delete ${sessionTitle(s)}?`, `${sessionDateText(s)}: its times${Object.keys(s.fields || {}).length ? ' and report' : ''} are removed from the show.`, [
      { label: 'Cancel', value: false },
      { label: 'Delete', value: true, cls: 'mi-btn-exit' }
    ], false);
    if (!ok) return;
    if (s.call && typeof mikastDismiss === 'function') mikastDismiss(s.call);   // a MiKast call's session stays deleted
    show.reports = show.reports.filter(r => r.id !== s.id);
    clearRecovery();
    markDirty();
    closeTimingDialog();
    renderTiming();
    if (typeof reportsRefresh === 'function') reportsRefresh();
  }
}

// The calendar day new times go on: the session's date (local midnight)
function dayBase(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}
// A time well before the session started belongs to the next day (shows past midnight)
function afterMidnight(s, t) {
  const first = Math.min(s.created, ...s.events.map(e => e.t));
  return t < first - 6 * 3600000 ? t + 86400000 : t;
}

function onTmChange(e) {
  const s = dlgSession();
  if (!s) return;
  const el = e.target;
  const f = el.dataset.f;
  if (el.id === 'tmPick') {
    if (show.reports.some(r => r.id === el.value)) { tmDlgId = el.value; renderTimingDialog(); }
    return;
  }
  if (el.id === 'tmAddKey') {
    document.getElementById('tmAddLabel').classList.toggle('hidden', el.value !== 'other');
    return;
  }
  if (!f) return;
  if (f === 'kind') {
    if (!SESSION_KINDS.includes(el.value)) return;
    // Today's MiKast call of this kind: offer to move the session onto it (mikast-link.js)
    if (typeof offerMoveToCall === 'function' && !s.planned) {
      const kind = el.value;
      offerMoveToCall(s, kind).then(ans => {
        if (ans === 'moved') return;
        if (ans === 'cancel') { el.value = s.kind; return; }
        s.kind = kind;
        sessionChanged(s);
      });
      return;
    }
    s.kind = el.value;
  }
  else if (f === 'n') { const n = Math.round(Number(el.value)); if (n >= 1 && n <= 999) s.n = n; else { el.value = s.n; return; } }
  else if (f === 'date') { if (/^\d{4}-\d{2}-\d{2}$/.test(el.value)) s.date = el.value; else { el.value = s.date; return; } }
  else if (f === 'acts') {
    const n = Math.round(Number(el.value));
    if (!(n >= 1 && n <= MAX_ACTS)) { el.value = s.acts; return; }
    const lost = s.events.filter(x => { const m = /^(up|down)(\d)$/.exec(x.key); return m && +m[2] > n; });
    if (lost.length) { toast(`Delete the Act ${n + 1}+ times first.`, 'err'); el.value = s.acts; return; }
    s.acts = n;
    // New sessions start with the same number of acts
    if (show.timing.acts !== n) show.timing.acts = n;
  }
  else if (f === 'evTime') {
    const ev = s.events.find(x => x.id === el.closest('[data-ev]').dataset.ev);
    const t = ev && parseTimeOn(el.value, ev.t);
    if (t === null) { if (ev) el.value = timeValue(ev.t); return; }
    ev.t = t;
  }
  else if (f === 'evLabel') {
    const ev = s.events.find(x => x.id === el.closest('[data-ev]').dataset.ev);
    if (!ev) return;
    ev.label = el.value.trim() || 'Other';
  }
  else if (f === 'holdStart' || f === 'holdEnd') {
    const h = s.holds.find(x => x.id === el.closest('[data-hold]').dataset.hold);
    if (!h) return;
    const base = f === 'holdStart' ? h.start : h.end;
    const t = parseTimeOn(el.value, base);
    if (t === null) { el.value = timeValue(base); return; }
    const start = f === 'holdStart' ? t : h.start, end = f === 'holdEnd' ? t : h.end;
    if (end !== null && end < start) { toast('A hold can’t end before it starts.', 'err'); el.value = timeValue(base); return; }
    if (f === 'holdStart') h.start = t; else h.end = t;
    const len = el.closest('[data-hold]').querySelector('.tm-len');
    if (len) len.textContent = fmtDur((h.end === null ? Date.now() : h.end) - h.start);
  }
  else if (f === 'holdReason') {
    const h = s.holds.find(x => x.id === el.closest('[data-hold]').dataset.hold);
    if (!h) return;
    h.reason = el.value.trim();
  }
  // Acts changes the milestone list: redraw it all. Anything else: just the Times.
  sessionChanged(s, f !== 'acts');
}

function timingDialogKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); closeTimingDialog(); return; }
  // Enter in a field commits it (change event) without submitting anything else
  if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('input')) {
    e.preventDefault();
    if (e.target.id === 'tmAddLabel' || e.target.id === 'tmAddTime') {
      const b = document.querySelector('#tmBody [data-act="addEv"]');
      if (b) b.click();
    } else {
      e.target.blur();
    }
  }
}

// ── Wiring ────────────────────────────────────────────────────────────
function initTiming() {
  document.getElementById('btnTmNext').addEventListener('click', nextCmd);
  document.getElementById('btnTmHold').addEventListener('click', holdCmd);
  document.getElementById('btnTmLog').addEventListener('click', () => openTimingDialog());
  const reason = document.getElementById('tmReason');
  reason.innerHTML = '<option value="">Reason…</option>' + HOLD_REASONS.map(r => `<option>${r}</option>`).join('');
  reason.addEventListener('change', () => {
    const s = openSession();
    const h = s && runningHold(s);
    if (h) { h.reason = reason.value; sessionChanged(s); }
    reason.blur();          // Space means GO again
  });
  const ov = document.getElementById('tmOverlay');
  ov.addEventListener('click', onTmClick);
  ov.addEventListener('change', onTmChange);
  document.getElementById('tmReasons').innerHTML = HOLD_REASONS.map(r => `<option value="${r}">`).join('');
  setInterval(() => {
    tickTiming();
    // A running hold's length in the open Session Log
    if (tmDlgOpen) {
      const s = dlgSession();
      if (s && runningHold(s)) {
        const el = document.querySelector('#tmBody [data-hold] .tm-running');
        const row = el && el.closest('[data-hold]');
        const h = row && s.holds.find(x => x.id === row.dataset.hold);
        if (h) row.querySelector('.tm-len').textContent = fmtDur(Date.now() - h.start);
      }
    }
  }, 1000);
  renderTiming();
}
