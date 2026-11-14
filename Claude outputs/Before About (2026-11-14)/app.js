'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: UI and show logic
   Show model, show files (New / Open / Save / Save As / Exit), Edit/Show
   mode, modal and toasts, and the script viewer (script-view.js).
   Marking and calling are added in the following steps.
   ════════════════════════════════════════════════════════════════════ */

const bridge = window.micallbook;
const view   = new MiScriptView(document.getElementById('scriptView'));

// Suggested departments for a new production. Colors stay clear of
// MiKonsole's state colors (green GO, red blackout, blue blind, lavender
// follow). LX = MiKonsole gold, SQ = MiKue cyan.
const DEFAULT_DEPARTMENTS = [
  { code: 'LX',    name: 'Lighting',   color: '#d4a84b', target: 'mikonsole' },
  { code: 'SQ',    name: 'Sound',      color: '#4cc4c4', target: 'micue' },
  { code: 'MIC',   name: 'Sound Board', color: '#b8d86a', target: 'none', mics: true },   // mic cues by mic numbers (no mixer app)
  { code: 'FLY',   name: 'Fly',        color: '#d9a0e0', target: 'none' },
  { code: 'SPOT',  name: 'Followspot', color: '#e88a5a', target: 'none' },
  { code: 'VIDEO', name: 'Video',      color: '#f08cb0', target: 'none' },
  { code: 'DECK',  name: 'Deck',       color: '#a8a49a', target: 'none' }
];
const DOC_TYPES = ['none', 'script', 'text', 'runningOrder'];
const TARGETS   = ['none', 'mikonsole', 'micue'];

// ── State ─────────────────────────────────────────────────────────────
let show     = newShow();
let showPath = null;
let dirty    = false;
let mode     = 'edit';

// ── Model ─────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function newShow() {
  return {
    format: 'micallbook', version: 1,
    id: uid(),              // stays with the show file; the live link checks it
    name: 'Untitled Show',
    // type: 'none' | 'script' (PDF) | 'text' (pasted) | 'runningOrder' (concert)
    document: { type: 'none' },
    settings: { tabSide: 'right' },
    // The departments saved as default on this computer, else the suggested set
    departments: (savedDefaultDepartments() || DEFAULT_DEPARTMENTS).map(d => normalizeDepartment({ ...d, id: uid() })),
    goPoints: [],
    callOrder: null,        // GO ids in calling order, once moved by hand; null = reading order
    timing: { acts: 2 },    // show clock: acts per session (timing.js)
    reportFields: null,     // report template (reports.js); null = suggested fields on first use
    reports: [],            // one record per rehearsal / performance session (timing.js)
    mikast: null            // the linked MiKast production (mikast-link.js)
  };
}

function normalizeDepartment(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    id:     typeof d.id === 'string' && d.id ? d.id : uid(),
    code:   String(d.code || '').trim().toUpperCase() || '?',
    name:   String(d.name || ''),
    color:  /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#a8a49a',
    target: TARGETS.includes(d.target) ? d.target : 'none',
    // called by mic numbers (MIC 4–8 IN); older files: on for a department coded MIC
    mics:   typeof d.mics === 'boolean' ? d.mics : String(d.code || '').trim().toUpperCase() === 'MIC'
  };
}

function normalizeDocument(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const type = DOC_TYPES.includes(d.type) ? d.type : 'none';
  const out = { type };
  if (type === 'script' && d.pdf && typeof d.pdf.path === 'string') {
    out.pdf = { path: d.pdf.path, name: String(d.pdf.name || baseName(d.pdf.path)) };
  }
  if (type === 'text') {
    out.text = String(d.text || '');
    out.layout = d.layout === 'plain' ? 'plain' : 'script';
  }
  if (type === 'runningOrder') out.items = (Array.isArray(d.items) ? d.items : []).map(normalizeRoItem);
  return out;
}

// GO points are kept as saved; steps 1d/1e add full checking.
function normalizeShow(s, path) {
  const depts = Array.isArray(s.departments) && s.departments.length
    ? s.departments.map(normalizeDepartment)
    : DEFAULT_DEPARTMENTS.map(d => ({ id: uid(), ...d }));
  return {
    format: 'micallbook', version: 1,
    // Files saved before the live link have no ID: give one (kept on the next save)
    id: typeof s.id === 'string' && s.id ? s.id : uid(),
    name: stripExt(baseName(path)),
    document: normalizeDocument(s.document),
    settings: Object.assign({ tabSide: 'right' }, s.settings || {}),
    departments: depts,
    goPoints: Array.isArray(s.goPoints) ? s.goPoints : [],
    callOrder: Array.isArray(s.callOrder) ? s.callOrder.filter(x => typeof x === 'string') : null,
    timing: normalizeTiming(s.timing),
    reportFields: normalizeReportFields(s.reportFields),
    reports: Array.isArray(s.reports) ? s.reports.map(normalizeReport).filter(Boolean) : [],
    mikast: normalizeMikastRef(s.mikast)
  };
}

