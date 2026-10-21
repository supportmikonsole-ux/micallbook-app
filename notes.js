'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: rehearsal notes from phones and laptops (Phase 3b+)
   While this computer shares the show (Link → Start Sharing, or "Take
   Notes from Phones" in the Reports window), directors, choreographers,
   music directors… open http://<this computer>:<port>/notes in any browser
   on the booth network, with the 4-digit code, and send notes. Each note
   goes straight into a field of the current report:

     "<cue> · <name> (<role>): <note>"        (the cue only when given)

   The current report = the running session, else the latest session dated
   today, else a new untimed Rehearsal report (made on the first note).

   The page's list of fields = the template's several-lines fields. Its "Last: LX 12" button offers the GO point called last.

   Uses app.js / timing.js / reports.js / link.js / calling.js globals.
   ════════════════════════════════════════════════════════════════════ */

const NOTES_PATH = '/notes';
let notesCtxSent = '';
let notesTaken = 0;          // notes received since MiKallbook started

// The several-lines fields (department notes, General, Cast…); one-line ones
// like Stage manager aren't offered. A template with none offers its one-line fields.
function noteFields() {
  const text = reportFields().filter(f => f.type === 'text');
  return text.length ? text : reportFields().filter(f => f.type === 'line');
}

// The report notes go to; make = create one when there is none (first note)
function noteTarget(make) {
  const s = openSession();
  if (s) return s;
  const today = localDate(Date.now());
  const t = sortedSessions().find(r => r.date === today) ||
    (typeof comingUp === 'function' ? comingUp().find(r => r.date === today) : null);   // today's planned session (MiKast)
  if (t) return t;
  if (!make) return null;
  const n = createSession('Rehearsal', true);
  toast(`${sessionTitle(n)} report started for notes`, 'ok');
  return n;
}

// The GO point called last (what a note most likely means), as "LX 12 · SQ 4"
function lastCalledText() {
  const list = callList();
  const si = atEnd ? list.length : standbyIndex();
  const gp = si > 0 ? list[si - 1] : null;
  if (!gp || !gp.cues.length) return '';
  return displayCues(gp).map(x => cueText(x.c)).join(' · ');
}

function notesContext() {
  const t = noteTarget(false);
  const kind = SESSION_KINDS.includes('Rehearsal') ? 'Rehearsal' : SESSION_KINDS[0];
  const nextN = show.reports.filter(r => r.kind === kind).reduce((m, r) => Math.max(m, r.n), 0) + 1;
  return {
    show: show.name || 'Untitled Show',
    target: t ? `${sessionTitle(t)} · ${sessionDateText(t)}` : `${kind} ${nextN} (new)`,
    fields: noteFields().map(f => ({ id: f.id, label: f.label })),
    cue: lastCalledText()
  };
}

// Sent to the sharing server once a second when something changed
function pushNotesContext() {
  if (typeof linkRole === 'undefined' || linkRole !== 'host') { notesCtxSent = ''; return; }
  let text;
  try { text = JSON.stringify(notesContext()); } catch (_) { return; }
  if (text === notesCtxSent) return;
  notesCtxSent = text;
  if (bridge.notes) bridge.notes.context(JSON.parse(text));
}

// The note's line in the report field
function noteLine(n) {
  const who = n.name + (n.role ? ` (${n.role})` : '');
  return `${n.cue ? n.cue + ' · ' : ''}${who}: ${n.text}`;
}

function onNoteIncoming(n) {
  if (!n || !n.text) return;
  if (typeof linkRole === 'undefined' || linkRole !== 'host') return;     // only while sharing
  const fields = noteFields();
  let f = fields.find(x => x.id === n.field);
  if (!f) f = fields.find(x => /^general/i.test(x.label)) || fields.find(x => x.type === 'text') || fields[0];
  if (!f) { toast(`Note from ${n.name} couldn’t go anywhere: the report template has no text fields`, 'err'); return; }
  const s = noteTarget(true);
  if (!s.fields || typeof s.fields !== 'object') s.fields = {};
  const line = noteLine(n);
  const had = String(s.fields[f.id] || '');
  s.fields[f.id] = had.trim() ? had.replace(/\s+$/, '') + '\n' + line : line;
  s.updated = Date.now();
  markDirty();
  saveRecovery(s);
  notesTaken++;

  // The Reports window showing this report: put the line in the box too
  if (rpOpen && rpId === s.id && rpMode === 'report') {
    const box = document.querySelector(`#rpBody [data-fid="${f.id}"]`);
    if (box) {
      const focused = document.activeElement === box;
      const a = box.selectionStart, b = box.selectionEnd;
      box.value = s.fields[f.id];
      if (focused) { try { box.setSelectionRange(a, b); } catch (_) {} }
      if (box.tagName === 'TEXTAREA') autoGrow(box);
      box.classList.add('rp-flash');
      setTimeout(() => box.classList.remove('rp-flash'), 1200);
    }
  }
  if (rpOpen) { renderReportList(); renderNotesStrip(); }
  toast(`Note from ${n.name} → ${f.label}`, 'ok');
  pushNotesContext();
}

// ── The strip in the Reports window ───────────────────────────────────
function notesUrls() {
  if (typeof linkRole === 'undefined' || linkRole !== 'host' || !hostInfo) return [];
  return (hostInfo.addresses || []).map(a => `http://${a.address}:${hostInfo.port}${NOTES_PATH}`);
}

function qrSvg(text) {
  try {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
  } catch (err) { console.error('[notes] QR failed:', err); return ''; }
}

let notesStripSig = '';
function renderNotesStrip(force) {
  const el = document.getElementById('rpNotes');
  if (!el) return;
  const following = typeof linkRole !== 'undefined' && linkRole === 'client';
  const urls = notesUrls();
  const code = hostInfo && hostInfo.code;
  const sig = JSON.stringify([following, urls, code, notesTaken]);
  if (!force && sig === notesStripSig && el.childElementCount) return;
  notesStripSig = sig;
  if (following) { el.innerHTML = ''; return; }
  if (!urls.length) {
    el.innerHTML = (typeof linkRole !== 'undefined' && linkRole === 'host')
      ? '<div class="rp-notes-t">Notes from phones</div><div class="rp-notes-h">This computer has no network address. Connect it to the booth network.</div>'
      : `<div class="rp-notes-t">Notes from phones</div>
         <div class="rp-notes-h">Directors, choreographers and MDs send notes into this report from their own phones or laptops on the booth network.</div>
         <button class="mi-btn rp-notes-go" data-act="notesOn">Take Notes from Phones</button>`;
    return;
  }
  const full = `${urls[0]}?code=${code}`;
  el.innerHTML = `
    <div class="rp-notes-t">Notes from phones${notesTaken ? ` · ${notesTaken} received` : ''}</div>
    <div class="rp-qr" title="Scan with a phone camera">${qrSvg(full)}</div>
    <div class="rp-notes-url">${urls.map(u => esc(u)).join('<br>')}</div>
    <div class="rp-notes-code">Code <b>${esc(code)}</b></div>
    <div class="rp-notes-h">Same network as this computer. The code is also the operators’ Link code.</div>`;
}

async function notesOnCmd() {
  if (typeof linkRole !== 'undefined' && linkRole === 'host') return;
  await startSharing();                       // link.js: also lets operators follow
  if (linkRole !== 'host') { toast(linkError || 'Could not start sharing.', 'err'); return; }
  pushNotesContext();
  renderNotesStrip(true);
  renderNotesQr(true);
}

// ── Utilities › Notes from Phones (Mike, 2026-10-18) ──────────────────
// The QR code on its own, large, so the team can scan it from the SM's
// screen at any time (no session or Reports window needed). Starts sharing
// if this computer isn't sharing yet. Not on a computer that follows the SM.
let ntOpen = false;
let ntSig = '';
function notesQrDialogIsOpen() { return ntOpen; }
function openNotesQr() {
  if (typeof linkRole !== 'undefined' && linkRole === 'client') { toast('This computer follows the SM: notes go to the SM’s computer.', 'err'); return; }
  ntOpen = true;
  document.getElementById('ntOverlay').classList.add('open');
  renderNotesQr(true);
}
function closeNotesQr() {
  ntOpen = false;
  document.getElementById('ntOverlay').classList.remove('open');
}
function renderNotesQr(force) {
  if (!ntOpen) return;
  const el = document.getElementById('ntBody');
  const host = typeof linkRole !== 'undefined' && linkRole === 'host';
  const urls = notesUrls();
  const code = hostInfo && hostInfo.code;
  const t = noteTarget(false);
  const target = t ? `${sessionTitle(t)} · ${sessionDateText(t)}` : 'a new Rehearsal report (made with the first note)';
  const sig = JSON.stringify([host, urls, code, notesTaken, target]);
  if (!force && sig === ntSig) return;
  ntSig = sig;
  const foot = `<div class="modal-btns"><div class="tb-fill"></div><button class="mi-btn mi-btn-go" data-act="close" style="padding:9px 18px">Close</button></div>`;
  if (!host) {
    el.innerHTML = `
      <div class="modal-msg">Notes from Phones</div>
      <div class="nt-help">Directors, choreographers and music directors send notes into tonight’s report from their own phones, tablets or laptops on the booth network. Start sharing to show the QR code they scan.</div>
      <div class="modal-btns"><div class="tb-fill"></div>
        <button class="mi-btn" data-act="close">Cancel</button>
        <button class="mi-btn mi-btn-go" data-act="start" style="padding:9px 18px">Start Sharing</button></div>`;
    return;
  }
  if (!urls.length) {
    el.innerHTML = `<div class="modal-msg">Notes from Phones</div>
      <div class="nt-help">This computer has no network address. Connect it to the booth network (Wi-Fi or cable), then open this again.</div>${foot}`;
    return;
  }
  el.innerHTML = `
    <div class="modal-msg">Notes from Phones${notesTaken ? ` <span class="nt-count">· ${notesTaken} received</span>` : ''}</div>
    <div class="nt-main">
      <div class="nt-qr" title="Scan with a phone or tablet camera">${qrSvg(`${urls[0]}?code=${code}`)}</div>
      <div class="nt-side">
        <div class="nt-step">Scan with the camera, or open in a browser:</div>
        <div class="nt-url">${urls.map(u => esc(u)).join('<br>')}</div>
        <div class="nt-code">Code <b>${esc(code)}</b></div>
        <div class="nt-help">Same Wi-Fi / network as this computer. Notes go to <b>${esc(target)}</b>.</div>
        <div class="nt-help">The code is also the operators’ Link code.</div>
      </div>
    </div>${foot}`;
}
function notesQrDialogKey(e) {
  if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); closeNotesQr(); }
}

function initNotes() {
  if (bridge.notes) bridge.notes.onIncoming(onNoteIncoming);
  setInterval(() => { pushNotesContext(); if (rpOpen) renderNotesStrip(); renderNotesQr(); }, 1000);
  document.getElementById('miNotes').addEventListener('click', () => openNotesQr());
  const ov = document.getElementById('ntOverlay');
  ov.addEventListener('click', async e => {
    if (e.target === ov) { closeNotesQr(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'close') closeNotesQr();
    else if (b.dataset.act === 'start') await notesOnCmd();
  });
}
