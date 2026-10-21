'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: driving MiKonsole and MiKue (Phase 2)
   With DRIVE armed and MiKallbook in Show mode, GO fires the GO point's
   cues in the linked apps (a department's Link in the Departments panel):

     MiKonsole  goToCue(idx) through its phone-remote relay
                (localhost:8080, POST /push/remote). The cue number is
                looked up in MiKonsole's live list at the moment of GO, so
                cues inserted in MiKonsole never shift what "LX 12" means.
     MiKue      POST 127.0.0.1:8090/command { cmd:'goto', number }

   Combo cues (via: 'micue') are never sent: MiKue fires that lighting
   cue itself. All of a GO point's cues are sent at the same moment.

   Back sends MiKonsole's Back (cueBack) when the GO point being stepped
   back over had changed the lights (its LX cue was sent, or MiKue fired
   it as a combo cue), and stops the MiKue cues that GO point started
   ({cmd:'stop', number}: the cue plus its Continue/Follow chain, 1 s fade;
   MiKue 2026-10-18 on). Sounds started by earlier GO points keep playing.

   While driving, MiKue's standby follows MiKallbook's: the next SQ cue
   from the calling position on.

   Never drives: in Edit or Operator mode, with DRIVE off, or on an
   operator's computer that follows the SM (link.js). A cue that can't be
   sent never stops the show: MiKallbook moves on and says what wasn't sent.

   Uses app.js / marks.js / calling.js / cuelists.js / link.js globals.
   ════════════════════════════════════════════════════════════════════ */

const DRIVE_KEY = 'micallbook.drive';
const SEND_TIMEOUT_MS = 1500;

let driveArmed = false;
try { driveArmed = localStorage.getItem(DRIVE_KEY) === '1'; } catch (_) {}
let lastMicueStandby = null;      // what MiKue's standby was last set to
// GO points whose lighting cue really changed MiKonsole (sent, or fired by
// MiKue for a combo cue): only those get MiKonsole's Back
const lxFired = new Set();
// GO point id -> the MiKue cue numbers it really started (for Back)
const sqFired = new Map();

function driveActive() {
  return driveArmed && mode === 'show' && !(typeof linkRole !== 'undefined' && linkRole === 'client');
}

// ── Sending ───────────────────────────────────────────────────────────
async function postJson(url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal, cache: 'no-store'
    });
    let j = null;
    try { j = await r.json(); } catch (_) {}
    return { ok: r.ok && (!j || j.ok !== false), status: r.status, json: j };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'no answer' : 'not reachable' };
  } finally {
    clearTimeout(t);
  }
}

// MiKonsole only takes commands while its Phone Remote is on Connect; the
// relay would otherwise hold them (and drop them after 2 s)
function mkReady() {
  if (live.mikonsole.status === 'linked') return null;
  return live.mikonsole.status === 'relay' ? 'MiKonsole’s Phone Remote isn’t connected' : 'MiKonsole isn’t running';
}

async function sendMiKonsoleCue(c) {
  const why = mkReady();
  if (why) return why;
  if (!live.mikonsole.hasNums) return 'this MiKonsole is an older version (no cue numbers)';
  const hit = live.mikonsole.cues.find(x => x.num !== null && sameNum(x.num, c.number));
  if (!hit) return `not in MiKonsole’s cue list`;
  const r = await postJson(`${MK_URL}/push/remote`, { cmd: 'goToCue', idx: hit.idx });
  return r.ok ? null : 'MiKonsole’s relay didn’t take it';
}

async function sendMiCueCue(c) {
  const r = await postJson(`${MC_URL}/command`, { cmd: 'goto', number: String(c.number) });
  if (r.ok) return null;
  if (r.json && r.json.error) return r.json.error.replace(/\.$/, '');
  return r.error === 'not reachable' ? 'MiKue isn’t running on this computer' : 'MiKue didn’t answer';
}

// The cues of a GO point that are driven, with their app
function drivenCues(gp) {
  return gp.cues.filter(c => !c.via).map(c => ({ c, target: deptTarget(c.dept) }))
    .filter(x => x.target === 'mikonsole' || x.target === 'micue');
}