function baseName(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function stripExt(s) { return s.replace(/\.[^.]+$/, ''); }
function cleanErr(err) {
  const m = String((err && err.message) || err || 'Unknown error');
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// ── Dirty / title ─────────────────────────────────────────────────────
function markDirty() {
  if (!dirty) { dirty = true; renderHeader(); }
}
function renderHeader() {
  const el = document.getElementById('showName');
  el.textContent = show.name || 'Untitled Show';
  el.title = showPath || 'Not saved yet';
  // File status, as in MiKonsole's file bar
  const st = document.getElementById('fileStatus');
  st.textContent = !showPath ? 'unsaved' : dirty ? 'unsaved changes' : 'saved';
  st.className = 'mi-file-status' + (showPath && !dirty ? ' ok' : dirty ? ' warn' : '');
  st.title = showPath || '';
  document.getElementById('btnExit').classList.toggle('dirty', dirty);
  bridge.setTitle(`MiKallbook · ${show.name || 'Untitled Show'}${dirty ? ' *' : ''}`);
  if (typeof sendBooth === 'function') sendBooth();
}

// ── Calling column (filled in by step 1e) ─────────────────────────────
// Edit mode: every GO point in calling order. (Step 1e turns this into
// the Standby / Coming up view for calling the show.)
function renderCalling() {
  const n = show.goPoints.length;
  document.getElementById('goCount').textContent = n ? `${n} GO point${n === 1 ? '' : 's'}` : '';
  const list = document.getElementById('upcomingList');
  if (!n) {
    list.innerHTML = '<div class="upcoming-empty">Nothing marked yet</div>';
    if (typeof renderRunningOrder === 'function') renderRunningOrder();
    return;
  }
  list.innerHTML = '';
  const readIdx = new Map(readingOrder().map((g, k) => [g.id, k]));
  orderedGoPoints().forEach((gp, i) => {
    const p = goPos(gp);
    const row = document.createElement('div');
    const showing = isCalling();
    const si = atEnd ? Infinity : standbyIndex();
    row.className = 'go-row' + (!showing && gp.id === selectedGoId ? ' sel' : '') + (p ? '' : ' unplaced') +
      (gp.needsCheck ? ' check' : '') + (readIdx.get(gp.id) !== i ? ' moved' : '') +
      (showing && gp.id === standbyGoId && !atEnd ? ' standby' : '') + (showing && i < si ? ' called' : '');
    if (readIdx.get(gp.id) !== i) row.title = 'Moved out of reading order';
    row.dataset.id = gp.id;
    const num = document.createElement('span');
    num.className = 'go-n';
    num.textContent = String(i + 1);
    const cues = document.createElement('span');
    cues.className = 'go-cues';
    if (!gp.cues.length) cues.textContent = 'GO';
    displayCues(gp).forEach(({ c, sep }) => {
      if (sep) cues.appendChild(document.createTextNode(sep));
      const sp = document.createElement('span');
      sp.style.color = deptColor(c.dept);
      sp.textContent = cueText(c);
      cues.appendChild(sp);
    });
    const where = document.createElement('span');
    where.className = 'go-page';
    where.textContent = p ? posLabel(p, true) : (isRO() ? 'item?' : 'place');
    row.append(num, cues, where);
    list.appendChild(row);
  });
  const sel = list.querySelector(isCalling() ? '.go-row.standby' : '.go-row.sel');
  if (sel) sel.scrollIntoView({ block: isCalling() ? 'center' : 'nearest' });
  if (typeof renderRunningOrder === 'function') renderRunningOrder();   // runorder.js: chips and highlights
}

// ── Script column ─────────────────────────────────────────────────────
// docState: 'none' | 'loading' | 'ready' | 'missing' | 'error'
let docState = 'none';
let docError = '';
let docLoadSeq = 0;

function renderScript() {
  const wrap = document.getElementById('scriptWrap');
  const ro = show.document.type === 'runningOrder';
  wrap.classList.toggle('no-doc', docState !== 'ready' || ro);     // page controls: scripts only
  wrap.classList.toggle('ro', ro);
  document.getElementById('scriptLoading').classList.toggle('hidden', docState !== 'loading');

  const empty = document.getElementById('scriptEmpty');
  const title = document.getElementById('emptyTitle');
  const sub   = document.getElementById('emptySub');
  const locate = document.getElementById('btnLocatePdf');
  empty.classList.toggle('hidden', docState === 'ready' || docState === 'loading');
  if (typeof renderRunningOrder === 'function') renderRunningOrder();
  locate.classList.add('hidden');
  if (docState === 'none') {
    title.textContent = 'No script yet';
    sub.textContent = 'Import the script as a PDF, paste it as plain text, or start a running order for a concert.';
  } else if (docState === 'missing') {
    title.textContent = 'Script file not found';
    sub.textContent = (show.document.pdf ? show.document.pdf.path : '') + '\n\nPoint MiKallbook at the PDF again with Locate PDF…';
    locate.classList.remove('hidden');
  } else if (docState === 'error') {
    title.textContent = 'Could not open the script';
    sub.textContent = docError;
    locate.classList.toggle('hidden', show.document.type !== 'script');
  }
  renderPageInfo();
  renderViewControls();
  renderDocButtons();
}

function renderDocButtons() {
  const isText = show.document.type === 'text';
  const b = document.getElementById('btnPasteText');
  b.textContent = isText ? 'Edit Text…' : 'Paste Text…';
  b.title = isText ? 'Edit the script text (marks stay with their words)' : 'Paste or type the script as plain text';
}

function renderPageInfo() {
  const n = view.pageCount;
  const inp = document.getElementById('pageInput');
  if (document.activeElement !== inp) inp.value = n ? String(view.current + 1) : '';
  document.getElementById('pageTotal').textContent = '/ ' + n;
  document.getElementById('zoomPct').textContent = view.zoomPercent + '%';
  document.getElementById('btnFitW').classList.toggle('on', view.zoom === 'fit');
  document.getElementById('btnFitP').classList.toggle('on', view.zoom === 'page');
}

// Load whatever the show's document is into the viewer
async function loadDocument() {
  const seq = ++docLoadSeq;
  const d = show.document;
  if (d.type === 'text') {
    view.openText(d.text || '', textLayoutOpts(d));
    docState = 'ready';
    renderScript();
    return;
  }
  if (d.type === 'runningOrder') {      // a list, not pages (runorder.js)
    view.close();
    docState = 'ready';
    renderScript();
    renderMarks();
    return;
  }
  if (d.type !== 'script' || !d.pdf) {
    view.close();
    docState = 'none';
    renderScript();
    return;
  }
  view.close();
  docState = 'loading';
  renderScript();
  let bytes;
  try {
    bytes = await bridge.readScript(d.pdf.path);
  } catch (err) {
    if (seq !== docLoadSeq) return;
    const msg = cleanErr(err);
    docState = /ENOENT|no such file/i.test(msg) ? 'missing' : 'error';
    docError = msg;
    renderScript();
    return;
  }
  if (seq !== docLoadSeq) return;
  try {
    const ok = await view.openPdf(bytes);
    if (!ok || seq !== docLoadSeq) return;
    docState = 'ready';
  } catch (err) {
    if (seq !== docLoadSeq) return;
    console.error('[script] open failed:', err);
    docState = 'error';
    docError = cleanErr(err);
  }
  renderScript();
}

async function importPdfCmd() {
  if (mode !== 'edit') return;
  if (show.document.type !== 'none' && docState !== 'missing') {
    if (!(await confirmReplace('script'))) return;
  }
  await pickPdfInto();
}

// Ask before replacing the script. Marks keep their position when the new
// script is the same kind (PDF -> PDF); between a PDF and text they can't,
// so their cues and notes are kept and each is flagged to be placed again.
async function confirmReplace(newType) {
  const n = show.goPoints.length;
  const sameKind = show.document.type === newType;
  let detail = 'The current script is replaced in this show.';
  if (n && sameKind) {
    detail = `The ${n} GO point${n === 1 ? '' : 's'} already marked stay at the same page positions on the new script.`;
  } else if (n) {
    detail = `Positions can't carry over between a PDF and a text script. The ${n} GO point${n === 1 ? '' : 's'} keep their cues and notes, but each will need placing again.`;
  }
  return await ask('Replace the script?', detail, [
    { label: 'Cancel', value: false },
    { label: 'Replace', value: true, cls: 'mi-btn-go' }
  ], false);
}

// After the script changes kind, marks lose their positions
function unplaceMarksIfKindChanged(oldType, newType) {
  if (oldType === newType || oldType === 'none') return;
  for (const gp of show.goPoints) {
    gp.at = null; gp.standby = null; gp.warn = null;
    gp.needsPlacing = true;
  }
}

// ── Pasted-text scripts ───────────────────────────────────────────────
let textEditorOpen = false;
let textEditorStart = '';
let textLayoutStart = true;

// Script layout is on unless the show turned it off
function textLayoutOpts(doc) { return { script: !doc || doc.layout !== 'plain' }; }

function openTextEditor(text, editing) {
  textEditorOpen = true;
  textEditorStart = text || '';
  textLayoutStart = editing ? show.document.layout !== 'plain' : true;
  document.getElementById('chkScriptLayout').checked = textLayoutStart;
  document.getElementById('textNotice').dataset.auto = '';
  document.getElementById('textTitle').textContent = editing ? 'Edit Script Text' : 'Paste Script Text';
  document.getElementById('btnTextUse').textContent = editing ? 'Save Text' : 'Use Text';
  const ta = document.getElementById('textInput');
  ta.value = textEditorStart;
  updateTextStats();
  document.getElementById('textOverlay').classList.add('open');
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, 0); ta.scrollTop = 0; }, 0);
}

