'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: concert running order (Phase 5)
   For choir and concert programs: instead of a script, the show's
   document is a running order (show.document.type = 'runningOrder'),
   a list of items:

     { id, type: song|speech|transition|risers|intermission|other,
       title, length: 'm:ss' (estimate), performers, lines }

   lines = optional cue lines / lyrics, one per line.

   GO points belong to an item: gp.at = { item: <item id>, line: null |
   '<one of the item's lines>' }. The calling order is item order, then
   the start of the item before its lines, top to bottom (moving a GO by
   hand still works). Everything else (Show mode calling, DRIVE, Operator
   mode, Booth View, Link, cue sheets, reports, notes) works unchanged:
   anchorPos() (marks.js) asks roAnchorPos() for these anchors.

   The script column shows the list (#roView) instead of pages. Edit mode:
   type, title, length, performers and lines are edited in place, ▲ ▼ ✕,
   + Add Item, and + GO on each item (the quick picker). Show mode: the
   standby GO's item is highlighted and kept in view, called GOs dim.

   Print / Save PDF: the running order for performers, or with the cues
   for the crew.
   ════════════════════════════════════════════════════════════════════ */

const RO_TYPES = [
  ['song', 'Song'], ['speech', 'Speech'], ['transition', 'Transition'],
  ['risers', 'Riser move'], ['intermission', 'Intermission'], ['other', 'Other']
];
const RO_TYPE_KEYS = RO_TYPES.map(t => t[0]);
const RO_CUES_KEY = 'micallbook.roPrintCues';

let roSig = '';
let roPrintCues = true;
try { roPrintCues = localStorage.getItem(RO_CUES_KEY) !== '0'; } catch (_) {}

function isRO() { return show.document.type === 'runningOrder'; }
function roItems() { return isRO() && Array.isArray(show.document.items) ? show.document.items : []; }
function roItem(id) { return roItems().find(it => it.id === id) || null; }
function roTypeLabel(t) { const x = RO_TYPES.find(r => r[0] === t); return x ? x[1] : 'Other'; }

function normalizeRoItem(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    id: typeof r.id === 'string' && r.id ? r.id : uid(),
    type: RO_TYPE_KEYS.includes(r.type) ? r.type : 'song',
    title: String(r.title || ''),
    length: String(r.length || ''),
    performers: String(r.performers || ''),
    lines: String(r.lines || '')
  };
}

function roLines(it) { return String(it.lines || '').split('\n').map(s => s.trim()).filter(Boolean); }

// Position of a running-order anchor for sorting and labels: page = item
// index (shown as "item n"), y = 0 for the start of the item, else its line
function roAnchorPos(a) {
  if (!a || typeof a.item !== 'string' || !isRO()) return null;
  const i = roItems().findIndex(it => it.id === a.item);
  if (i < 0) return null;
  let y = 0, missing = false;
  if (a.line) {
    const li = roLines(roItems()[i]).indexOf(String(a.line).trim());
    y = li >= 0 ? li + 1 : 999;
    missing = li < 0;
  }
  return { page: i, x: 0, y, ro: true, missing };
}

// "page 3" / "p.3" for scripts, "item 3" / "#3" for a running order
function posLabel(p, short) {
  if (!p) return '';
  if (p.ro) return short ? `#${p.page + 1}` : `item ${p.page + 1}`;
  return short ? `p.${p.page + 1}` : `page ${p.page + 1}`;
}

// m:ss / h:mm:ss / plain minutes -> seconds (null = empty or unreadable)
function parseLength(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 60);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  return (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]);
}
function fmtSecs(n) { return fmtDur(n * 1000); }

// Running totals: each item's start (from the first item) and the total
function roTimes() {
  let t = 0, unknown = 0;
  const starts = roItems().map(it => {
    const s = t;
    const len = parseLength(it.length);
    if (len === null) unknown++; else t += len;
    return s;
  });
  return { starts, total: t, unknown };
}

