'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: side panels (open from the left, Edit mode)
     - Inspector: the selected GO point's cues, Standby / Warn points,
       note, "called on visual", calling order, delete
     - Departments: code, name, color, link; order; add / delete;
       save as the default set for new shows (this computer)

   Uses app.js / marks.js globals. Every change goes through the marks
   undo history (checkpoint, or beginEdit/endEdit around typing).
   ════════════════════════════════════════════════════════════════════ */

const DEFAULT_DEPTS_KEY = 'micallbook.defaultDepartments';

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
const NEW_DEPT_COLORS = ['#f0a35e', '#e8e17a', '#c9a27e', '#ff8fa3', '#bfa6e0', '#7fd6c2', '#d8b4fe', '#f5c2a0'];
const TARGET_LABEL = { none: 'None', mikonsole: 'MiKonsole', micue: 'MiKue' };

const inspEl  = () => document.getElementById('inspector');
const deptsEl = () => document.getElementById('deptPanel');

function panelOpen(el) { return el.classList.contains('open'); }

// ── Saved default departments (for New) ───────────────────────────────
function savedDefaultDepartments() {
  try {
    const list = JSON.parse(localStorage.getItem(DEFAULT_DEPTS_KEY) || 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch (_) {}
  return null;
}

// ── Inspector ─────────────────────────────────────────────────────────
// Cues whose number MiKallbook suggested and nobody has typed over yet:
// changing their department picks that department's next number.
const autoNumbered = new WeakSet();

function selectedGo() { return show.goPoints.find(g => g.id === selectedGoId) || null; }

function openInspector() {
  if (mode !== 'edit' || !selectedGo()) return;
  deptsEl().classList.remove('open');
  inspEl().classList.add('open');
  buildInspector();
}
function closeInspector() {
  inspEl().classList.remove('open');
  if (placing) cancelPlacing();
}

function anchorStatus(a) {
  if (!a) return 'Not set';
  const p = anchorPos(a);
  return p ? `Set · page ${p.page + 1}` : 'Set';
}

function buildInspector() {
  const gp = selectedGo();
  if (!gp) { closeInspector(); return; }
  const body = document.getElementById('inspBody');
  const deptOpts = id => show.departments.map(d =>
    `<option value="${d.id}"${d.id === id ? ' selected' : ''}>${esc(d.code)}${d.name ? ' · ' + esc(d.name) : ''}</option>`).join('');

  // Combo cues (fired by a MiKue cue) can't be edited here: they follow MiKue
  const cueRows = gp.cues.map((c, i) => isMsCue(c) ? '' : deptCallsMics(c.dept) ? micRowHtml(c, i, deptOpts) : c.via ? `
    <div class="in-cue via" data-i="${i}">
      <span class="in-swatch" style="background:${deptColor(c.dept)}"></span>
      <span class="in-via">${esc(cueText(c))}</span>
      <span class="in-via-of">${esc(comboOfText(gp, c))}</span>
      <span></span>
    </div>
    <div class="in-src" data-src="${i}"></div>` : `
    <div class="in-cue" data-i="${i}">
      <span class="in-swatch" style="background:${deptColor(c.dept)}"></span>
      <select class="mi-select in-dept" data-i="${i}">${deptOpts(c.dept)}</select>
      <input class="mi-input in-num" data-i="${i}" value="${esc(c.number)}" spellcheck="false" maxlength="8" autocomplete="off">
      <button class="pk-x in-del-cue" data-i="${i}" title="Remove this cue">×</button>
    </div>
    <div class="in-src" data-src="${i}"></div>`).join('');

  const pointRow = (kind, label, help) => `
    <div class="in-point">
      <div class="in-point-head"><span class="in-k">${label}</span><span class="in-status" data-status="${kind}">${anchorStatus(gp[kind])}</span></div>
      <div class="in-hint">${help}</div>
      <div class="in-btns">
        <button class="mi-btn" data-place="${kind}">${gp[kind] ? 'Move…' : 'Place…'}</button>
        <button class="mi-btn" data-show="${kind}"${gp[kind] ? '' : ' disabled'}>Show</button>
        <button class="mi-btn" data-clear="${kind}"${gp[kind] ? '' : ' disabled'}>Clear</button>
      </div>
    </div>`;

  const ro = typeof isRO === 'function' && isRO();
  let notices = '';
  if (ro) {
    if (!goPos(gp)) notices += '<div class="in-notice">This GO point is not on an item. Pick one below.</div>';
  } else if (gp.needsPlacing || !gp.at) {
    notices += `<div class="in-notice">This GO point is not on the script.
      <button class="mi-btn" data-place="at">Place on script…</button></div>`;
  } else if (gp.needsCheck) {
    notices += `<div class="in-notice">The words at this mark were edited. Check its position, then:
      <button class="mi-btn" data-checked="1">Checked</button></div>`;
  }

  body.innerHTML = `
    ${notices}
    <div class="in-sec">
      <div class="in-sec-head"><span class="mi-label">Cues</span></div>
      ${cueRows || `<div class="in-empty">${goMilestone(gp) ? 'No department cues.' : 'No cues: this is a plain GO.'}</div>`}
      <div class="in-notice hidden" id="inCombo">MiKue’s cues have changed: the lighting cues this GO’s sound cues fire are out of date.
        <button class="mi-btn" data-combo="1">Update from MiKue</button></div>
      <button class="mi-btn in-add-cue">+ Add cue</button>
      <div class="in-msrow">
        <span class="in-k">Milestone</span>
        <select class="mi-select in-msel" title="Logged in the session when this GO is called in Show mode: House Open, Places, Act Up / Down. The last act's Down ends the session.">${milestoneOptions(goMilestone(gp))}</select>
      </div>
    </div>
    ${ro ? roInspectorHtml(gp) : `<div class="in-sec">
      ${pointRow('standby', 'Standby', 'Where you say "Standby…", usually a few lines before the GO.')}
      ${pointRow('warn', 'Warn', 'Optional earlier warning, a page or so before.')}
    </div>`}
    <div class="in-sec">
      <div class="in-sec-head"><span class="mi-label">Note</span></div>
      <textarea class="mi-input in-note mi-scroll" rows="3" spellcheck="true" placeholder="e.g. visual: Maude sits">${esc(gp.note || '')}</textarea>
      <label class="text-check in-vis"><input type="checkbox" class="in-visual"${gp.visual ? ' checked' : ''}> Called on visual</label>
    </div>
    <div class="in-sec">
      <div class="in-sec-head"><span class="mi-label">Calling order</span><span class="in-order" id="inOrder"></span></div>
      <div class="in-btns">
        <button class="mi-btn" data-move="-1" title="Call this GO one place earlier">◀ Earlier</button>
        <button class="mi-btn" data-move="1" title="Call this GO one place later">Later ▶</button>
        <button class="mi-btn" data-reset-order="1" title="Put every GO back in reading order (page, then top to bottom; or item order)">${ro ? 'Item order' : 'Reading order'}</button>
      </div>
    </div>
    <div class="in-sec in-foot">
      <button class="mi-btn mi-btn-stop" data-delete="1">Delete GO point</button>
    </div>`;
  updateInspectorLive();
}

// The parts that change without a rebuild (keeps typing focus)
function updateInspectorLive() {
  const gp = selectedGo();
  if (!gp || !panelOpen(inspEl())) return;
  const list = orderedGoPoints();
  const i = list.findIndex(g => g.id === gp.id);
  document.getElementById('inspTitle').textContent = `GO ${i + 1}`;
  const ord = document.getElementById('inOrder');
  if (ord) ord.textContent = `${i + 1} of ${list.length}${isManualOrder() ? ' · manual order' : ''}`;
  const body = document.getElementById('inspBody');
  body.querySelectorAll('[data-status]').forEach(el => { el.textContent = anchorStatus(gp[el.dataset.status]); });
  body.querySelectorAll('.in-cue').forEach(row => {
    const c = gp.cues[Number(row.dataset.i)];
    if (c) row.querySelector('.in-swatch').style.background = deptColor(c.dept);
    const num = row.querySelector('.in-num');
    if (c && num) {
      const list = datalistFor(c.dept);                 // dropdown of the linked app's cues
      if (list) num.setAttribute('list', list); else num.removeAttribute('list');
    }
  });
  // What each cue is in MiKonsole / MiKue
  body.querySelectorAll('.in-src').forEach(el => {
    const c = gp.cues[Number(el.dataset.src)];
    const src = c ? cueSource(c) : { state: 'none', text: '' };
    el.textContent = src.text;
    el.className = 'in-src ' + src.state;
  });
  const combo = document.getElementById('inCombo');
  if (combo) combo.classList.toggle('hidden', !comboStale(gp));
  const earlier = body.querySelector('[data-move="-1"]'), later = body.querySelector('[data-move="1"]');
  if (earlier) earlier.disabled = i <= 0;
  if (later) later.disabled = i < 0 || i >= list.length - 1;
  const reset = body.querySelector('[data-reset-order]');
  if (reset) reset.disabled = !isManualOrder();
}

function wireInspector() {
  const body = document.getElementById('inspBody');
  document.getElementById('btnInspClose').addEventListener('click', () => { selectGo(null, false); closeInspector(); });

  // Typing and dropdowns: one undo step per edit. (Checkboxes and buttons take their own.)
  const FIELD = 'input:not([type=checkbox]), textarea, select';
  body.addEventListener('focusin', e => { if (e.target.matches(FIELD)) beginEdit(); });
  body.addEventListener('focusout', e => { if (e.target.matches(FIELD)) endEdit(); });

  body.addEventListener('input', e => {
    const gp = selectedGo(); if (!gp) return;
    const t = e.target;
    if (t.classList.contains('in-num')) {
      const c = gp.cues[Number(t.dataset.i)];
      const v = t.value.trim();
      if (c) autoNumbered.delete(c);
      if (c && v) {
        c.number = v;
        // Combo cues follow the sound cue's number. Rows are only rebuilt when
        // that changes the list of cues, so typing keeps its place otherwise.
        const before = gp.cues.length, combos = JSON.stringify(gp.cues.filter(x => x.via));
        syncCombos(gp);
        markDirty(); renderMarks();
        if (gp.cues.length !== before || JSON.stringify(gp.cues.filter(x => x.via)) !== combos) rebuildKeepingFocus(t, c);
      }
    } else if (t.classList.contains('in-mic')) {
      const c = gp.cues[Number(t.dataset.i)];
      if (!c) return;
      const groups = ensureMics(c);
      const g = groups[Number(t.dataset.g)];
      if (g) { g.m = t.value; c.number = micText(groups); markDirty(); renderMarks(); }
    } else if (t.classList.contains('in-note')) {
      gp.note = t.value; markDirty();
    }
  });

  body.addEventListener('change', e => {
    const gp = selectedGo(); if (!gp) return;
    const t = e.target;
    if (t.classList.contains('in-dept')) {
      const c = gp.cues[Number(t.dataset.i)];
      if (c) {
        const wasMics = !!c.mics;
        c.dept = t.value; lastDept = t.value;
        if (deptCallsMics(c.dept) && !wasMics) {
          // now called by mic numbers: start an empty group
          c.mics = [{ m: '', io: 'in' }]; c.number = ''; autoNumbered.delete(c);
          markDirty(); renderMarks(); buildInspector(); t.blur();
          const inp = document.querySelector(`#inspBody .in-mic[data-i="${gp.cues.indexOf(c)}"]`);
          if (inp) inp.focus();
          return;
        }
        if (!deptCallsMics(c.dept) && wasMics) {
          delete c.mics; c.number = ''; c.number = nextCueNumber(c.dept);
          markDirty(); renderMarks(); buildInspector(); t.blur();
          return;
        }
        if (autoNumbered.has(c)) {
          c.number = '';                              // don't count itself
          c.number = nextCueNumber(c.dept);
          const num = document.querySelector(`#inspBody .in-num[data-i="${t.dataset.i}"]`);
          if (num) num.value = c.number;
        }
        const combos = JSON.stringify(gp.cues.filter(x => x.via));
        syncCombos(gp);
        markDirty(); renderMarks();
        if (JSON.stringify(gp.cues.filter(x => x.via)) !== combos) buildInspector(); else updateInspectorLive();
      }
      t.blur();
    } else if (t.classList.contains('in-num')) {
      const c = gp.cues[Number(t.dataset.i)];
      if (c && !t.value.trim()) { t.value = c.number; toast('A cue needs a number.', 'err'); }
      else if (c && gp.cues.some((o, k) => k !== Number(t.dataset.i) && o.dept === c.dept && o.number === c.number)) {
        toast(`${cueText(c)} is in this GO twice.`, 'err');
      }
    } else if (t.classList.contains('in-mic')) {
      const v = t.value.trim();
      if (v && !micListOk(v)) toast(`“${v}”: mic numbers like 4-8, 11`, 'err');
      else if (v) { t.value = micListText(v); const c = gp.cues[Number(t.dataset.i)]; if (c) { ensureMics(c)[Number(t.dataset.g)].m = t.value; c.number = micText(c.mics); markDirty(); renderMarks(); } }
    } else if (t.classList.contains('in-io')) {
      const c = gp.cues[Number(t.dataset.i)];
      const g = c && ensureMics(c)[Number(t.dataset.g)];
      if (g) { g.io = t.value === 'out' ? 'out' : 'in'; c.number = micText(c.mics); markDirty(); renderMarks(); }
      t.blur();
    } else if (t.classList.contains('in-msel')) {
      const key = t.value || null;
      const other = key ? show.goPoints.find(g => g !== gp && goMilestone(g) === key) : null;
      if (other) {
        setGoMilestone(other, null);
        toast(`${milestoneLabel(key)} moved here from GO ${orderedGoPoints().indexOf(other) + 1}`, 'ok');
      }
      setGoMilestone(gp, key);
      markDirty(); renderMarks(); buildInspector();
      t.blur();
    } else if (t.classList.contains('in-note')) {
      renderMarks();       // tab tooltip
    } else if (t.classList.contains('in-visual')) {
      checkpoint();
      gp.visual = t.checked;
      markDirty(); renderMarks();
    }
  });

  body.addEventListener('click', async e => {
    const gp = selectedGo(); if (!gp) return;
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('in-mic-add') || b.classList.contains('in-mic-del')) {
      const c = gp.cues[Number(b.dataset.i)];
      if (!c) return;
      checkpoint();
      const groups = ensureMics(c);
      let focusG;
      if (b.classList.contains('in-mic-add')) {
        groups.push({ m: '', io: groups.length && groups[groups.length - 1].io === 'in' ? 'out' : 'in' });
        focusG = groups.length - 1;
      } else {
        groups.splice(Number(b.dataset.g), 1);
        if (!groups.length) groups.push({ m: '', io: 'in' });
        focusG = 0;
      }
      c.number = micText(groups);
      markDirty(); renderMarks(); buildInspector();
      const inp = document.querySelector(`#inspBody .in-mic[data-i="${gp.cues.indexOf(c)}"][data-g="${focusG}"]`);
      if (inp) inp.focus();
    } else if (b.classList.contains('in-del-cue')) {
      checkpoint();
      gp.cues.splice(Number(b.dataset.i), 1);
      syncCombos(gp);                                 // its combo cues go with it
      markDirty(); renderMarks(); buildInspector();
    } else if (b.dataset.combo) {
      checkpoint();
      syncCombos(gp);
      markDirty(); renderMarks(); buildInspector();
    } else if (b.classList.contains('in-add-cue')) {
      if (!show.departments.length) { toast('Add a department first.', 'err'); return; }
      checkpoint();
      const dept = (lastDept && deptById(lastDept)) ? lastDept : show.departments[0].id;
      const mics = deptCallsMics(dept);
      const cue = mics ? { dept, number: '', mics: [{ m: '', io: 'in' }] } : { dept, number: nextCueNumber(dept) };
      gp.cues.push(cue);
      if (!mics) autoNumbered.add(cue);
      syncCombos(gp);
      markDirty(); renderMarks(); buildInspector();
      const num = document.querySelector(`#inspBody ${mics ? '.in-mic' : '.in-num'}[data-i="${gp.cues.indexOf(cue)}"]`);
      if (num) { num.focus(); if (num.select) num.select(); }
    } else if (b.dataset.place) {
      startPlacing(gp.id, b.dataset.place);
    } else if (b.dataset.show) {
      scrollToAnchor(gp[b.dataset.show]);
    } else if (b.dataset.clear) {
      checkpoint();
      gp[b.dataset.clear] = null;
      markDirty(); renderMarks(); buildInspector();
    } else if (b.dataset.checked) {
      checkpoint();
      gp.needsCheck = false;
      markDirty(); renderMarks(); buildInspector();
    } else if (b.dataset.move) {
      moveGo(gp.id, Number(b.dataset.move));
      updateInspectorLive();
    } else if (b.dataset.resetOrder) {
      resetOrder();
      updateInspectorLive();
    } else if (b.dataset.delete) {
      deleteSelected();
      closeInspector();
    }
  });
}

// A cue of a department called by mic numbers: department, then one row per
// group (mic list + In/Out), + Group
function micRowHtml(c, i, deptOpts) {
  const groups = c.mics || [{ m: c.number, io: 'in' }];      // a cue typed before the department called by mics
  return `
    <div class="in-cue in-miccue" data-i="${i}">
      <span class="in-swatch" style="background:${deptColor(c.dept)}"></span>
      <select class="mi-select in-dept" data-i="${i}">${deptOpts(c.dept)}</select>
      <button class="mi-btn in-mic-add" data-i="${i}" title="Another group on the same call, e.g. 2-3 OUT">+ Group</button>
      <button class="pk-x in-del-cue" data-i="${i}" title="Remove this cue">×</button>
    </div>
    ${groups.map((g, k) => `
    <div class="in-microw">
      <input class="mi-input in-mic" data-i="${i}" data-g="${k}" value="${esc(g.m)}" placeholder="Mics: 4-8, 11" spellcheck="false" autocomplete="off" maxlength="40">
      <select class="mi-select in-io" data-i="${i}" data-g="${k}"><option value="in"${g.io !== 'out' ? ' selected' : ''}>IN</option><option value="out"${g.io === 'out' ? ' selected' : ''}>OUT</option></select>
      <button class="pk-x in-mic-del" data-i="${i}" data-g="${k}" title="Remove this group">×</button>
    </div>`).join('')}
    <div class="in-src" data-src="${i}"></div>`;
}
// The cue's mic groups, made from its number the first time an older cue is edited
function ensureMics(c) {
  if (!Array.isArray(c.mics)) c.mics = [{ m: String(c.number || ''), io: 'in' }];
  return c.mics;
}

// "fired by SQ 2 in MiKue"
function comboOfText(gp, c) {
  const s = comboSource(gp, c);
  return s ? `fired by ${cueText(s)} in MiKue` : 'fired by MiKue';
}

// Rebuild the inspector and put the caret back in cue c's number field
// (its row may have moved: combo cues come and go above it)
function rebuildKeepingFocus(input, c) {
  const gp = selectedGo();
  const pos = input.selectionStart;
  endEdit();                       // close this undo step; focusing the new field opens the next
  buildInspector();
  if (!gp || !c) return;
  const again = document.querySelector(`#inspBody .in-num[data-i="${gp.cues.indexOf(c)}"]`);
  if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
}

function scrollToAnchor(a) {
  const p = anchorPos(a);
  if (!p || !view.slots[p.page]) return;
  const s = view.slots[p.page];
  view.el.scrollTop = Math.max(0, s.slot.parentElement.offsetTop + p.y * s.h - view.el.clientHeight * 0.35);
}

// ── Departments ───────────────────────────────────────────────────────
function openDepartments() {
  if (mode !== 'edit') return;
  inspEl().classList.remove('open');
  if (placing) cancelPlacing();
  deptsEl().classList.add('open');
  buildDepartments();
}
function closeDepartments() { deptsEl().classList.remove('open'); }

function deptUsage(id) {
  let n = 0;
  for (const gp of show.goPoints) for (const c of gp.cues) if (c.dept === id) n++;
  return n;
}

function buildDepartments() {
  const list = document.getElementById('deptList');
  list.innerHTML = show.departments.map((d, i) => {
    const used = deptUsage(d.id);
    return `
    <div class="dp-row" data-id="${d.id}">
      <input type="color" class="dp-color" value="${d.color}" title="Color">
      <input class="mi-input dp-code" value="${esc(d.code)}" maxlength="6" spellcheck="false" title="Code shown on the tabs">
      <input class="mi-input dp-name" value="${esc(d.name)}" placeholder="Name" spellcheck="false">
      <select class="mi-select dp-target" title="Where this department's cues live: cue lists, and what GO fires with DRIVE on">
        ${Object.keys(TARGET_LABEL).map(k => `<option value="${k}"${d.target === k ? ' selected' : ''}>${TARGET_LABEL[k]}</option>`).join('')}
      </select>
      <div class="dp-tools">
        <button class="dp-btn" data-up="1" title="Move up"${i === 0 ? ' disabled' : ''}>▲</button>
        <button class="dp-btn" data-down="1" title="Move down"${i === show.departments.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="dp-btn dp-del" data-del="1" title="Delete">×</button>
        <label class="dp-mics" title="Called by mic numbers: cues read MIC 4–8 IN, 2–3 OUT instead of a cue number"><input type="checkbox" class="dp-mic"${d.mics ? ' checked' : ''}> Mic numbers</label>
      </div>
      <div class="dp-used">${used ? `${used} cue${used === 1 ? '' : 's'}` : 'unused'}</div>
    </div>`;
  }).join('') || '<div class="in-empty">No departments. Add one to start marking cues.</div>';
  document.getElementById('btnForgetDepts').disabled = !savedDefaultDepartments();
}

function deptFromRow(el) {
  const row = el.closest('.dp-row');
  return row ? show.departments.find(d => d.id === row.dataset.id) : null;
}

function afterDeptChange(rebuild) {
  markDirty();
  renderMarks();
  if (rebuild) buildDepartments();
  if (panelOpen(inspEl())) buildInspector();
}

function wireDepartments() {
  const list = document.getElementById('deptList');
  document.getElementById('btnDepts').addEventListener('click', () => panelOpen(deptsEl()) ? closeDepartments() : openDepartments());
  document.getElementById('btnDeptClose').addEventListener('click', closeDepartments);

  list.addEventListener('focusin', e => {
    if (e.target.matches('input, select')) beginEdit();
    if (e.target.classList.contains('dp-code')) e.target.dataset.was = e.target.value;   // to put back on a bad code
  });
  list.addEventListener('focusout', e => { if (e.target.matches('input, select')) endEdit(); });

  list.addEventListener('input', e => {
    const d = deptFromRow(e.target); if (!d) return;
    const t = e.target;
    if (t.classList.contains('dp-color')) { d.color = t.value; afterDeptChange(false); }
    else if (t.classList.contains('dp-code')) {
      const v = t.value.toUpperCase().replace(/\s+/g, '');
      if (t.value !== v) { const pos = t.selectionStart; t.value = v; try { t.setSelectionRange(pos, pos); } catch (_) {} }
      if (v && !show.departments.some(o => o !== d && o.code === v)) { d.code = v; afterDeptChange(false); }
    } else if (t.classList.contains('dp-name')) { d.name = t.value; markDirty(); }
  });

  list.addEventListener('change', e => {
    const d = deptFromRow(e.target); if (!d) return;
    const t = e.target;
    if (t.classList.contains('dp-code')) {
      const v = t.value.trim().toUpperCase();
      const was = t.dataset.was || d.code;
      if (!v) { d.code = was; t.value = was; afterDeptChange(false); toast('A department needs a code.', 'err'); return; }
      if (show.departments.some(o => o !== d && o.code === v)) {
        d.code = was; t.value = was; afterDeptChange(false);
        toast(`There is already a department called ${v}.`, 'err');
        return;
      }
    } else if (t.classList.contains('dp-target')) {
      d.target = t.value; afterDeptChange(false); t.blur();
    } else if (t.classList.contains('dp-mic')) {
      d.mics = t.checked; afterDeptChange(false); t.blur();
    } else if (t.classList.contains('dp-color')) {
      // color picker closed: the edit is finished
      endEdit();
    } else if (t.classList.contains('dp-name')) {
      afterDeptChange(false);
    }
  });

  list.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const d = deptFromRow(b); if (!d) return;
    const i = show.departments.indexOf(d);
    if (b.dataset.up || b.dataset.down) {
      const j = i + (b.dataset.up ? -1 : 1);
      if (j < 0 || j >= show.departments.length) return;
      checkpoint();
      [show.departments[i], show.departments[j]] = [show.departments[j], show.departments[i]];
      afterDeptChange(true);
    } else if (b.dataset.del) {
      const used = deptUsage(d.id);
      if (used) {
        const ok = await ask(`Delete ${d.code}?`,
          `${used} cue${used === 1 ? ' uses' : 's use'} ${d.code}. ${used === 1 ? 'It' : 'They'} will be removed from ${used === 1 ? 'its GO point' : 'their GO points'}. ` +
          `A GO point left with no cues stays as a plain GO. Ctrl+Z undoes this.`, [
          { label: 'Cancel', value: false },
          { label: `Delete ${d.code}`, value: true, cls: 'mi-btn-exit' }
        ], false);
        if (!ok) return;
      }
      checkpoint();
      show.departments.splice(i, 1);
      for (const gp of show.goPoints) { gp.cues = gp.cues.filter(c => c.dept !== d.id); syncCombos(gp); }
      if (lastDept === d.id) lastDept = null;
      afterDeptChange(true);
    }
  });

  document.getElementById('btnAddDept').addEventListener('click', () => {
    checkpoint();
    const used = new Set(show.departments.map(d => d.color));
    const color = NEW_DEPT_COLORS.find(c => !used.has(c)) || NEW_DEPT_COLORS[show.departments.length % NEW_DEPT_COLORS.length];
    let n = 1, code = 'NEW';
    while (show.departments.some(d => d.code === code)) code = 'NEW' + (++n);
    show.departments.push({ id: uid(), code, name: '', color, target: 'none', mics: false });
    afterDeptChange(true);
    const codes = document.querySelectorAll('#deptList .dp-code');
    const last = codes[codes.length - 1];
    if (last) { last.focus(); last.select(); }
  });

  document.getElementById('btnSaveDepts').addEventListener('click', () => {
    if (!show.departments.length) { toast('There are no departments to save.', 'err'); return; }
    try {
      localStorage.setItem(DEFAULT_DEPTS_KEY, JSON.stringify(show.departments.map(({ code, name, color, target, mics }) => ({ code, name, color, target, mics: !!mics }))));
      toast('Saved: new shows on this computer start with these departments.', 'ok');
    } catch (_) { toast('Could not save the default departments.', 'err'); }
    buildDepartments();
  });
  document.getElementById('btnForgetDepts').addEventListener('click', () => {
    try { localStorage.removeItem(DEFAULT_DEPTS_KEY); } catch (_) {}
    toast('New shows will start with the suggested departments again.', 'ok');
    buildDepartments();
  });
}

// ── Hooks called from marks.js ────────────────────────────────────────
function onSelectionChanged() {
  if (selectedGoId && mode === 'edit') openInspector();
  else if (!selectedGoId) closeInspector();
}
function onMarksRestored() {
  if (panelOpen(inspEl())) { if (selectedGo()) buildInspector(); else closeInspector(); }
  if (panelOpen(deptsEl())) buildDepartments();
}
function onMarksRendered() {
  updateInspectorLive();
  renderStandby();
  decorateCalling();
  if (panelOpen(deptsEl())) {
    document.querySelectorAll('#deptList .dp-row').forEach(row => {
      const used = deptUsage(row.dataset.id);
      row.querySelector('.dp-used').textContent = used ? `${used} cue${used === 1 ? '' : 's'}` : 'unused';
    });
  }
}

function closeSidePanels() { closeInspector(); closeDepartments(); }

function initPanels() { wireInspector(); wireDepartments(); }