function closeTextEditor() {
  textEditorOpen = false;
  document.getElementById('textOverlay').classList.remove('open');
}

async function cancelTextEditor() {
  const changed = document.getElementById('textInput').value !== textEditorStart ||
                  document.getElementById('chkScriptLayout').checked !== textLayoutStart;
  if (changed) {
    const ok = await ask('Discard your text changes?', 'The script stays as it was.', [
      { label: 'Keep Editing', value: false },
      { label: 'Discard', value: true, cls: 'mi-btn-exit' }
    ], false);
    if (!ok) { document.getElementById('textInput').focus(); return; }
  }
  closeTextEditor();
}

let textStatsTimer = 0;
function updateTextStats() {
  clearTimeout(textStatsTimer);
  textStatsTimer = setTimeout(() => {
    const raw = document.getElementById('textInput').value;
    const t = MiTextDoc.normalize(raw);
    const lay = MiTextDoc.layout(t, { script: document.getElementById('chkScriptLayout').checked });
    document.getElementById('textStats').textContent = t.length
      ? `${t.split('\n').length} lines · ${lay.pages} page${lay.pages === 1 ? '' : 's'}`
      : 'Empty';
    const notice = document.getElementById('textNotice');
    if (MiTextDoc.looksHardWrapped(raw)) {
      notice.innerHTML = 'This looks like text copied from a PDF, with a line break at the end of every printed line. <b>Rejoin Lines</b> puts the paragraphs back together.';
      notice.dataset.auto = '';
      notice.classList.remove('hidden');
    } else if (!notice.dataset.auto) {
      notice.classList.add('hidden');
    }
  }, 150);
}