// GO points of an item, in calling order
function roGoPointsOf(itemId) {
  return orderedGoPoints().filter(gp => gp.at && gp.at.item === itemId);
}

// ── Starting a running order ──────────────────────────────────────────
async function newRunningOrderCmd() {
  if (mode !== 'edit') return;
  if (show.document.type !== 'none' && docState !== 'missing') {
    const n = show.goPoints.length;
    const ok = await ask('Replace the script with a running order?',
      n ? `The ${n} GO point${n === 1 ? '' : 's'} keep their cues and notes, but each needs to be put on an item again.` : 'The script is replaced in this show.', [
      { label: 'Cancel', value: false },
      { label: 'Replace', value: true, cls: 'mi-btn-go' }
    ], false);
    if (!ok) return;
  }
  for (const gp of show.goPoints) { gp.at = null; gp.standby = null; gp.warn = null; gp.needsPlacing = true; }
  show.document = { type: 'runningOrder', items: [normalizeRoItem({ type: 'song' })] };
  show.callOrder = null;
  resetHistory();
  markDirty();
  roSig = '';
  await loadDocument();
  const t = document.querySelector('#roView .ro-title-in');
  if (t) t.focus();
}

// ── Rendering ─────────────────────────────────────────────────────────
// Called from renderScript, renderMarks and the calling view. The whole list
// is rebuilt only when items are added, moved, retyped or the mode changes,
// so typing in a field is never interrupted.
function renderRunningOrder() {
  const el = document.getElementById('roView');
  if (!el) return;
  if (!isRO()) { if (el.innerHTML) { el.innerHTML = ''; roSig = ''; } return; }
  const editing = mode === 'edit';
  const sig = JSON.stringify([mode, roItems().map(it => [it.id, it.type, editing ? '' : [it.title, it.length, it.performers, it.lines]])]);
  if (sig !== roSig || !el.childElementCount) { roSig = sig; roBuild(el, editing); }
  roRefresh();
}

