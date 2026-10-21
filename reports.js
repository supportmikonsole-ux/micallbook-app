'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: rehearsal and performance reports (Phase 3b)
   Every session (timing.js) has a report: its times from the show clock,
   then the fields of the show's report template (show.reportFields),
   filled in by the SM. The Reports window lists the show's sessions
   (newest first), edits the selected report, edits the template, and
   exports a report as a PDF into <Show>/reports/ or prints it.

   Template field: { id, label, type: 'line'|'text'|'number'|'time'|'yesno', carry }
   (time = "HH:MM", 24 h, shown in this computer's clock format)
   carry: a new session starts with the previous report's value.
   Values: session.fields[fieldId] = string.

   Hidden in Operator mode and on a computer that follows the SM.
   Uses app.js / timing.js globals (show, showPath, markDirty, ask, toast,
   uid, esc, sessionTitle, sessionSummary, summaryLines, …).
   ════════════════════════════════════════════════════════════════════ */

const FIELD_TYPES = [
  ['line', 'One line'], ['text', 'Several lines'], ['number', 'Number'], ['time', 'Time'], ['yesno', 'Yes / No']
];
const FIELD_TYPE_KEYS = FIELD_TYPES.map(t => t[0]);

let rpOpen = false;
let rpId = null;             // the session whose report is shown
let rpMode = 'report';       // 'report' | 'template'
let rpRecTimer = 0;

// ── Template ──────────────────────────────────────────────────────────
function normalizeReportFields(raw) {
  if (!Array.isArray(raw)) return null;           // null = not set up yet (suggested on first use)
  return raw.filter(f => f && typeof f === 'object').map(f => ({
    id: typeof f.id === 'string' && f.id ? f.id : uid(),
    label: String(f.label || '').trim() || 'Field',
    type: FIELD_TYPE_KEYS.includes(f.type) ? f.type : 'text',
    carry: !!f.carry
  }));
}

function suggestedFields() {
  const f = (label, type, carry) => ({ id: uid(), label, type, carry: !!carry });
  return [
    f('Stage manager', 'line', true),
    f('Call time', 'time', true),
    f('House count', 'number'),
    f('Absent / late', 'line'),
    f('Called', 'line'),
    f('General', 'text'),
    ...show.departments.map(d => f(d.name ? `${d.name} (${d.code})` : d.code, 'text')),
    f('Scenic & props', 'text'),
    f('Costumes, hair & makeup', 'text'),
    f('Cast', 'text'),
    f('Front of house', 'text'),
    f('Injuries & safety', 'text'),
    f('Next call', 'line', true)
  ];
}

// The template, set up with the suggested fields the first time it's needed
function reportFields() {
  // Not marked as a change: opening Reports alone shouldn't ask to save. It's saved with the next change.
  if (!Array.isArray(show.reportFields)) show.reportFields = suggestedFields();
  return show.reportFields;
}

// New session: carried fields start with the latest earlier report's value.
// emptyOnly: a planned session (MiKast) being started keeps what is already in it.
function reportCarryForward(s, emptyOnly) {
  if (!Array.isArray(show.reportFields)) return;
  const earlier = show.reports.filter(r => !r.planned).sort((a, b) => b.created - a.created);
  for (const f of show.reportFields) {
    if (!f.carry) continue;
    if (emptyOnly && String((s.fields || {})[f.id] || '').trim()) continue;
    const prev = earlier.find(r => r.id !== s.id && r.fields && String(r.fields[f.id] || '').trim());
    if (prev) s.fields[f.id] = prev.fields[f.id];
  }
}

function filledCount(s) {
  return reportFields().filter(f => String((s.fields || {})[f.id] || '').trim()).length;
}

// ── Opening / closing ─────────────────────────────────────────────────
function reportsDialogIsOpen() { return rpOpen; }

function reportsAvailable() {
  return mode !== 'operator' && !(typeof linkRole !== 'undefined' && linkRole === 'client');
}

function renderReportsButton() {
  const b = document.getElementById('btnReports');
  if (b) b.classList.toggle('hidden', !reportsAvailable());
  if (rpOpen && !reportsAvailable()) closeReports();
}

// The sessions so far, newest first. Planned sessions from MiKast dated today or later are
// listed apart (comingUp, mikast-link.js); past ones that never started sort by their date.
function sortedSessions() {
  const t = localDate(Date.now());
  const key = r => r.planned ? new Date(r.date + 'T12:00:00').getTime() : r.created;
  return show.reports.filter(r => !(r.planned && r.date >= t)).sort((a, b) => key(b) - key(a));
}
function upcomingSessions() { return typeof comingUp === 'function' ? comingUp() : []; }

function openReports(id) {
  if (!reportsAvailable()) return;
  reportFields();
  const list = sortedSessions();
  const up = upcomingSessions();
  const today = up.find(r => r.date === localDate(Date.now()));
  rpId = (id && show.reports.some(r => r.id === id)) ? id : (openSession() || today || list[0] || up[0] || {}).id || null;
  rpMode = 'report';
  rpOpen = true;
  document.getElementById('rpOverlay').classList.add('open');
  renderReports();
}

function closeReports() {
  rpOpen = false;
  document.getElementById('rpOverlay').classList.remove('open');
}

function rpSession() { return show.reports.find(r => r.id === rpId) || null; }

// Called by timing.js when a session changes or is deleted: the list and
// the times. Fields aren't redrawn, so typing isn't interrupted.
function reportsRefresh() {
  if (!rpOpen) return;
  if (!rpSession()) {
    const list = sortedSessions().concat(upcomingSessions());
    rpId = list.length ? list[0].id : null;
    renderReports();
    return;
  }
  renderReportList();
  const box = document.getElementById('rpTimes');
  if (box) box.innerHTML = timesHtml(rpSession());
  const sub = document.getElementById('rpSub');
  if (sub) sub.textContent = subText(rpSession());
  const title = document.getElementById('rpTitle');
  if (title) title.textContent = sessionTitle(rpSession());
}

// ── Rendering ─────────────────────────────────────────────────────────
function longDate(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}
function subText(s) {
  return longDate(s) + (s.ended ? '' : ' · session running') +
    (s.planned ? ' · planned (from MiKast)' : '') + (s.callGone ? ' · call removed in MiKast' : '');
}

// Times block: the clock's summary, then holds with their reasons and other moments
function timesRows(s) {
  const rows = summaryLines(s).slice();
  s.holds.slice().sort((a, b) => a.start - b.start).forEach(h => {
    rows.push(['Hold', `${fmtTime(h.start)} · ${h.end === null ? 'running' : fmtDur(h.end - h.start)}${h.reason ? ' · ' + h.reason : ''}`]);
  });
  sortedEvents(s).filter(e => e.key === 'other').forEach(e => rows.push([e.label || 'Other', fmtTime(e.t)]));
  return rows;
}
function timesHtml(s) {
  const rows = timesRows(s);
  return rows.length
    ? rows.map(([k, v]) => `<div class="tm-sum-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')
    : '<div class="in-empty">Not timed. Edit Times adds them.</div>';
}

function renderReportList() {
  const el = document.getElementById('rpList');
  if (!el) return;
  const list = sortedSessions();
  const up = upcomingSessions();
  const today = localDate(Date.now());
  const item = r => {
    const n = filledCount(r);
    const call = r.call && typeof mkCall === 'function' ? mkCall(r.call) : null;
    const st = !r.ended ? 'running' : r.planned ? (r.date === today ? 'today' : 'planned')
      : n ? `${n} field${n === 1 ? '' : 's'}` : 'no notes';
    const when = sessionDateText(r) + (r.planned && call && call.start ? ' · ' + mkHm(call.start) : '');
    return `<div class="rp-item${r.id === rpId ? ' sel' : ''}${r.planned ? ' planned' : ''}${r.callGone ? ' gone' : ''}" data-id="${r.id}"${r.callGone ? ' title="Its call was deleted in MiKast"' : ''}>
      <div class="rp-item-t">${esc(sessionTitle(r))}</div>
      <div class="rp-item-m"><span>${esc(when)}</span><span class="${!r.ended ? 'rp-run' : r.planned && r.date === today ? 'rp-today' : ''}">${st}</span></div>
    </div>`;
  };
  const head = t => `<div class="rp-group mi-label">${t}</div>`;
  el.innerHTML = (up.length ? head('Coming up (from MiKast)') + up.map(item).join('') + (list.length ? head('Sessions so far') : '') : '') +
    (list.length ? list.map(item).join('') : up.length ? '' : '<div class="in-empty rp-none">No sessions yet. Start one in Show mode, or add a report here.</div>');
}

function fieldWidget(f, v) {
  const val = esc(v || '');
  if (f.type === 'text') return `<textarea class="mi-input rp-text" data-fid="${f.id}" rows="2" spellcheck="true">${val}</textarea>`;
  if (f.type === 'time') return `<div class="rp-timewrap"><input class="mi-input rp-time" type="time" data-fid="${f.id}" value="${/^\d{2}:\d{2}$/.test(v || '') ? val : ''}">` +
    (v && !/^\d{2}:\d{2}$/.test(v) ? `<span class="rp-was" title="Entered before this field was a Time field">was: ${val}</span>` : '') + '</div>';
  if (f.type === 'number') return `<input class="mi-input rp-num" type="number" min="0" data-fid="${f.id}" value="${val}">`;
  if (f.type === 'yesno') {
    return `<select class="mi-select rp-yn" data-fid="${f.id}">` +
      ['', 'Yes', 'No'].map(o => `<option value="${o}"${o === (v || '') ? ' selected' : ''}>${o || '-'}</option>`).join('') + '</select>';
  }
  return `<input class="mi-input rp-line" data-fid="${f.id}" value="${val}" spellcheck="true">`;
}

function renderReports() {
  const body = document.getElementById('rpBody');
  const s = rpSession();
  let main;
  if (rpMode === 'template') {
    main = templateHtml();
  } else if (!s) {
    main = `<div class="rp-main-empty">
      <div class="script-empty-title">No reports yet</div>
      <div class="script-empty-sub">A report goes with each session. Start a session in Show mode, or add a report for a rehearsal you didn’t time.</div>
      <div class="rp-foot"><button class="mi-btn" data-act="template">Edit Template</button><div class="tb-fill"></div>
      <button class="mi-btn mi-btn-go" data-act="close" style="padding:9px 18px">Close</button></div>
    </div>`;
  } else {
    const fields = reportFields();
    main = `
      <div class="rp-head">
        <div class="rp-head-t">
          <div class="rp-title" id="rpTitle">${esc(sessionTitle(s))}</div>
          <div class="rp-sub" id="rpSub">${esc(subText(s))}</div>
        </div>
        <button class="mi-btn" data-act="times" title="Session Log: times, holds, kind, number and date">Edit Times</button>
      </div>
      <div class="rp-scroll mi-scroll" id="rpScroll">
        <div class="tm-sec">Times</div>
        <div id="rpTimes">${timesHtml(s)}</div>
        <div class="tm-sec">Report</div>
        ${fields.length ? fields.map(f => `
          <label class="rp-field rp-${f.type}">
            <span class="rp-label">${esc(f.label)}</span>
            ${fieldWidget(f, (s.fields || {})[f.id])}
          </label>`).join('') : '<div class="in-empty">The template has no fields. Edit Template adds them.</div>'}
      </div>
      <div class="rp-foot">
        <button class="mi-btn" data-act="template">Edit Template</button>
        <div class="tb-fill"></div>
        <button class="mi-btn" data-act="print" title="Print (Ctrl+P)">Print</button>
        <button class="mi-btn" data-act="pdf" title="Save as a PDF in the show’s reports folder">Save PDF</button>
        <button class="mi-btn mi-btn-go" data-act="close" style="padding:9px 18px">Close</button>
      </div>`;
  }
  body.innerHTML = `
    <div class="rp-side">
      <div class="rp-side-head"><span class="mi-label">Reports</span><span class="mi-label">${esc(show.name || '')}</span></div>
      <div class="rp-list mi-scroll" id="rpList"></div>
      <button class="mi-btn rp-new" data-act="new" title="A report for a session you didn’t time">+ New Report</button>
      <div class="rp-notes" id="rpNotes"></div>
    </div>
    <div class="rp-main">${main}</div>`;
  renderReportList();
  if (typeof renderNotesStrip === 'function') renderNotesStrip(true);   // notes.js
  body.querySelectorAll('textarea.rp-text').forEach(autoGrow);
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.max(ta.scrollHeight + 2, 40) + 'px';
}

function templateHtml() {
  const fields = reportFields();
  return `
    <div class="rp-head">
      <div class="rp-head-t">
        <div class="rp-title">Report Template</div>
        <div class="rp-sub">The fields every report of this show has. Carry forward: a new report starts with the last report’s entry.</div>
      </div>
    </div>
    <div class="rp-scroll mi-scroll">
      <div class="rp-tpl-head"><span>Field</span><span>Kind</span><span>Carry forward</span><span></span></div>
      ${fields.map((f, i) => `
        <div class="rp-tpl-row" data-tid="${f.id}">
          <input class="mi-input" data-t="label" value="${esc(f.label)}" spellcheck="true">
          <select class="mi-select" data-t="type">${FIELD_TYPES.map(([k, l]) => `<option value="${k}"${k === f.type ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <label class="rp-carry"><input type="checkbox" data-t="carry"${f.carry ? ' checked' : ''}></label>
          <span class="rp-tpl-tools">
            <button class="dp-btn" data-act="up" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>
            <button class="dp-btn" data-act="down" title="Move down"${i === fields.length - 1 ? ' disabled' : ''}>▼</button>
            <button class="dp-btn dp-del" data-act="delField" title="Delete field">✕</button>
          </span>
        </div>`).join('') || '<div class="in-empty">No fields</div>'}
      <button class="mi-btn rp-add" data-act="addField">+ Add field</button>
    </div>
    <div class="rp-foot">
      <button class="mi-btn" data-act="suggested" title="Replace the template with the suggested fields">Use Suggested Fields</button>
      <div class="tb-fill"></div>
      <button class="mi-btn mi-btn-go" data-act="doneTpl" style="padding:9px 18px">Done</button>
    </div>`;
}

// ── Editing ───────────────────────────────────────────────────────────
function onRpInput(e) {
  const el = e.target;
  if (el.dataset.fid) {
    const s = rpSession();
    if (!s) return;
    if (!s.fields || typeof s.fields !== 'object') s.fields = {};
    s.fields[el.dataset.fid] = el.value;
    s.updated = Date.now();
    markDirty();
    if (el.tagName === 'TEXTAREA') autoGrow(el);
    // Crash recovery (timing.js) covers report text too; not on every key
    clearTimeout(rpRecTimer);
    rpRecTimer = setTimeout(() => { const r = rpSession(); if (r) saveRecovery(r); }, 500);
    return;
  }
  if (el.dataset.t === 'label') {
    const f = tplField(el);
    if (!f) return;
    f.label = el.value.trim() || 'Field';
    markDirty();
  }
}

function onRpChange(e) {
  const el = e.target;
  if (el.dataset.fid) { renderReportList(); return; }      // field count in the list
  const f = tplField(el);
  if (!f) return;
  if (el.dataset.t === 'type') { if (FIELD_TYPE_KEYS.includes(el.value)) f.type = el.value; markDirty(); }
  else if (el.dataset.t === 'carry') { f.carry = el.checked; markDirty(); }
  else if (el.dataset.t === 'label') { el.value = f.label; }
}

function tplField(el) {
  const row = el.closest('[data-tid]');
  return row ? reportFields().find(f => f.id === row.dataset.tid) || null : null;
}

async function onRpClick(e) {
  if (e.target === e.currentTarget) { closeReports(); return; }          // backdrop
  const item = e.target.closest('.rp-item');
  if (item) { rpId = item.dataset.id; rpMode = 'report'; renderReports(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  const s = rpSession();
  if (act === 'close') closeReports();
  else if (act === 'times') { if (s) openTimingDialog(s.id); }
  else if (act === 'template') { rpMode = 'template'; renderReports(); }
  else if (act === 'doneTpl') { rpMode = 'report'; renderReports(); }
  else if (act === 'new') await newReportCmd();
  else if (act === 'notesOn') await notesOnCmd();
  else if (act === 'pdf') { if (s) await reportPdfCmd(s); }
  else if (act === 'print') { if (s) await reportPrintCmd(s); }
  else if (act === 'addField') {
    const f = { id: uid(), label: 'New field', type: 'text', carry: false };
    reportFields().push(f);
    markDirty();
    renderReports();
    const inp = document.querySelector(`#rpBody [data-tid="${f.id}"] input[data-t=label]`);
    if (inp) { inp.focus(); inp.select(); }
  }
  else if (act === 'up' || act === 'down') {
    const fields = reportFields();
    const i = fields.findIndex(f => f.id === b.closest('[data-tid]').dataset.tid);
    const j = act === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= fields.length) return;
    [fields[i], fields[j]] = [fields[j], fields[i]];
    markDirty();
    renderReports();
  }
  else if (act === 'delField') {
    const f = tplField(b);
    if (!f) return;
    const used = show.reports.filter(r => r.fields && String(r.fields[f.id] || '').trim()).length;
    if (used) {
      const ok = await ask(`Delete “${f.label}”?`,
        `${used} report${used === 1 ? ' has' : 's have'} something written in it. That is deleted too.`, [
        { label: 'Cancel', value: false },
        { label: 'Delete', value: true, cls: 'mi-btn-exit' }
      ], false);
      if (!ok) return;
    }
    show.reportFields = reportFields().filter(x => x.id !== f.id);
    show.reports.forEach(r => { if (r.fields) delete r.fields[f.id]; });
    markDirty();
    renderReports();
  }
  else if (act === 'suggested') {
    // Entries move to the suggested field of the same name; the rest would be lost
    const next = suggestedFields();
    const byLabel = new Map(next.map(f => [f.label.toLowerCase(), f.id]));
    const lost = show.reports.filter(r => reportFields().some(f =>
      !byLabel.has(f.label.toLowerCase()) && r.fields && String(r.fields[f.id] || '').trim())).length;
    const ok = await ask('Use the suggested fields?',
      'The template is replaced with the suggested fields. Entries in fields with the same name are kept.' +
      (lost ? `\n\n${lost} report${lost === 1 ? ' has' : 's have'} entries in other fields. Those are deleted.` : ''), [
      { label: 'Cancel', value: false },
      { label: 'Replace', value: true, cls: lost ? 'mi-btn-exit' : 'mi-btn-go' }
    ], false);
    if (!ok) return;
    const old = reportFields();
    show.reports.forEach(r => {
      const was = r.fields || {};
      r.fields = {};
      old.forEach(f => {
        const id = byLabel.get(f.label.toLowerCase());
        if (id && String(was[f.id] || '').trim()) r.fields[id] = was[f.id];
      });
    });
    show.reportFields = next;
    markDirty();
    renderReports();
  }
}

// A report for a session that wasn't timed
async function newReportCmd() {
  const kind = await ask('New report', 'For a rehearsal or performance that wasn’t timed with the show clock. Times can be added with Edit Times.', [
    { label: 'Cancel', value: null },
    ...SESSION_KINDS.map(k => ({ label: k, value: k, cls: k === 'Performance' ? 'mi-btn-go' : '' }))   // as Start Session: Enter = Performance
  ], null);
  if (!kind) return;
  reportFields();
  const s = createSession(kind, true);
  rpId = s.id;
  rpMode = 'report';
  renderReports();
}

// ── The printed report ────────────────────────────────────────────────
function reportFileName(s) {
  return `${s.date} ${sessionTitle(s)}`.replace(/[\\/:*?"<>|]+/g, '-').trim() + '.pdf';
}

function reportDocHtml(s) {
  const fields = reportFields();
  const val = f => {
    const v = String((s.fields || {})[f.id] || '').trim();
    if (!v) return '<span class="none">-</span>';
    if (f.type === 'time' && /^\d{2}:\d{2}$/.test(v)) {
      const [h, m] = v.split(':').map(Number);
      return esc(new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    }
    return esc(v);
  };
  const times = timesRows(s);
  const printed = new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(show.name || 'Show')} · ${esc(sessionTitle(s))}</title>
<style>
  @page { size: Letter; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.35; }
  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .show { font-size: 20pt; font-weight: 700; letter-spacing: 0.3px; }
  .kind { font-size: 12pt; font-weight: 600; color: #444; margin-top: 2px; }
  .date { font-size: 10.5pt; color: #444; text-align: right; white-space: nowrap; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: 1.2px; color: #666; border-bottom: 1px solid #bbb; padding-bottom: 2px; margin: 14px 0 6px; }
  table.times { border-collapse: collapse; width: 100%; }
  table.times td { padding: 2px 0; border-bottom: 1px solid #e4e4e4; vertical-align: top; }
  table.times td:first-child { width: 32%; color: #555; }
  .field { display: grid; grid-template-columns: 32% 1fr; gap: 8px; padding: 5px 0; border-bottom: 1px solid #e4e4e4; break-inside: avoid; }
  .field .k { font-weight: 600; }
  .field .v { white-space: pre-wrap; word-wrap: break-word; }
  .none { color: #999; }
  footer { margin-top: 18px; font-size: 8pt; color: #888; display: flex; justify-content: space-between; }
</style></head><body>
<header>
  <div><div class="show">${esc(show.name || 'Untitled Show')}</div><div class="kind">${esc(sessionTitle(s))} Report</div></div>
  <div class="date">${esc(longDate(s))}</div>
</header>
<h2>Times</h2>
${times.length ? `<table class="times">${times.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '<div class="none">Not timed</div>'}
<h2>Report</h2>
${fields.map(f => `<div class="field"><div class="k">${esc(f.label)}</div><div class="v">${val(f)}</div></div>`).join('')}
<footer><span>${esc(show.name || '')} · ${esc(sessionTitle(s))}</span><span>MiKallbook · ${esc(printed)}</span></footer>
</body></html>`;
}

// The show needs a folder (saved once) before a PDF can go in its reports folder
async function ensureSavedForReports() {
  if (showPath) return true;
  const ok = await ask('Save the show first?', 'Report PDFs go in the show’s reports folder, which is made when the show is saved.', [
    { label: 'Cancel', value: false },
    { label: 'Save', value: true, cls: 'mi-btn-go' }
  ], false);
  if (!ok) return false;
  return await saveShow(false);
}

async function reportPdfCmd(s) {
  if (!(await ensureSavedForReports())) return;
  let r;
  try { r = await bridge.reports.savePdf(reportDocHtml(s), showPath, reportFileName(s)); }
  catch (err) { toast('PDF failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.error) { toast('PDF failed: ' + (r ? r.error : 'no answer'), 'err'); return; }
  const ans = await ask('Report saved', r.path, [
    { label: 'Show in Folder', value: 'folder' },
    { label: 'Open PDF', value: 'open' },
    { label: 'OK', value: 'ok', cls: 'mi-btn-go' }
  ], 'ok');
  if (ans === 'open') bridge.reports.open(r.path);
  else if (ans === 'folder') bridge.reports.reveal(r.path);
}

async function reportPrintCmd(s) {
  let r;
  try { r = await bridge.reports.print(reportDocHtml(s)); }
  catch (err) { toast('Print failed: ' + cleanErr(err), 'err'); return; }
  if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) toast('Print failed: ' + r.reason, 'err');
}

// ── Keys and wiring ───────────────────────────────────────────────────
function reportsDialogKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (rpMode === 'template') { rpMode = 'report'; renderReports(); }
    else closeReports();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveShow(e.shiftKey); return; }
  if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); const s = rpSession(); if (s && rpMode === 'report') reportPrintCmd(s); return; }
  if (ctrl && ['o', 'n'].includes(e.key.toLowerCase())) { e.preventDefault(); return; }
  // Enter in a one-line field moves on instead of doing nothing
  if (e.key === 'Enter' && e.target && e.target.matches && e.target.matches('input.rp-line, input.rp-num, input[data-t=label]')) {
    e.preventDefault();
    e.target.blur();
  }
}

function initReports() {
  document.getElementById('btnReports').addEventListener('click', () => openReports());
  const ov = document.getElementById('rpOverlay');
  ov.addEventListener('click', onRpClick);
  ov.addEventListener('input', onRpInput);
  ov.addEventListener('change', onRpChange);
  renderReportsButton();
}