// Rejoin lines broken by the PDF's page width. Goes through the text box's
// own editing, so Ctrl+Z in the box undoes it.
function rejoinCmd() {
  const ta = document.getElementById('textInput');
  const before = ta.value;
  const after = MiTextDoc.rejoinLines(before);
  if (after === before.replace(/\r\n?/g, '\n')) { toast('Nothing to rejoin.'); return; }
  ta.focus();
  ta.select();
  if (!document.execCommand('insertText', false, after)) ta.value = after;   // fallback loses undo
  ta.setSelectionRange(0, 0);
  ta.scrollTop = 0;
  updateTextStats();
}

async function pasteTextCmd() {
  if (mode !== 'edit') return;
  if (show.document.type === 'text') { openTextEditor(show.document.text, true); return; }
  if (show.document.type !== 'none' && docState !== 'missing') {
    if (!(await confirmReplace('text'))) return;
  }
  openTextEditor('', false);
}

// Every text anchor a GO point holds ({ offset } objects)
function textAnchorsOf(gp) {
  return [gp.at, gp.standby, gp.warn].filter(a => a && typeof a.offset === 'number');
}

// Pasting text copied from a PDF: let the paste land, then rejoin just the
// pasted part. Two steps in the box's undo history, so Ctrl+Z once brings
// back the original line breaks.
function onTextPaste(e) {
  const pasted = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  if (!pasted || !MiTextDoc.looksHardWrapped(pasted)) return;
  const ta = e.target;
  const start = ta.selectionStart;
  setTimeout(() => {
    const end = ta.selectionEnd;                 // caret sits after the pasted text
    if (end <= start) return;
    const landed = ta.value.slice(start, end);
    const fixed = MiTextDoc.rejoinLines(landed);
    if (fixed === landed) return;
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, fixed)) {
      ta.value = ta.value.slice(0, start) + fixed + ta.value.slice(end);
    }
    ta.setSelectionRange(start, start);
    ta.scrollTop = 0;
    updateTextStats();
    showAutoRejoined();
  }, 0);
}

function showAutoRejoined() {
  const n = document.getElementById('textNotice');
  n.innerHTML = 'Line breaks from the PDF were removed and page numbers dropped. <b>Ctrl+Z</b> puts them back.';
  n.classList.remove('hidden');
  n.dataset.auto = '1';
}

async function useText() {
  let raw = document.getElementById('textInput').value;
  // Last check: text that still has a break at every printed line
  if (MiTextDoc.looksHardWrapped(raw)) {
    const ans = await ask('Rejoin lines first?',
      'This text still has a line break at the end of every printed line, the way text copied from a PDF does. ' +
      'Rejoining puts the paragraphs back together and drops page numbers.', [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use As Is', value: 'asis' },
      { label: 'Rejoin and Use', value: 'rejoin', cls: 'mi-btn-go' }
    ], 'cancel');
    if (ans === 'cancel') { document.getElementById('textInput').focus(); return; }
    if (ans === 'rejoin') raw = MiTextDoc.rejoinLines(raw);
  }
  const text = MiTextDoc.normalize(raw);
  if (!text.trim()) { toast('There is no text to use.', 'err'); return; }
  const layoutMode = document.getElementById('chkScriptLayout').checked ? 'script' : 'plain';
  const oldDoc = show.document;
  const wasText = oldDoc.type === 'text';

  let moved = 0;
  if (wasText && oldDoc.text !== text) {
    // Keep every mark on the same words in the new text
    const anchors = [];
    for (const gp of show.goPoints) for (const a of textAnchorsOf(gp)) anchors.push({ gp, a });
    const res = MiTextDoc.remapOffsets(oldDoc.text, text, anchors.map(x => x.a.offset));
    res.forEach((r, i) => {
      anchors[i].a.offset = r.offset;
      if (r.moved && !anchors[i].gp.needsCheck) { anchors[i].gp.needsCheck = true; moved++; }
    });
  } else if (!wasText) {
    unplaceMarksIfKindChanged(oldDoc.type, 'text');
  }

  if (wasText && oldDoc.text === text && oldDoc.layout === layoutMode) { closeTextEditor(); return; }
  show.document = { type: 'text', text, layout: layoutMode };
  resetHistory();   // marks were moved to the new text; older undo steps would point at the old one
  markDirty();
  closeTextEditor();
  if (wasText && docState === 'ready') {
    view.replaceText(text, textLayoutOpts(show.document));
    renderScript();
  } else {
    loadDocument();
  }
  toast(`Text script: ${view.pageCount} page${view.pageCount === 1 ? '' : 's'}` +
        (moved ? ` · ${moved} GO point${moved === 1 ? '' : 's'} to check` : ''), moved ? 'err' : 'ok');
}