function roBuild(el, editing) {
  const items = roItems();
  const typeOpts = t => RO_TYPES.map(([k, l]) => `<option value="${k}"${k === t ? ' selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `
    <div class="ro-head">
      <div class="ro-head-t"><div class="ro-title">Running Order</div><div class="ro-total" id="roTotal"></div></div>
      ${editing ? '<button class="mi-btn" data-ro="add" title="Add an item at the end">+ Add Item</button>' : ''}
      <label class="text-check ro-cues-chk" title="Print with each item’s cues (for the crew), or without (for performers)"><input type="checkbox" id="roPrintCues"${roPrintCues ? ' checked' : ''}> With cues</label>
      <button class="mi-btn" data-ro="print" title="Print the running order">Print</button>
      <button class="mi-btn" data-ro="pdf" title="Save the running order as a PDF in the show’s reports folder">Save PDF</button>
    </div>
    <div class="ro-list mi-scroll" id="roList">
      ${items.map((it, i) => `
      <div class="ro-item ro-${it.type}" data-item="${it.id}">
        <div class="ro-num">${i + 1}</div>
        <div class="ro-body">
          ${editing ? `
          <div class="ro-row">
            <select class="mi-select ro-type" data-f="type">${typeOpts(it.type)}</select>
            <input class="mi-input ro-title-in" data-f="title" value="${esc(it.title)}" placeholder="Title" spellcheck="true">
            <input class="mi-input ro-len" data-f="length" value="${esc(it.length)}" placeholder="m:ss" title="Estimated length: m:ss, h:mm:ss or minutes">
            <span class="ro-tools">
              <button class="dp-btn" data-ro="up" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>
              <button class="dp-btn" data-ro="down" title="Move down"${i === items.length - 1 ? ' disabled' : ''}>▼</button>
              <button class="dp-btn dp-del" data-ro="del" title="Delete item">✕</button>
            </span>
          </div>
          <input class="mi-input ro-perf" data-f="performers" value="${esc(it.performers)}" placeholder="Performers / group" spellcheck="true">
          <textarea class="mi-input ro-lines" data-f="lines" rows="1" placeholder="Cue lines / lyrics (optional, one per line): a GO can be put on a line" spellcheck="true">${esc(it.lines)}</textarea>` : `
          <div class="ro-show-head">
            <span class="ro-show-title">${esc(it.title || 'Untitled')}</span>
            <span class="ro-chip">${esc(roTypeLabel(it.type))}</span>
            ${it.length ? `<span class="ro-show-len">${esc(it.length)}</span>` : ''}
          </div>
          ${it.performers ? `<div class="ro-show-perf">${esc(it.performers)}</div>` : ''}
          ${roLines(it).length ? `<div class="ro-show-lines">${roLines(it).map(l => `<div data-line="${esc(l)}">${esc(l)}</div>`).join('')}</div>` : ''}`}
          <div class="ro-gos" data-gos="${it.id}"></div>
        </div>
        <div class="ro-start" data-start="${it.id}"></div>
      </div>`).join('') || `<div class="script-empty ro-empty"><div class="script-empty-title">No items yet</div>
        <div class="script-empty-sub">Add songs, speeches, transitions and riser moves in the order they happen.</div></div>`}
    </div>`;
  el.querySelectorAll('textarea.ro-lines').forEach(roGrow);
}

// The box grows with its lines (CSS field-sizing does it; this is for older engines).
// Not while the list is hidden (scrollHeight is 0 then): it would stick at one line.
function roGrow(ta) {
  if (CSS.supports && CSS.supports('field-sizing', 'content')) return;
  if (!ta.offsetParent) { requestAnimationFrame(() => { if (ta.offsetParent) roGrow(ta); }); return; }
  ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 34) + 'px';
}

// GO chips, start times, totals and calling classes (no rebuild)
function roRefresh() {
  const el = document.getElementById('roView');
  if (!el || !isRO()) return;
  const editing = mode === 'edit';
  const calling = typeof isCalling === 'function' && isCalling();
  const list = orderedGoPoints();
  const idx = new Map(list.map((g, k) => [g.id, k]));
  const si = typeof atEnd !== 'undefined' && atEnd ? list.length : (typeof standbyIndex === 'function' ? standbyIndex() : -1);
  const sbGp = calling && !atEnd && si >= 0 ? list[si] : null;
  const times = roTimes();
  const total = document.getElementById('roTotal');
  if (total) {
    const n = roItems().length;
    total.textContent = `${n} item${n === 1 ? '' : 's'}` + (times.total ? ` · about ${fmtSecs(times.total)}` : '') +
      (times.unknown && n ? ` · ${times.unknown} without a length` : '');
  }
  roItems().forEach((it, i) => {
    const box = el.querySelector(`[data-gos="${it.id}"]`);
    if (!box) return;
    const gps = roGoPointsOf(it.id);
    const html = gps.map(gp => {
      const k = idx.get(gp.id);
      const p = goPos(gp);
      const cls = ['ro-go'];
      if (gp.id === selectedGoId && editing) cls.push('sel');
      if (calling && k < si) cls.push('called');
      if (sbGp && gp.id === sbGp.id) cls.push('standby');
      if (p && p.missing) cls.push('missing');
      const cues = gp.cues.length ? displayCues(gp).map(x => `${x.sep ? '<span class="ro-sep">' + esc(x.sep.trim()) + '</span>' : ''}<span style="color:${deptColor(x.c.dept)}">${esc(cueText(x.c))}</span>`).join(' ') : 'GO';
      const on = gp.at && gp.at.line ? `<span class="ro-on">on “${esc(gp.at.line)}”${p && p.missing ? ' (line changed)' : ''}</span>` : '';
      return `<button class="${cls.join(' ')}" data-go="${gp.id}" title="GO ${k + 1}${gp.note ? ': ' + esc(gp.note) : ''}"><span class="ro-go-n">${k + 1}</span>${cues}${gp.visual ? ' <span class="mk-vis">VIS</span>' : ''}${on}</button>`;
    }).join('') + (editing ? `<button class="mi-btn ro-add-go" data-ro="go" title="Add a GO point to this item">+ GO</button>` : '');
    // Only when something changed: a button being clicked must not be replaced under the mouse
    if (box._html !== html) { box._html = html; box.innerHTML = html; }
    const st = el.querySelector(`[data-start="${it.id}"]`);
    if (st) st.textContent = times.total || i ? `+${fmtSecs(times.starts[i])}` : '';
    const row = el.querySelector(`.ro-item[data-item="${it.id}"]`);
    if (row) {
      row.classList.toggle('standby', !!sbGp && sbGp.at && sbGp.at.item === it.id);
      const done = calling && gps.length > 0 && gps.every(g => idx.get(g.id) < si);
      row.classList.toggle('called', done);
      // the standby GO's line, highlighted in Show mode
      row.querySelectorAll('.ro-show-lines [data-line]').forEach(d => {
        d.classList.toggle('on', !!sbGp && sbGp.at && sbGp.at.item === it.id && sbGp.at.line === d.dataset.line);
      });
    }
  });
  // GO points not on any item (after switching from a script, or an item deleted)
  const loose = show.goPoints.filter(g => !goPos(g));
  let lb = el.querySelector('.ro-loose');
  if (loose.length && editing) {
    if (!lb) { lb = document.createElement('div'); lb.className = 'ro-loose'; el.querySelector('.ro-list').appendChild(lb); }
    const html = `<div class="mi-label">Not on an item (${loose.length}): select one, then pick its item in the panel</div>` +
      loose.map(gp => `<button class="ro-go${gp.id === selectedGoId ? ' sel' : ''}" data-go="${gp.id}">${esc(goText(gp))}</button>`).join('');
    if (lb._html !== html) { lb._html = html; lb.innerHTML = html; }
  } else if (lb) lb.remove();
}

// Keep the standby GO's item in view while calling
function roFollow(smooth) {
  if (!isRO() || !(typeof isCalling === 'function' && isCalling())) return;
  const row = document.querySelector('#roView .ro-item.standby');
  if (row) row.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
}
function roScrollToGo(id) {
  const b = document.querySelector(`#roView [data-go="${id}"]`);
  if (b) b.scrollIntoView({ block: 'center' });
}

// ── Editing ───────────────────────────────────────────────────────────
function roItemOf(el) { const r = el.closest('[data-item]'); return r ? roItem(r.dataset.item) : null; }

function onRoInput(e) {
  const el = e.target;
  if (el.id === 'roPrintCues') return;
  const f = el.dataset.f;
  const it = f && roItemOf(el);
  if (!it || mode !== 'edit') return;
  if (f === 'type') return;                          // change event
  it[f] = el.value;
  if (f === 'length') el.classList.toggle('bad', !!el.value.trim() && parseLength(el.value) === null);
  if (f === 'lines') roGrow(el);
  markDirty();
  if (f === 'length' || f === 'lines') { renderCalling(); roRefresh(); }
}

function onRoChange(e) {
  const el = e.target;
  if (el.id === 'roPrintCues') {
    roPrintCues = el.checked;
    try { localStorage.setItem(RO_CUES_KEY, roPrintCues ? '1' : '0'); } catch (_) {}
    return;
  }
  if (el.dataset.f === 'type') {
    const it = roItemOf(el);
    if (it && RO_TYPE_KEYS.includes(el.value)) { it.type = el.value; markDirty(); renderRunningOrder(); }
  }
  if (el.dataset.f === 'lines') renderMarks();       // GO points on lines may have moved
  if (el.dataset.f === 'length') {                   // "4" -> "4:00", "90" stays minutes -> "1:30:00"
    const it = roItemOf(el), n = parseLength(el.value);
    if (it && n !== null) { it.length = fmtSecs(n); el.value = it.length; el.classList.remove('bad'); markDirty(); roRefresh(); }
  }
}

async function onRoClick(e) {
  const go = e.target.closest('[data-go]');
  if (go) {
    if (mode === 'show') setStandby(go.dataset.go);
    else if (mode === 'edit') selectGo(go.dataset.go, false);
    return;
  }
  const b = e.target.closest('[data-ro]');
  if (!b) return;
  const act = b.dataset.ro;
  if (act === 'print') { await roPrintCmd(); return; }
  if (act === 'pdf') { await roPdfCmd(); return; }
  if (mode !== 'edit') return;
  const items = roItems();
  if (act === 'add') {
    const it = normalizeRoItem({ type: 'song' });
    items.push(it);
    markDirty();
    renderRunningOrder();
    const t = document.querySelector(`#roView [data-item="${it.id}"] .ro-title-in`);
    if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); }
    return;
  }
  const it = roItemOf(b);
  if (!it) return;
  const i = items.indexOf(it);
  if (act === 'go') {
    const r = b.getBoundingClientRect();
    selectGo(null, false);
    openPicker(r.right, r.top, { item: it.id, line: null }, null);
  } else if (act === 'up' || act === 'down') {
    const j = act === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    markDirty();
    renderRunningOrder();
    renderMarks();                                     // calling order follows the items
  } else if (act === 'del') {
    const gps = show.goPoints.filter(g => g.at && g.at.item === it.id);
    let keep = true;
    if (gps.length || it.title.trim()) {
      const ans = await ask(`Delete “${it.title || 'Untitled'}”?`,
        gps.length ? `It has ${gps.length} GO point${gps.length === 1 ? '' : 's'}. Keep them (to put on another item) or delete them too?` : 'The item is removed from the running order.', [
        { label: 'Cancel', value: 'cancel' },
        ...(gps.length ? [{ label: 'Keep GO Points', value: 'keep' }] : []),
        { label: gps.length ? 'Delete All' : 'Delete', value: 'all', cls: 'mi-btn-exit' }
      ], 'cancel');
      if (ans === 'cancel') return;
      keep = ans === 'keep';
    }
    checkpoint();
    if (keep) gps.forEach(g => { g.at = null; g.needsPlacing = true; });
    else {
      show.goPoints = show.goPoints.filter(g => !gps.includes(g));
      if (Array.isArray(show.callOrder)) show.callOrder = show.callOrder.filter(id => !gps.some(g => g.id === id));
      if (gps.some(g => g.id === selectedGoId)) selectGo(null, false);
    }
    items.splice(i, 1);
    markDirty();
    renderRunningOrder();
    renderMarks();
  }
}

