'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: GO points on the script
   Drawing, placing (click + quick picker), selecting, moving, deleting,
   undo/redo, and the calling order.

   A GO point:
     { id, at, standby, warn, cues: [{ dept, number, via?, of?, typed?, mics? }], note, visual,
       needsCheck?, needsPlacing? }
   (dept '@ms' = a show milestone, see MS_DEPT; mics = mic groups, see micText)
   (via / of / typed: combo cues, see cuelists.js)
   at / standby / warn are anchors: { page, x, y } on a PDF (x/y 0..1 of
   the page) or { offset } into a text script. The viewer's source turns
   either into a page position (locate), so this file never cares which.

   Uses app.js globals: show, mode, view, markDirty, toast, uid.
   Loaded before app.js; app.js calls initMarks() once the viewer exists.
   ════════════════════════════════════════════════════════════════════ */

const TAB_H     = 28;      // px, tab height
const TAB_GAP   = 3;       // px between stacked tabs
const TAB_LEFT  = 8;       // px from the page edge into the gutter
const HISTORY_MAX = 200;
const GAP_PT    = 6.5;     // points above the word where the leader runs, when the script gives no better figure

let selectedGoId = null;

// ── Departments and cues ──────────────────────────────────────────────
function deptById(id) { return show.departments.find(d => d.id === id) || null; }
function deptColor(id) { if (id === MS_DEPT) return MS_COLOR; const d = deptById(id); return d ? d.color : '#a8a49a'; }
function cueText(c) {
  if (c.dept === MS_DEPT) return milestoneLabel(c.number).toUpperCase();     // ACT 1 UP (timing.js)
  const d = deptById(c.dept);
  return `${d ? d.code : '?'} ${c.number}`;
}

// ── Milestones as cues (Mike, 2026-10-18) ─────────────────────────────
// A GO point can carry one show milestone (House Open, Places, Act n Up /
// Down) as a cue of the pseudo-department MS_DEPT: { dept: '@ms', number: 'up1' }.
// GO in Show mode logs it in the session (timing.js timingOnGo). It shows
// wherever cues show (tabs, Standby, Booth View, lists, cue sheets), is
// never driven, and belongs to no department.
const MS_DEPT  = '@ms';
const MS_COLOR = '#5fe022';   // bright lime: a milestone-only GO's tab and arrow stand out on the cream page (Mike, 2026-10-18)
function isMsCue(c) { return !!c && c.dept === MS_DEPT; }
function goMilestone(gp) { const c = gp && gp.cues.find(isMsCue); return c ? c.number : null; }
// Set (key) or remove (null) a GO point's milestone; it always comes first
function setGoMilestone(gp, key) {
  gp.cues = gp.cues.filter(c => !isMsCue(c));
  if (key) gp.cues.unshift({ dept: MS_DEPT, number: key });
}
// <option>s for a milestone dropdown: none, House Open, Places, Act 1 Up … Act 5 Down
function milestoneOptions(sel) {
  const keys = milestoneKeys(MAX_ACTS);
  return `<option value=""${sel ? '' : ' selected'}>None</option>` +
    keys.map(k => `<option value="${k}"${k === sel ? ' selected' : ''}>${milestoneLabel(k)}</option>`).join('');
}
// The tab / leader color: the first department cue's, else the milestone's
function goColor(gp) {
  const c = gp.cues.find(x => !isMsCue(x)) || gp.cues[0];
  return c ? deptColor(c.dept) : '#c0b090';
}

// ── Mic cues (Mike, 2026-10-18) ───────────────────────────────────────
// A department with mics: true (MIC · Sound Board by default) is called by
// mic numbers: a cue holds groups { m: '4-8, 11', io: 'in' | 'out' } and its
// number is the text they make ("4–8, 11 IN, 2–3 OUT"), so everything that
// shows c.number shows the call.
function deptCallsMics(id) { const d = deptById(id); return !!(d && d.mics); }
function micListOk(m) {
  const parts = String(m || '').split(',').map(x => x.trim()).filter(Boolean);
  return parts.length > 0 && parts.every(x => /^\d{1,3}(\s*[-–]\s*\d{1,3})?$/.test(x));
}
function micListText(m) {
  return String(m || '').split(',').map(x => x.trim()).filter(Boolean)
    .map(x => x.replace(/\s*[-–]\s*/, '–')).join(', ');
}
function micText(groups) {
  return (groups || []).filter(g => micListText(g.m))
    .map(g => `${micListText(g.m)} ${g.io === 'out' ? 'OUT' : 'IN'}`).join(', ');
}
// Combo cues read "LX 1.5 / SQ 2" (displayCues in cuelists.js)
function goText(gp) { return gp.cues.length ? displayCues(gp).map(x => x.sep + cueText(x.c)).join('') : 'GO'; }