// ── GO / Back / Standby ───────────────────────────────────────────────
// Called by calling.js go() with the GO point just called
async function driveGo(gp) {
  if (!driveActive() || !gp) return;
  const list = drivenCues(gp);
  if (!list.length) { lxFired.delete(gp.id); sqFired.delete(gp.id); syncMicueStandby(); return; }
  const results = await Promise.all(list.map(x =>
    (x.target === 'mikonsole' ? sendMiKonsoleCue(x.c) : sendMiCueCue(x.c)).then(err => ({ x, err }))));
  const failed = results.filter(r => r.err);
  if (failed.length) driveFailed(failed.map(r => `${cueText(r.x.c)}: ${r.err}`));
  const ok = results.filter(r => !r.err).map(r => r.x);
  const lxSent = ok.some(x => x.target === 'mikonsole') ||
    // a combo cue: MiKue fired the light, if its SQ cue went out
    gp.cues.some(c => c.via && deptTarget(c.dept) === 'mikonsole' && ok.some(x => x.target === 'micue' && comboKey(x.c) === c.of));
  if (lxSent) lxFired.add(gp.id); else lxFired.delete(gp.id);
  const sq = ok.filter(x => x.target === 'micue').map(x => String(x.c.number));
  if (sq.length) sqFired.set(gp.id, sq); else sqFired.delete(gp.id);
  // After MiKue's own GO has moved its standby, put it where MiKallbook's is
  lastMicueStandby = null;
  syncMicueStandby();
}

// Called by calling.js back() with the GO point that becomes Standby again
async function driveBack(gp) {
  if (!driveActive() || !gp) return;
  // Only when this GO point's light actually changed (not if it failed, or
  // was called with DRIVE off)
  if (lxFired.has(gp.id)) {
    lxFired.delete(gp.id);
    const why = mkReady();
    const r = why ? null : await postJson(`${MK_URL}/push/remote`, { cmd: 'cueBack' });
    if (why || !r.ok) driveFailed([`MiKonsole Back: ${why || 'MiKonsole’s relay didn’t take it'}`]);
  }
  // Stop the sounds this GO point started (and what they set off through
  // Continue / Follow). Sounds started earlier keep playing.
  const sq = sqFired.get(gp.id);
  if (sq) {
    sqFired.delete(gp.id);
    const fails = [];
    for (const n of sq) {
      const r = await postJson(`${MC_URL}/command`, { cmd: 'stop', number: n });
      if (!r.ok) {
        const e = r.json && r.json.error ? r.json.error : r.error === 'not reachable' ? 'MiKue isn’t running' : 'MiKue didn’t answer';
        fails.push(`MiKue stop SQ ${n}: ${/Unknown command/i.test(e) ? 'this MiKue is an older version (no stop)' : e.replace(/\.$/, '')}`);
      }
    }
    if (fails.length) driveFailed(fails);
  }
  lastMicueStandby = null;          // a stopped cue: put MiKue's standby back on it
  syncMicueStandby();
}

// MiKue's standby = the first SQ cue from MiKallbook's Standby on
async function syncMicueStandby() {
  if (!driveActive() || live.micue.status !== 'on') return;
  const list = callList();
  const si = atEnd ? list.length : standbyIndex();
  let num = null;
  for (let k = Math.max(0, si); k < list.length && num === null; k++) {
    const c = list[k].cues.find(c => !c.via && deptTarget(c.dept) === 'micue');
    if (c) num = String(c.number);
  }
  if (num === null || num === lastMicueStandby) return;
  lastMicueStandby = num;
  const r = await postJson(`${MC_URL}/command`, { cmd: 'standby', number: num });
  if (!r.ok) lastMicueStandby = null;          // try again next time
}

// ── Feedback ──────────────────────────────────────────────────────────
function driveFailed(lines) {
  const btn = document.getElementById('btnGo');
  btn.classList.add('drive-fail');
  setTimeout(() => btn.classList.remove('drive-fail'), 1200);
  toast('Not sent · ' + lines.join(' · '), 'err');
}

// The DRIVE switch, the Show mode banner, and what each linked app will get
function renderDrive() {
  const b = document.getElementById('btnDrive');
  if (!b) return;
  const following = typeof linkRole !== 'undefined' && linkRole === 'client';
  b.classList.toggle('on', driveArmed);
  b.disabled = following;
  b.textContent = driveArmed ? 'DRIVE ON' : 'DRIVE OFF';
  const targets = [...new Set(show.departments.filter(d => d.target === 'mikonsole' || d.target === 'micue')
    .map(d => `${d.code} → ${APP_NAME[d.target]}`))];
  b.title = following ? 'This computer follows the SM: it never drives the other apps'
    : (driveArmed ? 'GO fires the cues in the linked apps (Show mode). Click to turn off.'
                  : 'Off: GO only moves the calling position. Click to have GO fire the linked apps in Show mode.') +
      (targets.length ? '\n' + targets.join('\n') : '\nNo department is linked to MiKonsole or MiKue (Departments panel)');
  const apps = linkedApps().join(' + ');
  const lock = document.getElementById('showLock');
  // Show mode, linked apps, not following the SM, DRIVE off: say so plainly
  const driveOff = mode === 'show' && !driveArmed && !following && !!apps;
  if (lock) lock.textContent = driveActive() ? `SHOW MODE · editing locked · GO DRIVES ${apps || 'nothing linked'}`
    : driveOff ? `SHOW MODE · editing locked · DRIVE OFF · GO doesn't fire ${apps}`
    : 'SHOW MODE · editing locked';
  document.body.classList.toggle('driving', driveActive());
  document.body.classList.toggle('drive-off', driveOff);
}