function onRoDblClick(e) {
  const go = e.target.closest('[data-go]');
  if (!go || mode !== 'edit') return;
  const gp = show.goPoints.find(g => g.id === go.dataset.go);
  if (gp) openPicker(e.clientX, e.clientY, gp.at, gp);
}

// ── Inspector: which item, which line ─────────────────────────────────
function roInspectorHtml(gp) {
  const items = roItems();
  const at = gp.at && gp.at.item ? gp.at : null;
  const it = at ? roItem(at.item) : null;
  const lines = it ? roLines(it) : [];
  const lineMissing = at && at.line && !lines.includes(String(at.line).trim());
  return `
    <div class="in-sec">
      <div class="in-sec-head"><span class="mi-label">Item</span></div>
      <select class="mi-select ro-in-item" data-roin="item">
        ${it ? '' : '<option value="" selected>Not on an item…</option>'}
        ${items.map((x, i) => `<option value="${x.id}"${it && x.id === it.id ? ' selected' : ''}>${i + 1}. ${esc(x.title || 'Untitled')} (${esc(roTypeLabel(x.type))})</option>`).join('')}
      </select>
      <div class="in-sec-head" style="margin-top:6px"><span class="mi-label">On</span></div>
      <select class="mi-select ro-in-line" data-roin="line"${it ? '' : ' disabled'}>
        <option value=""${!at || !at.line ? ' selected' : ''}>Start of the item</option>
        ${lines.map(l => `<option value="${esc(l)}"${at && at.line === l ? ' selected' : ''}>${esc(l.length > 60 ? l.slice(0, 57) + '…' : l)}</option>`).join('')}
        ${lineMissing ? `<option value="${esc(at.line)}" selected>${esc(at.line)} (line changed)</option>` : ''}
      </select>
      <div class="in-hint">Lines come from the item’s cue lines / lyrics.</div>
    </div>`;
}