// Next free whole number for a department: LX 12 -> LX 13 (point cues like 12.5 count as 12)
function nextCueNumber(deptId) {
  let max = 0;
  for (const gp of show.goPoints) for (const c of gp.cues) {
    if (c.dept !== deptId || c.mics) continue;
    const n = parseFloat(c.number);
    if (Number.isFinite(n)) max = Math.max(max, Math.floor(n));
  }
  return String(max + 1);
}

// ── Calling order ─────────────────────────────────────────────────────
// Reading order: page, then top to bottom, then left to right.
// show.callOrder (a list of GO ids) overrides it once the stage manager
// moves a GO earlier or later. GO points added after that are slotted in
// after the GO that comes before them in reading order.
function goPos(gp) { return anchorPos(gp && gp.at); }
function anchorPos(a) {
  if (a && typeof a.item === 'string') return typeof roAnchorPos === 'function' ? roAnchorPos(a) : null;   // running order (runorder.js)
  if (!a || !view.source) return null;
  try { return view.source.locate(a); } catch (_) { return null; }
}
function readingOrder() {
  const withPos = show.goPoints.map(gp => ({ gp, p: goPos(gp) }));
  withPos.sort((a, b) => {
    if (!a.p && !b.p) return 0;
    if (!a.p) return 1;                 // unplaced at the end
    if (!b.p) return -1;
    return (a.p.page - b.p.page) || (a.p.y - b.p.y) || (a.p.x - b.p.x);
  });
  return withPos.map(x => x.gp);
}
function orderedGoPoints() {
  const reading = readingOrder();
  if (!Array.isArray(show.callOrder) || !show.callOrder.length) return reading;
  const byId = new Map(show.goPoints.map(g => [g.id, g]));
  const out = show.callOrder.map(id => byId.get(id)).filter(Boolean);
  const inOut = new Set(out.map(g => g.id));
  for (let i = 0; i < reading.length; i++) {
    const gp = reading[i];
    if (inOut.has(gp.id)) continue;
    // after the nearest earlier (in reading order) GO that is already placed in the list
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const j = out.findIndex(g => g.id === reading[k].id);
      if (j >= 0) { at = j + 1; break; }
    }
    out.splice(at, 0, gp);
    inOut.add(gp.id);
  }
  return out;
}
function isManualOrder() {
  if (!Array.isArray(show.callOrder) || !show.callOrder.length) return false;
  const a = orderedGoPoints().map(g => g.id).join(), b = readingOrder().map(g => g.id).join();
  return a !== b;
}
// Move a GO earlier (-1) or later (+1) in the calling order
function moveGo(id, dir) {
  const list = orderedGoPoints().map(g => g.id);
  const i = list.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return false;
  checkpoint();
  [list[i], list[j]] = [list[j], list[i]];
  show.callOrder = list;
  markDirty();
  renderMarks();
  return true;
}
function resetOrder() {
  if (!show.callOrder) return;
  checkpoint();
  show.callOrder = null;
  markDirty();
  renderMarks();
}

// ── Undo / redo ───────────────────────────────────────────────────────
// Whole-state snapshots of the marks, departments and calling order.
let undoStack = [];
let redoStack = [];
function snapshot() { return JSON.stringify({ goPoints: show.goPoints, departments: show.departments, callOrder: show.callOrder || null }); }
function checkpoint() {
  undoStack.push(snapshot());
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack = [];
}
// For typing in a field: take one snapshot when editing starts, and keep it
// only if something actually changed.
let pendingSnap = null;
function beginEdit() { pendingSnap = snapshot(); }
function endEdit() {
  if (pendingSnap && pendingSnap !== snapshot()) {
    undoStack.push(pendingSnap);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack = [];
  }
  pendingSnap = null;
}
function restore(snap) {
  const s = JSON.parse(snap);
  show.goPoints = s.goPoints;
  show.departments = s.departments;
  show.callOrder = s.callOrder || null;
  if (selectedGoId && !show.goPoints.some(g => g.id === selectedGoId)) selectedGoId = null;
  markDirty();
  renderMarks();
  if (typeof onMarksRestored === 'function') onMarksRestored();
}
function undo() {
  if (!undoStack.length) { toast('Nothing to undo.'); return; }
  redoStack.push(snapshot());
  restore(undoStack.pop());
}
function redo() {
  if (!redoStack.length) { toast('Nothing to redo.'); return; }
  undoStack.push(snapshot());
  restore(redoStack.pop());
}
function resetHistory() { undoStack = []; redoStack = []; pendingSnap = null; selectedGoId = null; closePicker(); cancelPlacing(); }

// ── Drawing ───────────────────────────────────────────────────────────
const SVG_NS = 'http://www.w3.org/2000/svg';
const SB_H = 22;   // px, Standby / Warn tab height