// Used by Import and by Locate (missing file)
async function pickPdfInto() {
  let r;
  try { r = await bridge.pickScript(); } catch (err) { toast('Import failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.canceled) return;
  unplaceMarksIfKindChanged(show.document.type, 'script');
  show.document = { type: 'script', pdf: { path: r.path, name: r.name } };
  resetHistory();
  markDirty();
  await loadDocument();
  if (docState === 'ready') toast(`${r.name}: ${view.pageCount} page${view.pageCount === 1 ? '' : 's'}`, 'ok');
}

// ── View preferences (this computer only, not saved in the show) ──────
const PREF_KEY = 'micallbook.view';
let viewPrefs = { dark: false, contrast: 1, spread: false, zoom: 'fit', follow: true };   // follow: Show mode scrolls the script
try { Object.assign(viewPrefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (_) {}
function saveViewPrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(viewPrefs)); } catch (_) {}
}

function applyViewPrefs() {
  const c = Math.max(1, Math.min(1.8, Number(viewPrefs.contrast) || 1));
  viewPrefs.contrast = c;
  document.getElementById('scriptView').classList.toggle('dark', !!viewPrefs.dark);
  document.getElementById('operator').classList.toggle('dark', !!viewPrefs.dark);
  document.getElementById('scriptWrap').classList.toggle('dark', !!viewPrefs.dark);
  document.getElementById('scriptView').style.setProperty('--dk-contrast', String(c));
  document.getElementById('contrastRange').value = String(c);
  view.spread = !!viewPrefs.spread;
  view.zoom = viewPrefs.zoom === 'fit' || viewPrefs.zoom === 'page' ? viewPrefs.zoom : (Number(viewPrefs.zoom) || 'fit');
}

function renderViewControls() {
  document.getElementById('btnPaper').classList.toggle('on', !viewPrefs.dark);
  document.getElementById('btnDark').classList.toggle('on', !!viewPrefs.dark);
  document.getElementById('btnOnePage').classList.toggle('on', !view.spread);
  document.getElementById('btnTwoPage').classList.toggle('on', view.spread);
  const f = document.getElementById('btnFollow');
  f.classList.toggle('on', viewPrefs.follow !== false);
  f.textContent = viewPrefs.follow !== false ? 'Follow ✓' : 'Follow';
  f.title = viewPrefs.follow !== false
    ? 'Follow is on: the script scrolls to keep the next call in view. Click to stop it scrolling.'
    : 'Follow is off: the script stays where you put it. Click to follow the calls again.';
}
// Follow on / off (Mike, 2026-10-20). Turning it on jumps to the next call.
function setFollow(on) {
  viewPrefs.follow = !!on;
  saveViewPrefs();
  renderViewControls();
  if (on) followStandby(true, true);
}

function setDark(on) {
  viewPrefs.dark = !!on;
  saveViewPrefs();
  applyViewPrefs();
  renderViewControls();
  if (mode === 'operator') renderOperator();
}
function setSpread(on) {
  viewPrefs.spread = !!on;
  saveViewPrefs();
  view.setSpread(!!on);
  renderViewControls();
}
function setZoom(z) {
  view.setZoom(z);
  viewPrefs.zoom = view.zoom;
  saveViewPrefs();
}

// Side panels and the placing banner sit just below the script toolbar,
// which wraps onto two rows in a narrow window
function trackScriptBar() {
  const bar = document.querySelector('.script-bar');
  const wrap = document.getElementById('scriptWrap');
  const set = () => wrap.style.setProperty('--bar-bottom', (bar.offsetTop + bar.offsetHeight) + 'px');
  new ResizeObserver(set).observe(bar);
  set();
}

view.onPageChange = () => renderPageInfo();
view.onLayout = () => {
  if (view.zoom !== 'fit' && view.zoom !== 'page') { viewPrefs.zoom = view.zoom; saveViewPrefs(); }
  renderPageInfo();
  renderMarks();
};

function renderAll() {
  renderHeader();
  renderCalling();
  renderStandby();
  decorateCalling();
  renderScript();
}

// ── Show files ────────────────────────────────────────────────────────
function serializeShow() {
  return JSON.parse(JSON.stringify(show));
}

async function askToSave() {
  if (!dirty) return 'discard';
  const ans = await ask(`Save changes to “${show.name || 'Untitled Show'}”?`, 'Your changes will be lost if you don’t save them.', [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Don’t Save', value: 'discard' },
    { label: 'Save', value: 'save', cls: 'mi-btn-go' }
  ], 'cancel');
  if (ans === 'save') return (await saveShow(false)) ? 'saved' : 'cancel';
  return ans;
}

async function saveShow(saveAs) {
  let r;
  try {
    r = await bridge.saveShow(serializeShow(), saveAs ? null : showPath);
  } catch (err) {
    toast('Save failed: ' + cleanErr(err), 'err');
    return false;
  }
  if (!r || r.canceled) return false;
  if (r.error) { toast(r.error, 'err'); return false; }

  // Point the script at its copy in the show folder
  const map = r.pathMap || {};
  const pdf = show.document.type === 'script' ? show.document.pdf : null;
  if (pdf && map[pdf.path]) pdf.path = map[pdf.path];

  const moved = showPath !== r.showPath;
  showPath = r.showPath;
  show.name = stripExt(baseName(showPath));
  dirty = false;
  timingAfterSave();      // the file has the session times now (timing.js)
  if (moved && show.mikast) mikastStart();   // the MiKast file's path relative to the new show folder
  renderAll();
  if (r.missing && r.missing.length) {
    ask('Saved, but the script file was missing', 'This was not copied into the show folder:\n\n' + r.missing.join('\n'),
      [{ label: 'OK', value: 'ok' }], 'ok');
  } else {
    toast('Saved', 'ok');
  }
  const sb = document.getElementById('btnSave');
  sb.classList.add('flash');
  setTimeout(() => sb.classList.remove('flash'), 400);
  return true;
}

async function newShowCmd() {
  if ((await askToSave()) === 'cancel') return;
  show = newShow();
  showPath = null;
  dirty = false;
  resetHistory();
  standbyGoId = null; atEnd = false;
  sessionKindPick = null; msLogged.clear();      // timing.js: a new show asks again
  renderAll();
  loadDocument();
  mikastStart();                                 // no MiKast link in a new show
}

async function openShowCmd() {
  if ((await askToSave()) === 'cancel') return;
  let r;
  try { r = await bridge.openShow(); } catch (err) { toast('Open failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.canceled) return;
  if (r.error) { toast(r.error, 'err'); return; }

  show = normalizeShow(r.show, r.showPath);
  showPath = r.showPath;
  dirty = false;
  resetHistory();
  standbyGoId = null; atEnd = false;
  sessionKindPick = null; msLogged.clear();      // timing.js: a new show asks again
  if (r.converted) {
    markDirty();   // nothing is written until Save: then <Name>.mikallbook goes beside the old file
    toast(`Older show (.micallbook) opened. Save writes it as ${baseName(showPath)}; the old .micallbook file is kept.`, 'note');
  }
  renderAll();
  await loadDocument();
  if (r.missing && r.missing.length) {
    await ask('The script file is missing', 'This file could not be found:\n\n' + r.missing.join('\n') +
      '\n\nUse Locate PDF… to point MiKallbook at it again.', [{ label: 'OK', value: 'ok' }], 'ok');
  }
  await timingAfterOpen();   // session times logged here but never saved? (timing.js)
  mikastStart();             // read the linked MiKast production (mikast-link.js)
}

async function exitCmd() {
  const hadSession = typeof openSession === 'function' && !!openSession();
  if (!(await timingBeforeExit())) return;   // a session still running (timing.js)
  if (dirty) {
    if ((await askToSave()) === 'cancel') return;
  } else {
    // Nothing to save: still confirm, so a stray click can't end the show (same as MiKonsole).
    // The running-session question above already was that confirmation, unless operators follow.
    const n = linkRole === 'host' && hostInfo ? hostInfo.clients.length : 0;
    const ok = (hadSession && !n) ? true : await ask('Exit MiKallbook?', 'Are you sure you want to exit?' +
      (n ? `\n\n${n} operator computer${n === 1 ? ' is' : 's are'} following this show and will show LINK LOST.` : ''), [
      { label: 'Cancel', value: false },
      { label: 'Exit', value: true, cls: 'mi-btn-exit' }
    ], false);
    if (!ok) return;
  }
  bridge.quit();
}

// ── Mode ──────────────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  document.body.classList.toggle('show-mode', m === 'show');
  document.body.classList.toggle('operator-mode', m === 'operator');
  document.body.classList.toggle('edit-mode', m === 'edit');
  document.getElementById('btnEditMode').classList.toggle('on', m === 'edit');
  document.getElementById('btnShowMode').classList.toggle('on', m === 'show');
  document.getElementById('btnOpMode').classList.toggle('on', m === 'operator');
  if (m !== 'edit') {
    if (textEditorOpen) closeTextEditor();
    closePicker(); closeSidePanels(); cancelPlacing();
    if (selectedGoId) selectGo(null, false);
  }
  document.getElementById('listLabel').textContent = m === 'edit' ? 'GO points' : 'Running order';
  onModeChanged();
  if (m === 'operator') renderOperator();
}

// ── Modal + toasts ────────────────────────────────────────────────────
let modalResolve = null;
let modalCancel = null;

// extra: an element shown between the text and the buttons (e.g. a dropdown)
function ask(message, detail, buttons, cancelValue, extra) {
  return new Promise(resolve => {
    document.getElementById('modalMsg').textContent = message;
    document.getElementById('modalDetail').textContent = detail || '';
    const ex = document.getElementById('modalExtra');
    ex.innerHTML = '';
    if (extra) ex.appendChild(extra);
    ex.classList.toggle('hidden', !extra);
    const box = document.getElementById('modalBtns');
    box.innerHTML = '';
    buttons.forEach((b, i) => {
      const el = document.createElement('button');
      el.className = 'mi-btn ' + (b.cls || '');
      if (b.cls === 'mi-btn-go') el.style.padding = '9px 18px';
      el.textContent = b.label;
      el.addEventListener('click', () => closeModal(b.value));
      box.appendChild(el);
      if (i === buttons.length - 1) setTimeout(() => el.focus(), 0);
    });
    modalResolve = resolve;
    modalCancel = cancelValue;
    document.getElementById('modalOverlay').classList.add('open');
  });
}
function closeModal(value) {
  document.getElementById('modalOverlay').classList.remove('open');
  const r = modalResolve;
  modalResolve = null;
  if (r) r(value);
}
function modalOpen() { return !!modalResolve; }

function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' || kind === 'note' ? 6000 : 2500);   // note: plain look, stays longer
}

// ── Wiring ────────────────────────────────────────────────────────────
document.getElementById('btnEditMode').addEventListener('click', () => setMode('edit'));
// Show mode asks whether GO drives MiKonsole / MiKue (drive.js)
document.getElementById('btnShowMode').addEventListener('click', () => enterShowMode());
document.getElementById('btnOpMode').addEventListener('click', () => setMode('operator'));
document.getElementById('btnNew').addEventListener('click', newShowCmd);
document.getElementById('btnOpen').addEventListener('click', openShowCmd);
document.getElementById('btnSave').addEventListener('click', () => saveShow(false));
document.getElementById('btnSaveAs').addEventListener('click', () => saveShow(true));
document.getElementById('btnExit').addEventListener('click', exitCmd);

document.getElementById('btnImportPdf').addEventListener('click', importPdfCmd);
document.getElementById('btnEmptyImport').addEventListener('click', importPdfCmd);
document.getElementById('btnPasteText').addEventListener('click', pasteTextCmd);
document.getElementById('btnEmptyPaste').addEventListener('click', pasteTextCmd);
document.getElementById('btnTextCancel').addEventListener('click', cancelTextEditor);
document.getElementById('btnTextUse').addEventListener('click', useText);
document.getElementById('textInput').addEventListener('input', updateTextStats);
document.getElementById('btnRejoin').addEventListener('click', rejoinCmd);
document.getElementById('upcomingList').addEventListener('click', e => {
  const row = e.target.closest('.go-row');
  if (!row) return;
  if (mode === 'show') setStandby(row.dataset.id);   // jump the calling position there, nothing fires
  else selectGo(row.dataset.id, true);
});
document.getElementById('textInput').addEventListener('paste', onTextPaste);
document.getElementById('chkScriptLayout').addEventListener('change', updateTextStats);
document.getElementById('btnLocatePdf').addEventListener('click', () => { if (mode === 'edit') pickPdfInto(); });
document.getElementById('btnPrevPage').addEventListener('click', () => view.step(-1));
document.getElementById('btnNextPage').addEventListener('click', () => view.step(1));
document.getElementById('btnZoomOut').addEventListener('click', () => { view.zoomBy(1 / 1.15); viewPrefs.zoom = view.zoom; saveViewPrefs(); });
document.getElementById('btnZoomIn').addEventListener('click', () => { view.zoomBy(1.15); viewPrefs.zoom = view.zoom; saveViewPrefs(); });
document.getElementById('btnFitW').addEventListener('click', () => setZoom('fit'));
document.getElementById('btnFitP').addEventListener('click', () => setZoom('page'));
document.getElementById('btnOnePage').addEventListener('click', () => setSpread(false));
document.getElementById('btnTwoPage').addEventListener('click', () => setSpread(true));
document.getElementById('btnPaper').addEventListener('click', () => setDark(false));
document.getElementById('btnDark').addEventListener('click', () => setDark(true));
document.getElementById('btnFollow').addEventListener('click', () => setFollow(viewPrefs.follow === false));
document.getElementById('contrastRange').addEventListener('input', e => {
  viewPrefs.contrast = Number(e.target.value) || 1;
  saveViewPrefs();
  applyViewPrefs();
});
const pageInput = document.getElementById('pageInput');
pageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const n = parseInt(pageInput.value, 10);
    if (Number.isFinite(n)) view.goToPage(n - 1);
    pageInput.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    pageInput.blur();
  }
});
pageInput.addEventListener('blur', () => renderPageInfo());
pageInput.addEventListener('focus', () => pageInput.select());