function onRoInspectorChange(e) {
  const k = e.target.dataset.roin;
  if (!k || !isRO()) return;
  const gp = selectedGo();
  if (!gp) return;
  checkpoint();
  if (k === 'item') {
    if (!roItem(e.target.value)) return;
    gp.at = { item: e.target.value, line: null };
    gp.needsPlacing = false;
  } else if (k === 'line' && gp.at) {
    gp.at = { item: gp.at.item, line: e.target.value || null };
  }
  markDirty();
  renderMarks();
  buildInspector();
}

// ── Operator mode: the item instead of a script excerpt ───────────────
function roExcerpt(box, gp) {
  const p = goPos(gp);
  const it = gp.at && roItem(gp.at.item);
  const key = JSON.stringify(['ro', gp.id, gp.at, it]);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!it) { box.innerHTML = '<div class="op-empty">Not on an item</div>'; return; }
  box.innerHTML = `<div class="ro-ex ro-${it.type}">
    <div class="ro-show-head"><span class="ro-ex-n">${p ? p.page + 1 : ''}</span><span class="ro-show-title">${esc(it.title || 'Untitled')}</span><span class="ro-chip">${esc(roTypeLabel(it.type))}</span></div>
    ${it.performers ? `<div class="ro-show-perf">${esc(it.performers)}</div>` : ''}
    ${roLines(it).length ? `<div class="ro-show-lines">${roLines(it).map(l => `<div class="${gp.at.line === l ? 'on' : ''}">${esc(l)}</div>`).join('')}</div>` : ''}
    ${gp.at.line ? '' : '<div class="ro-ex-start">GO at the start of the item</div>'}
  </div>`;
}