function renderMarks() {
  // Clear every page's layer
  for (const s of view.slots) s.layer.innerHTML = '';

  // Everything drawn in the margin, grouped by page: GO points plus their
  // Standby and Warn points (smaller, dashed, same color).
  const byPage = new Map();
  const add = (page, item) => { if (!byPage.has(page)) byPage.set(page, []); byPage.get(page).push(item); };
  for (const gp of show.goPoints) {
    for (const kind of ['at', 'standby', 'warn']) {
      const p = anchorPos(gp[kind]);
      if (!p || !view.slots[p.page]) continue;
      add(p.page, { gp, p, kind, hgt: kind === 'at' ? TAB_H : SB_H });
    }
  }

  for (const [pi, items] of byPage) {
    const s = view.slots[pi];
    const w = s.w, h = s.h;
    items.sort((a, b) => (a.p.y - b.p.y) || (a.p.x - b.p.x));

    // Stack tabs so they never overlap: each sits at its anchor's height
    // unless the one above pushes it down.
    let nextFree = -Infinity;
    for (const it of items) {
      const want = it.p.y * h - it.hgt / 2;
      it.tabY = Math.max(want, nextFree);
      nextFree = it.tabY + it.hgt + TAB_GAP;
    }
    // If the stack runs off the bottom, push it back up
    let over = (items.length ? items[items.length - 1].tabY + items[items.length - 1].hgt : 0) - h;
    for (let k = items.length - 1; k >= 0 && over > 0; k--) {
      items[k].tabY -= over;
      const above = k > 0 ? items[k - 1].tabY + items[k - 1].hgt + TAB_GAP : -Infinity;
      over = above - items[k].tabY;
    }

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'mk-lines');
    svg.setAttribute('width', String(w + MiScriptView.GUTTER));
    svg.setAttribute('height', String(h));
    s.layer.appendChild(svg);

    for (const it of items) {
      const gp = it.gp;
      const isGo = it.kind === 'at';
      const color = goColor(gp);
      const ax = it.p.x * w, ay = it.p.y * h;
      const tx = w + TAB_LEFT, ty = it.tabY + it.hgt / 2;
      const sel = gp.id === selectedGoId;

      // Leader, routed like a pencil bracket so it never strikes through
      // the marked line: tab -> down/up the page's right margin -> along
      // the gap just above the marked line -> short arrow down onto the word.
      const g = (it.p.gap || GAP_PT) * view.scale;        // anchor up to the clear space above the line, px
      const yRun = Math.max(2, ay - g);                   // between this line and the one above
      const xMargin = Math.max(ax + 6, w - 10);           // inside the page's right margin
      const tip = ay - g * 0.25;                          // top of the word
      const ah = Math.min(isGo ? 7 : 5, Math.max(4, g * 0.8));
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M ${tx} ${ty} L ${xMargin} ${ty} L ${xMargin} ${yRun} L ${ax} ${yRun} L ${ax} ${tip - ah}`);
      path.setAttribute('class', (isGo ? 'mk-line' : 'mk-line mk-sb') + (sel ? ' sel' : ''));
      path.dataset.id = gp.id;
      path.dataset.kind = it.kind;          // Show mode: Warn / Standby steps are called on their own (calling.js)
      path.setAttribute('stroke', color);
      svg.appendChild(path);
      const head = document.createElementNS(SVG_NS, 'polygon');
      head.setAttribute('points', `${ax},${tip} ${ax - ah * 0.6},${tip - ah} ${ax + ah * 0.6},${tip - ah}`);
      head.setAttribute('fill', color);
      head.setAttribute('class', isGo ? 'mk-head' : 'mk-head mk-sb');
      svg.appendChild(head);

      // Drag handle at the arrow tip (Edit mode)
      const dot = document.createElement('div');
      dot.className = 'mk-dot' + (isGo ? '' : ' small') + (sel ? ' sel' : '');
      dot.style.left = ax + 'px';
      dot.style.top = ay + 'px';
      dot.style.borderColor = color;
      dot.dataset.id = gp.id;
      dot.dataset.kind = it.kind;
      dot.title = isGo ? 'Drag to move the arrow' : `Drag to move the ${it.kind === 'standby' ? 'Standby' : 'Warn'} point`;
      s.layer.appendChild(dot);

      // Tab
      const tab = document.createElement('div');
      tab.style.left = tx + 'px';
      tab.style.top = it.tabY + 'px';
      tab.style.borderLeftColor = color;
      tab.dataset.id = gp.id;
      tab.dataset.kind = it.kind;
      if (isGo) {
        tab.className = 'mk-tab' + (sel ? ' sel' : '') + (gp.needsCheck ? ' check' : '') + (gp.visual ? ' visual' : '');
        const missing = gp.cues.filter(c => cueSource(c).state === 'missing');
        tab.title = goText(gp) + (gp.note ? '\n' + gp.note : '') +
          (gp.needsCheck ? '\nThe words at this mark were edited: check its position.' : '') +
          missing.map(c => `\n${cueText(c)}: ${cueSource(c).text}`).join('') +
          (typeof micWhoLines === 'function' ? micWhoLines(gp.cues).map(t => '\n' + t).join('') : '');   // mic names from MiKast
        if (!gp.cues.length) tab.innerHTML = '<span class="mk-cue">GO</span>';
        for (const { c, sep } of displayCues(gp)) {
          if (sep === ' / ') {
            const sl = document.createElement('span');
            sl.className = 'mk-slash';
            sl.textContent = '/';
            tab.appendChild(sl);
          }
          const span = document.createElement('span');
          span.className = 'mk-cue' + (missing.includes(c) ? ' missing' : '') + (isMsCue(c) ? ' ms' : '');
          span.style.color = deptColor(c.dept);
          span.textContent = cueText(c);
          tab.appendChild(span);
        }
        if (gp.visual) {
          const v = document.createElement('span');
          v.className = 'mk-vis';
          v.textContent = 'VIS';
          v.title = 'Called on visual';
          tab.appendChild(v);
        }
      } else {
        tab.className = 'mk-tab mk-sbtab' + (sel ? ' sel' : '');
        const label = it.kind === 'standby' ? 'SB' : 'W';
        tab.title = `${it.kind === 'standby' ? 'Standby' : 'Warn'}: ${goText(gp)}` +
          (typeof micWhoLines === 'function' ? micWhoLines(gp.cues).map(t => '\n' + t).join('') : '');
        const k = document.createElement('span');
        k.className = 'mk-sbk';
        k.textContent = label;
        const c = document.createElement('span');
        c.className = 'mk-cue';
        c.style.color = color;
        c.textContent = goText(gp);
        tab.append(k, c);
      }
      s.layer.appendChild(tab);
    }
  }
  renderCalling();
  if (typeof onMarksRendered === 'function') onMarksRendered();
  if (typeof renderLiveStatus === 'function') renderLiveStatus();
}

// ── Placing Standby / Warn / an unplaced GO ───────────────────────────
// placing = { id, kind: 'at' | 'standby' | 'warn' }: the next click on the
// script sets that point instead of opening the picker.
let placing = null;
function startPlacing(id, kind) {
  closePicker();
  placing = { id, kind };
  document.body.classList.add('placing');
  const gp = show.goPoints.find(g => g.id === id);
  const what = kind === 'standby' ? 'the Standby point' : kind === 'warn' ? 'the Warn point' : 'this GO point';
  showPlacingBanner(`Click the script to place ${what} for ${gp ? goText(gp) : 'the GO'}. Esc cancels.`);
}
function cancelPlacing() {
  if (!placing) return;
  placing = null;
  document.body.classList.remove('placing');
  showPlacingBanner(null);
}
function finishPlacing(anchor) {
  const gp = show.goPoints.find(g => g.id === placing.id);
  const kind = placing.kind;
  cancelPlacing();
  if (!gp) return;
  checkpoint();
  gp[kind] = anchor;
  if (kind === 'at') { gp.needsPlacing = false; gp.needsCheck = false; }
  markDirty();
  renderMarks();
  if (typeof onMarksRestored === 'function') onMarksRestored();   // refresh the inspector
}
function showPlacingBanner(text) {
  let b = document.getElementById('placingBanner');
  if (!text) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('div');
    b.id = 'placingBanner';
    b.className = 'placing-banner';
    document.getElementById('scriptWrap').appendChild(b);
  }
  b.textContent = text;
}

// ── Selecting ─────────────────────────────────────────────────────────
// Only classes change, so the tab under the mouse stays the same element
// (a double-click needs both clicks to land on it).
function selectGo(id, scroll) {
  selectedGoId = id;
  view.pagesEl.querySelectorAll('.mk-tab, .mk-dot, .mk-line').forEach(el => {
    el.classList.toggle('sel', !!id && el.dataset.id === id);
  });
  renderCalling();
  if (typeof onSelectionChanged === 'function') onSelectionChanged();
  if (scroll && id) scrollToGo(id);
}

function scrollToGo(id) {
  if (typeof isRO === 'function' && isRO()) { roScrollToGo(id); return; }
  const gp = show.goPoints.find(g => g.id === id);
  const p = gp && goPos(gp);
  if (!p || !view.slots[p.page]) return;
  const s = view.slots[p.page];
  const top = s.slot.parentElement.offsetTop + p.y * s.h;
  view.el.scrollTop = Math.max(0, top - view.el.clientHeight * 0.35);
}

function deleteSelected() {
  if (mode !== 'edit' || !selectedGoId) return;
  const i = show.goPoints.findIndex(g => g.id === selectedGoId);
  if (i < 0) return;
  checkpoint();
  const gone = show.goPoints.splice(i, 1)[0];
  if (Array.isArray(show.callOrder)) show.callOrder = show.callOrder.filter(x => x !== gone.id);
  selectedGoId = null;
  if (typeof onSelectionChanged === 'function') onSelectionChanged();
  markDirty();
  renderMarks();
  toast(`Deleted ${goText(gone)} (Ctrl+Z to undo)`);
}

// ── Quick picker ──────────────────────────────────────────────────────
// Opens at the click. Pick a department, check the number, Enter to place.
// "+ Add" keeps this cue and starts another for a combined GO.
const picker = { el: null, anchor: null, editId: null, cues: [], dept: null, ms: null, mics: [] };
let lastDept = null;

function openPicker(clientX, clientY, anchor, editGp) {
  closePicker();
  picker.anchor = anchor;
  picker.editId = editGp ? editGp.id : null;
  // combo cues follow MiKue; the milestone has its own dropdown
  picker.cues = editGp ? editGp.cues.filter(c => !c.via && !isMsCue(c)).map(c => ({ ...c, mics: c.mics ? c.mics.map(g => ({ ...g })) : undefined })) : [];
  picker.cues.forEach(c => { if (!c.mics) delete c.mics; });
  picker.ms = editGp ? goMilestone(editGp) : null;
  picker.mics = [{ m: '', io: 'in' }];
  picker.dept = (lastDept && deptById(lastDept)) ? lastDept : (show.departments[0] && show.departments[0].id);

  const el = document.createElement('div');
  el.className = 'mk-picker';
  el.innerHTML = `
    <div class="pk-head">${editGp ? 'Edit GO point' : 'New GO point'}</div>
    <div class="pk-cues"></div>
    <div class="pk-depts"></div>
    <div class="pk-row pk-cuerow">
      <span class="mi-label pk-cuelabel">Cue</span>
      <input class="mi-input pk-num" spellcheck="false" maxlength="8" autocomplete="off">
      <div class="pk-mics hidden"></div>
      <button class="mi-btn pk-add" title="Add this cue and start another for the same GO">+ Add</button>
    </div>
    <div class="pk-src"></div>
    <div class="pk-list mi-scroll"></div>
    <div class="pk-row pk-ms">
      <span class="mi-label">Milestone</span>
      <select class="mi-select pk-msel" title="Logged in the session when this GO is called in Show mode">${milestoneOptions(picker.ms)}</select>
    </div>
    <div class="pk-row pk-foot">
      <span class="pk-keys">Enter = ${editGp ? 'Save' : 'Place'} · Esc = Cancel</span>
      <div class="tb-fill"></div>
      <button class="mi-btn pk-cancel">Cancel</button>
      <button class="mi-btn mi-btn-go pk-ok">${editGp ? 'Save' : 'Place'}</button>
    </div>`;
  document.body.appendChild(el);
  picker.el = el;

  const depts = el.querySelector('.pk-depts');
  for (const d of show.departments) {
    const b = document.createElement('button');
    b.className = 'pk-dept';
    b.dataset.id = d.id;
    b.textContent = d.code;
    b.title = d.name;
    b.style.setProperty('--dc', d.color);
    b.addEventListener('click', () => { pickDept(d.id); });
    depts.appendChild(b);
  }
  el.querySelector('.pk-add').addEventListener('click', () => { addPickerCue(); });
  el.querySelector('.pk-cancel').addEventListener('click', closePicker);
  el.querySelector('.pk-ok').addEventListener('click', commitPicker);
  const num = el.querySelector('.pk-num');
  num.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitPicker(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); cycleDept(1); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleDept(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); stepPickerList(e.key === 'ArrowDown' ? 1 : -1); }
  });
  num.addEventListener('input', updatePickerSource);
  const msel = el.querySelector('.pk-msel');
  msel.addEventListener('change', () => { picker.ms = msel.value || null; });
  msel.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitPicker(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
  });
  // Mic groups (departments called by mic numbers)
  const mics = el.querySelector('.pk-mics');
  mics.addEventListener('input', e => {
    const inp = e.target.closest('.pk-mic');
    if (inp) picker.mics[Number(inp.dataset.g)].m = inp.value;
  });
  mics.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const g = Number(b.dataset.g);
    if (b.classList.contains('pk-io')) {
      picker.mics[g].io = picker.mics[g].io === 'in' ? 'out' : 'in';
      renderPickerMics(g);
    } else if (b.classList.contains('pk-mic-del')) {
      picker.mics.splice(g, 1);
      if (!picker.mics.length) picker.mics.push({ m: '', io: 'in' });
      renderPickerMics(Math.max(0, g - 1));
    } else if (b.classList.contains('pk-mic-add')) {
      picker.mics.push({ m: '', io: picker.mics.length ? (picker.mics[picker.mics.length - 1].io === 'in' ? 'out' : 'in') : 'in' });
      renderPickerMics(picker.mics.length - 1);
    }
  });
  mics.addEventListener('keydown', e => {
    if (!e.target.classList.contains('pk-mic')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commitPicker(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePicker(); }
  });
  el.querySelector('.pk-list').addEventListener('click', e => {
    const row = e.target.closest('.pk-item');
    if (!row) return;
    num.value = row.dataset.v;
    updatePickerSource();
    num.focus(); num.select();
  });
  el.addEventListener('pointerdown', e => e.stopPropagation());

  pickDept(picker.dept, true);
  renderPickerCues();

  // Place it next to the click, kept on screen
  const r = el.getBoundingClientRect();
  let x = clientX + 14, y = clientY - 20;
  if (x + r.width > window.innerWidth - 10) x = clientX - r.width - 14;
  if (y + r.height > window.innerHeight - 10) y = window.innerHeight - r.height - 10;
  el.style.left = Math.max(10, x) + 'px';
  el.style.top = Math.max(10, y) + 'px';
  setTimeout(() => { num.focus(); num.select(); }, 0);
}

function pickDept(id, keepNumber) {
  if (!picker.el || !id) return;
  picker.dept = id;
  picker.el.querySelectorAll('.pk-dept').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  const num = picker.el.querySelector('.pk-num');
  const micMode = deptCallsMics(id);
  picker.el.classList.toggle('mic-mode', micMode);
  picker.el.querySelector('.pk-cuelabel').textContent = micMode ? 'Mics' : 'Cue';
  num.classList.toggle('hidden', micMode);
  picker.el.querySelector('.pk-mics').classList.toggle('hidden', !micMode);
  if (micMode) {
    num.value = '';
    renderPickerMics(0);
    updatePickerSource();
    return;
  }
  if (!keepNumber || !num.value) num.value = suggestNumber(id);
  updatePickerSource();
  num.focus(); num.select();
}

// The mic groups editor: [4-8, 11] [IN] ×  …  + In/Out group
function renderPickerMics(focusG) {
  if (!picker.el) return;
  const box = picker.el.querySelector('.pk-mics');
  box.innerHTML = picker.mics.map((g, i) => `
    <div class="pk-microw">
      <input class="mi-input pk-mic" data-g="${i}" value="${esc(g.m)}" placeholder="4-8, 11" spellcheck="false" autocomplete="off" maxlength="40">
      <button class="mi-btn pk-io ${g.io}" data-g="${i}" title="Click to switch In / Out">${g.io === 'out' ? 'OUT' : 'IN'}</button>
      <button class="pk-x pk-mic-del" data-g="${i}" title="Remove this group">×</button>
    </div>`).join('') +
    '<button class="mi-btn pk-mic-add" title="Another group on the same call, e.g. 2-3 OUT">+ Group</button>';
  if (focusG != null) {
    const inp = box.querySelector(`.pk-mic[data-g="${focusG}"]`) || box.querySelector('.pk-mic');
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }
}

// Under the number: what that cue is in MiKonsole / MiKue, and that app's
// cue list to pick from (click, or ↑ ↓ to step through it)
function pickerItems() {
  const t = deptTarget(picker.dept);
  if (!liveAvailable(t)) return [];
  if (t === 'mikonsole') return live.mikonsole.cues.filter(c => c.num !== null).map(c => ({ v: fmtNum(c.num), t: c.label }));
  return live.micue.cues.map(c => {
    const f = micueFires(c.number);
    return { v: c.number, t: c.name + (f && f.length ? `  → LX ${f.join(', ')}` : '') };
  });
}
function updatePickerSource() {
  if (!picker.el) return;
  const num = picker.el.querySelector('.pk-num');
  const out = picker.el.querySelector('.pk-src');
  const v = num.value.trim();
  const src = v ? cueSource({ dept: picker.dept, number: v }) : { state: 'none', text: '' };
  out.textContent = src.text;
  out.className = 'pk-src ' + src.state;

  const box = picker.el.querySelector('.pk-list');
  const items = pickerItems();
  const html = items.map(it => `<div class="pk-item${v && sameNum(it.v, v) ? ' on' : ''}" data-v="${esc(it.v)}"><span class="pk-iv">${esc(it.v)}</span><span class="pk-it">${esc(it.t)}</span></div>`).join('');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
  box.classList.toggle('hidden', !items.length);
  const on = box.querySelector('.pk-item.on');
  if (on) {
    const top = on.offsetTop, bottom = top + on.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
  }
}
// ↑ ↓ in the number field: the previous / next cue in the list
function stepPickerList(dir) {
  const items = pickerItems();
  if (!items.length) return;
  const num = picker.el.querySelector('.pk-num');
  const v = num.value.trim();
  const i = items.findIndex(it => sameNum(it.v, v));
  let j;
  if (i >= 0) j = Math.max(0, Math.min(items.length - 1, i + dir));
  else {
    // not in the list: the nearest one above / below what's typed
    const f = parseFloat(v);
    if (!Number.isFinite(f)) j = dir > 0 ? 0 : items.length - 1;
    else if (dir > 0) { const k = items.findIndex(it => parseFloat(it.v) > f); j = k < 0 ? items.length - 1 : k; }
    else { let k = -1; items.forEach((it, x) => { if (parseFloat(it.v) < f) k = x; }); j = k < 0 ? 0 : k; }
  }
  num.value = items[j].v;
  updatePickerSource();
  num.select();
}

// Next number, also counting cues already added in this picker
function suggestNumber(deptId) {
  let n = parseInt(nextCueNumber(deptId), 10);
  for (const c of picker.cues) if (c.dept === deptId) {
    const v = parseFloat(c.number);
    if (Number.isFinite(v)) n = Math.max(n, Math.floor(v) + 1);
  }
  return String(n);
}

function cycleDept(dir) {
  const ids = show.departments.map(d => d.id);
  if (!ids.length) return;
  const i = Math.max(0, ids.indexOf(picker.dept));
  pickDept(ids[(i + dir + ids.length) % ids.length]);
}

function addPickerCue() {
  if (deptCallsMics(picker.dept)) return addPickerMicCue();
  const num = picker.el.querySelector('.pk-num');
  const v = num.value.trim();
  if (!v) { num.focus(); return false; }
  if (picker.cues.some(c => c.dept === picker.dept && c.number === v)) {
    toast(`${cueText({ dept: picker.dept, number: v })} is already in this GO.`, 'err');
    return false;
  }
  picker.cues.push({ dept: picker.dept, number: v });
  lastDept = picker.dept;
  num.value = suggestNumber(picker.dept);
  renderPickerCues();
  updatePickerSource();
  num.focus(); num.select();
  return true;
}

// Mic groups typed in the picker → one MIC cue
function pickerMicsTyped() { return picker.mics.some(g => g.m.trim()); }
function addPickerMicCue() {
  const groups = picker.mics.filter(g => g.m.trim());
  if (!groups.length) { renderPickerMics(0); return false; }
  const bad = groups.find(g => !micListOk(g.m));
  if (bad) {
    toast(`“${bad.m.trim()}”: mic numbers like 4-8, 11`, 'err');
    renderPickerMics(picker.mics.indexOf(bad));
    return false;
  }
  const mics = groups.map(g => ({ m: micListText(g.m), io: g.io === 'out' ? 'out' : 'in' }));
  const number = micText(mics);
  if (picker.cues.some(c => c.dept === picker.dept && c.number === number)) {
    toast(`${cueText({ dept: picker.dept, number })} is already in this GO.`, 'err');
    return false;
  }
  picker.cues.push({ dept: picker.dept, number, mics });
  lastDept = picker.dept;
  picker.mics = [{ m: '', io: 'in' }];
  renderPickerCues();
  renderPickerMics(0);
  return true;
}

function renderPickerCues() {
  const box = picker.el.querySelector('.pk-cues');
  box.innerHTML = '';
  if (!picker.cues.length) { box.classList.add('empty'); return; }
  box.classList.remove('empty');
  picker.cues.forEach((c, i) => {
    const chip = document.createElement('span');
    chip.className = 'pk-chip';
    chip.style.color = deptColor(c.dept);
    chip.textContent = cueText(c);
    const x = document.createElement('button');
    x.className = 'pk-x';
    x.textContent = '×';
    x.title = 'Remove';
    x.addEventListener('click', () => { picker.cues.splice(i, 1); renderPickerCues(); });
    chip.appendChild(x);
    box.appendChild(chip);
  });
}

function commitPicker() {
  if (!picker.el) return;
  const num = picker.el.querySelector('.pk-num');
  // The cue being typed counts, unless it is empty and others were added
  const typing = deptCallsMics(picker.dept) ? pickerMicsTyped() : !!num.value.trim();
  if (typing) { if (!addPickerCue()) return; }
  if (!picker.cues.length && !picker.ms) {
    toast('Give the GO point at least one cue or a milestone.', 'err');
    if (deptCallsMics(picker.dept)) renderPickerMics(0); else num.focus();
    return;
  }
  // One GO point per milestone: moving it here takes it off the other
  const other = picker.ms ? show.goPoints.find(g => g.id !== picker.editId && goMilestone(g) === picker.ms) : null;
  checkpoint();
  if (other) {
    setGoMilestone(other, null);
    toast(`${milestoneLabel(picker.ms)} moved here from GO ${orderedGoPoints().indexOf(other) + 1}`, 'ok');
  }
  if (picker.editId) {
    const gp = show.goPoints.find(g => g.id === picker.editId);
    if (gp) {
      // keep the combo cues; syncCombos drops any whose MiKue cue was removed
      gp.cues = picker.cues.slice().concat(gp.cues.filter(c => c.via));
      setGoMilestone(gp, picker.ms);
      syncCombos(gp);
    }
  } else {
    const gp = { id: uid(), at: picker.anchor, standby: null, warn: null, cues: picker.cues.slice(), note: '', visual: false };
    setGoMilestone(gp, picker.ms);
    syncCombos(gp);
    show.goPoints.push(gp);
    selectedGoId = gp.id;
  }
  markDirty();
  closePicker();
  renderMarks();
}

function closePicker() {
  if (picker.el) picker.el.remove();
  picker.el = null;
  picker.anchor = null;
  picker.editId = null;
  picker.cues = [];
  picker.ms = null;
  picker.mics = [];
}
function pickerOpen() { return !!picker.el; }

// ── Mouse: place, select, move ────────────────────────────────────────
function pageHit(e) {
  const slot = e.target.closest && e.target.closest('.page-slot');
  if (!slot) return null;
  const i = Number(slot.dataset.page);
  const s = view.slots[i];
  if (!s) return null;
  const r = s.page.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;   // in the gutter, not on the page
  return { page: i, x, y };
}

let drag = null;          // { id, moved, el }
let swallowClick = false; // the click that follows closing the picker or a drag

function initMarks() {
view.pagesEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  swallowClick = false;
  if (pickerOpen()) { closePicker(); swallowClick = true; e.preventDefault(); return; }   // a click away just closes the picker

  const tab = e.target.closest('.mk-tab');
  if (tab && mode === 'show') { setStandbyStep(tab.dataset.id, tab.dataset.kind, false); e.preventDefault(); return; }   // nothing fires (a W / SB tab: that step)
  if (tab && !placing) { selectGo(tab.dataset.id, false); e.preventDefault(); return; }

  const dot = e.target.closest('.mk-dot');
  if (dot && mode === 'edit' && !placing) {
    e.preventDefault();
    selectGo(dot.dataset.id, false);
    drag = { id: dot.dataset.id, kind: dot.dataset.kind || 'at', moved: false, el: dot };
    document.body.classList.add('dragging-mark');     // the inspector steps aside while dragging
    swallowClick = true;
    dot.setPointerCapture(e.pointerId);
    return;
  }
});

view.pagesEl.addEventListener('pointermove', e => {
  if (!drag) return;
  const hit = pageHit({ target: document.elementFromPoint(e.clientX, e.clientY) || drag.el, clientX: e.clientX, clientY: e.clientY });
  if (!hit) return;
  const gp = show.goPoints.find(g => g.id === drag.id);
  if (!gp) return;
  if (!drag.moved) { checkpoint(); drag.moved = true; }
  gp[drag.kind] = view.source.anchorAt(hit.page, hit.x, hit.y);
  if (drag.kind === 'at') gp.needsCheck = false;
  renderMarks();
  // keep dragging the freshly drawn dot
  const fresh = view.pagesEl.querySelector(`.mk-dot[data-id="${drag.id}"][data-kind="${drag.kind}"]`);
  if (fresh) { drag.el = fresh; fresh.classList.add('dragging'); }
});

const endDrag = () => {
  document.body.classList.remove('dragging-mark');
  if (!drag) return;
  if (drag.moved) markDirty();
  drag = null;
  renderMarks();
};
view.pagesEl.addEventListener('pointerup', endDrag);
view.pagesEl.addEventListener('pointercancel', endDrag);
// The dragged dot is redrawn as it moves, so the release can land outside the
// script (calling column, inspector edge): end the drag wherever it happens
window.addEventListener('pointerup', endDrag);

view.pagesEl.addEventListener('click', e => {
  if (swallowClick) { swallowClick = false; return; }
  if (mode !== 'edit' || drag) return;
  if (placing) {
    const ph = pageHit(e);
    if (ph && view.source) finishPlacing(view.source.anchorAt(ph.page, ph.x, ph.y));
    return;
  }
  if (e.target.closest('.mk-tab') || e.target.closest('.mk-dot')) return;
  const hit = pageHit(e);
  if (!hit || !view.source) return;
  selectGo(null, false);
  openPicker(e.clientX, e.clientY, view.source.anchorAt(hit.page, hit.x, hit.y), null);
});

view.pagesEl.addEventListener('dblclick', e => {
  const tab = e.target.closest('.mk-tab');
  if (!tab || mode !== 'edit' || placing || tab.classList.contains('mk-sbtab')) return;
  const gp = show.goPoints.find(g => g.id === tab.dataset.id);
  if (gp) openPicker(e.clientX, e.clientY, gp.at, gp);
});

// A click anywhere outside the picker closes it
document.addEventListener('pointerdown', e => {
  if (pickerOpen() && !picker.el.contains(e.target) && !view.pagesEl.contains(e.target)) closePicker();
}, true);

// Scrolling the script moves the page away from the picker: close it
view.el.addEventListener('scroll', () => { if (pickerOpen()) closePicker(); }, { passive: true });
}