// Buttons give focus back after a click so Space will always mean GO
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b && !document.getElementById('modalOverlay').contains(b)) setTimeout(() => b.blur(), 0);
}, true);

// ── Utilities menu (header) ───────────────────────────────────────────
function utilMenuOpen() { return document.getElementById('utilWrap').classList.contains('open'); }
function setUtilMenu(open) {
  const w = document.getElementById('utilWrap');
  w.classList.toggle('open', !!open);
  document.getElementById('btnUtil').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    // What each item says about now
    const host = linkRole === 'host', client = linkRole === 'client';
    document.getElementById('miLinkHint').textContent = host ? `sharing · ${hostInfo ? hostInfo.clients.length : 0} following`
      : client ? (linkStatus === 'lost' ? 'LINK LOST' : 'following the SM') : 'share or follow';
    document.getElementById('miBoothHint').textContent = boothOpen ? 'open · click to close' : 'second monitor';
    document.getElementById('miMikastHint').textContent = mikastMenuHint();
    document.getElementById('miBooth').classList.toggle('on', boothOpen);
  }
}
document.getElementById('btnUtil').addEventListener('click', e => { e.stopPropagation(); setUtilMenu(!utilMenuOpen()); });
document.getElementById('utilMenu').addEventListener('click', e => { if (e.target.closest('.menu-item')) setUtilMenu(false); });
document.addEventListener('pointerdown', e => { if (utilMenuOpen() && !document.getElementById('utilWrap').contains(e.target)) setUtilMenu(false); }, true);
document.getElementById('miLink').addEventListener('click', () => openLinkDialog());
document.getElementById('miBooth').addEventListener('click', () => toggleBooth());
document.getElementById('miManual').addEventListener('click', () => bridge.openManual());