// ── Print / PDF ───────────────────────────────────────────────────────
function roDocHtml(withCues) {
  const items = roItems();
  const times = roTimes();
  const list = orderedGoPoints();
  const idx = new Map(list.map((g, k) => [g.id, k + 1]));
  const printed = new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const cuesOfItem = it => roGoPointsOf(it.id).map(gp =>
    `<div class="go"><span class="n">${idx.get(gp.id)}</span> <b>${esc(gp.cues.length ? goText(gp) : 'GO')}</b>${gp.at.line ? ` <span class="on">on “${esc(gp.at.line)}”</span>` : ''}${gp.visual ? ' <span class="vis">VISUAL</span>' : ''}${gp.note ? ` <span class="note">${esc(gp.note)}</span>` : ''}</div>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(show.name || 'Show')} · Running Order</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 10.5pt; line-height: 1.35; }
  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .show { font-size: 20pt; font-weight: 700; }
  .what { font-size: 12pt; font-weight: 600; color: #444; margin-top: 2px; }
  .meta { font-size: 9.5pt; color: #555; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; color: #555; border-bottom: 1.5px solid #444; padding: 3px 6px; }
  td { padding: 6px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr { break-inside: avoid; }
  td.n { width: 30px; text-align: right; color: #666; font-weight: 600; }
  .title { font-size: 12pt; font-weight: 700; }
  .type { display: inline-block; font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.8px; color: #666; border: 1px solid #bbb; border-radius: 3px; padding: 0 4px; margin-left: 6px; vertical-align: 2px; }
  .perf { color: #444; margin-top: 1px; }
  .lines { color: #555; font-size: 9pt; margin-top: 3px; white-space: pre-wrap; }
  td.len, td.start { width: 62px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.start { color: #666; }
  td.cues { width: ${withCues ? '30%' : '0'}; font-size: 9pt; }
  .go .n { color: #888; display: inline-block; min-width: 16px; text-align: right; }
  .go .on, .go .note { color: #555; }
  .vis { font-size: 7pt; font-weight: 700; border: 1px solid #996; color: #663; border-radius: 2px; padding: 0 2px; }
  tr.intermission td { background: #f2f2f2; }
  footer { margin-top: 12px; font-size: 7.5pt; color: #888; display: flex; justify-content: space-between; }
</style></head><body>
<header>
  <div><div class="show">${esc(show.name || 'Untitled Show')}</div><div class="what">Running Order${withCues ? ' · with cues' : ''}</div></div>
  <div class="meta">${items.length} item${items.length === 1 ? '' : 's'}${times.total ? ` · about ${fmtSecs(times.total)}` : ''}</div>
</header>
<table>
  <thead><tr><th style="text-align:right">#</th><th>Item</th><th>Length</th><th>Starts</th>${withCues ? '<th>Cues</th>' : ''}</tr></thead>
  <tbody>${items.map((it, i) => `<tr class="${it.type}">
    <td class="n">${i + 1}</td>
    <td><span class="title">${esc(it.title || 'Untitled')}</span><span class="type">${esc(roTypeLabel(it.type))}</span>
      ${it.performers ? `<div class="perf">${esc(it.performers)}</div>` : ''}
      ${roLines(it).length ? `<div class="lines">${esc(roLines(it).join('\n'))}</div>` : ''}</td>
    <td class="len">${esc(it.length || '')}</td>
    <td class="start">+${fmtSecs(times.starts[i])}</td>
    ${withCues ? `<td class="cues">${cuesOfItem(it)}</td>` : ''}
  </tr>`).join('')}</tbody>
</table>
<footer><span>${esc(show.name || '')} · Running Order</span><span>MiKallbook · ${esc(printed)}</span></footer>
</body></html>`;
}

async function roPdfCmd() {
  if (!roItems().length) { toast('The running order is empty.', 'err'); return; }
  if (!(await ensureSavedForReports())) return;
  const name = `Running Order${roPrintCues ? '' : ' - Performers'}.pdf`;
  let r;
  try { r = await bridge.reports.savePdf(roDocHtml(roPrintCues), showPath, name); }
  catch (err) { toast('PDF failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.error) { toast('PDF failed: ' + (r ? r.error : 'no answer'), 'err'); return; }
  const ans = await ask('Running order saved', r.path, [
    { label: 'Show in Folder', value: 'folder' },
    { label: 'Open PDF', value: 'open' },
    { label: 'OK', value: 'ok', cls: 'mi-btn-go' }
  ], 'ok');
  if (ans === 'open') bridge.reports.open(r.path);
  else if (ans === 'folder') bridge.reports.reveal(r.path);
}
async function roPrintCmd() {
  if (!roItems().length) { toast('The running order is empty.', 'err'); return; }
  let r;
  try { r = await bridge.reports.print(roDocHtml(roPrintCues)); }
  catch (err) { toast('Print failed: ' + cleanErr(err), 'err'); return; }
  if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) toast('Print failed: ' + r.reason, 'err');
}

function initRunningOrder() {
  const el = document.getElementById('roView');
  el.addEventListener('input', onRoInput);
  el.addEventListener('change', onRoChange);
  el.addEventListener('click', onRoClick);
  el.addEventListener('dblclick', onRoDblClick);
  document.getElementById('inspBody').addEventListener('change', onRoInspectorChange);
  document.getElementById('btnEmptyRO').addEventListener('click', newRunningOrderCmd);
}