// The apps this show's departments are linked to: ['MiKonsole', 'MiKue']
function linkedApps() {
  return ['mikonsole', 'micue'].filter(t => show.departments.some(d => d.target === t)).map(t => APP_NAME[t]);
}

// The Show button. Only on a fresh start (Standby on GO 1, nothing called,
// no session running: Mike, 2026-10-18) it asks whether GO should drive
// MiKonsole / MiKue, and, in a show with milestone cues, which kind of
// session the first milestone GO starts. Back into Show mode mid-show
// (from Operator or Edit) goes straight in with the same choice.
// A computer that follows the SM is never asked.
async function enterShowMode() {
  if (mode === 'show' || modalOpen()) return;       // another question is open: answer that first
  const following = typeof linkRole !== 'undefined' && linkRole === 'client';
  ensureStandby();
  const midShow = atEnd || standbyIndex() > 0 || stepK > 0 || (typeof openSession === 'function' && !!openSession());
  const apps = linkedApps();
  const ms = typeof bookHasMilestones === 'function' && bookHasMilestones();
  if (following || midShow || (!apps.length && !ms)) { setMode('show'); return; }

  const which = apps.join(' and ');
  let detail = apps.length
    ? `Drive: GO fires the cues in ${which} (${show.departments.filter(d => d.target === 'mikonsole' || d.target === 'micue').map(d => d.code).join(', ')}).\n` +
      `Call Only: GO just moves the calling position; operators press their own GO.\n\n` +
      `The DRIVE button next to Back changes it during the show.`
    : '';
  let extra = null, kindSel = null;
  if (ms) {
    detail += (detail ? '\n\n' : '') + 'The first milestone GO starts the session; the last act’s Down ends it.';
    extra = document.createElement('label');
    extra.className = 'modal-field';
    extra.append('Session ');
    kindSel = document.createElement('select');
    kindSel.className = 'mi-select';
    const k0 = autoSessionKind();
    // Today's MiKast calls by name first (mikast-link.js), then the plain kinds
    const calls = typeof todaysPlannedChoices === 'function' ? todaysPlannedChoices() : [];
    const kinds = SESSION_KINDS.map(k => `<option value="${k}"${k === k0 ? ' selected' : ''}>${k}</option>`).join('');
    kindSel.innerHTML = calls.length
      ? `<optgroup label="Today’s calls from MiKast">${calls.map(c => `<option value="${esc(c.value)}"${c.value === k0 ? ' selected' : ''}>${esc(c.label)}</option>`).join('')}</optgroup>` +
        `<optgroup label="Not a MiKast call">${kinds}</optgroup>`
      : kinds;
    // after picking, Enter means the default button again
    kindSel.addEventListener('change', () => { const b = document.querySelector('#modalBtns button:last-child'); if (b) b.focus(); });
    extra.appendChild(kindSel);
  }
  const ans = await ask(apps.length ? `Drive ${which}?` : 'Start the show', detail, apps.length ? [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Call Only', value: 'call' },
    { label: 'Drive', value: 'drive', cls: 'mi-btn-go' }
  ] : [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Show Mode', value: 'show', cls: 'mi-btn-go' }
  ], 'cancel', extra);
  if (ans === 'cancel') return;
  if (apps.length) setDrive(ans === 'drive');
  if (kindSel) sessionKindPick = kindSel.value;
  setMode('show');
}

function setDrive(on) {
  driveArmed = !!on;
  try { localStorage.setItem(DRIVE_KEY, driveArmed ? '1' : '0'); } catch (_) {}
  lastMicueStandby = null;
  renderDrive();
  if (driveArmed) syncMicueStandby();
}

function initDrive() {
  document.getElementById('btnDrive').addEventListener('click', () => setDrive(!driveArmed));
  renderDrive();
}