function isField(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file'].includes(el.type);
}

window.addEventListener('keydown', e => {
  if (e.key === 'F1') { e.preventDefault(); if (!e.repeat) bridge.openManual(); return; }
  if (modalOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(modalCancel); }
    return;
  }
  if (utilMenuOpen()) {
    setUtilMenu(false);                       // any key closes the menu; Esc does nothing more
    if (e.key === 'Escape') { e.preventDefault(); return; }
  }
  if (linkDialogIsOpen()) { linkDialogKey(e); return; }
  if (timingDialogIsOpen()) { timingDialogKey(e); return; }
  if (reportsDialogIsOpen()) { reportsDialogKey(e); return; }
  if (cueSheetsDialogIsOpen()) { cueSheetsDialogKey(e); return; }
  if (notesQrDialogIsOpen()) { notesQrDialogKey(e); return; }
  if (mikastDialogIsOpen()) { mikastDialogKey(e); return; }
  const ctrl = e.ctrlKey || e.metaKey;
  if (textEditorOpen) {
    if (e.key === 'Escape') { e.preventDefault(); cancelTextEditor(); }
    else if (ctrl && e.key === 'Enter') { e.preventDefault(); useText(); }
    else if (ctrl && ['s', 'o', 'n'].includes(e.key.toLowerCase())) e.preventDefault();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveShow(e.shiftKey); return; }
  if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openShowCmd(); return; }
  if (ctrl && e.key.toLowerCase() === 'n') { e.preventDefault(); newShowCmd(); return; }
  if (isField(e.target)) return;
  if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (mode === 'edit') undo(); return; }
  if (ctrl && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); if (mode === 'edit') redo(); return; }
  if (mode === 'edit' && (e.key === 'Delete' || e.key === 'Backspace') && selectedGoId) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape' && placing) { cancelPlacing(); return; }
  if (e.key === 'Escape' && selectedGoId) { selectGo(null, false); return; }
  if (e.key === 'PageDown') { e.preventDefault(); view.step(1); return; }
  if (e.key === 'PageUp')   { e.preventDefault(); view.step(-1); return; }
  if (e.key === 'Home' && ctrl) { e.preventDefault(); view.goToPage(0); return; }
  if (e.key === 'End' && ctrl)  { e.preventDefault(); view.goToPage(view.pageCount - 1); return; }
  if (e.code === 'Space') {
    e.preventDefault();                 // never re-click a focused button
    if (!e.repeat && isCalling()) go();
    return;
  }
  if (e.key === 'Backspace' && isCalling()) { e.preventDefault(); if (!e.repeat) back(); return; }
});

bridge.onCloseRequest(() => {
  if (modalOpen()) return;
  if (linkDialogIsOpen()) closeLinkDialog();
  if (timingDialogIsOpen()) closeTimingDialog();
  if (reportsDialogIsOpen()) closeReports();
  if (cueSheetsDialogIsOpen()) closeCueSheets();
  if (notesQrDialogIsOpen()) closeNotesQr();
  if (mikastDialogIsOpen()) closeMikastDialog();
  if (textEditorOpen) { cancelTextEditor(); return; }
  exitCmd();
});

// ── Start ─────────────────────────────────────────────────────────────
initMarks();
initPanels();
initCalling();
initOperator();
initLink();
initCueLists();
initDrive();
initTiming();
initReports();
initNotes();
initCueSheets();
initRunningOrder();
initMikastLink();
trackScriptBar();
applyViewPrefs();
setMode('edit');
renderAll();
