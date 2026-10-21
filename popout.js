'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: Booth View
   Display only. Everything shown comes from the main window
   (calling.js boothState()). Space / Backspace go back to the main
   window as GO / Back; F11 or double-click toggles full screen.
   The menu in the top bar picks the full call or one department's view
   (the Operator view: state, cue, script excerpt, next two).
   ════════════════════════════════════════════════════════════════════ */

const $ = id => document.getElementById(id);
let lastFlash = 0;

function cueSpans(cues, big) {
  const frag = document.createDocumentFragment();
  if (!cues || !cues.length) {
    const s = document.createElement('span');
    s.textContent = 'GO';
    frag.appendChild(s);
    return frag;
  }
  cues.forEach((c, i) => {
    // " / " joins a combo cue to the MiKue cue that fires it ("LX 1.5 / SQ 2")
    const combo = c.sep === ' / ';
    if (i && (combo || !big)) {
      const sep = document.createElement('span');
      sep.className = 'b-sep';
      sep.textContent = combo ? '/' : '·';
      frag.appendChild(sep);
    }
    const s = document.createElement('span');
    s.style.color = c.color;
    s.textContent = c.text;
    frag.appendChild(s);
  });
  return frag;
}

function render(st) {
  $('bShow').textContent = st.show || 'MiKallbook';
  const mode = $('bMode');
  const mt = st.modeText || { text: st.mode === 'show' ? 'SHOW' : 'EDIT · not calling', kind: st.mode === 'show' ? 'show' : '' };
  mode.textContent = mt.text;
  mode.className = 'b-mode' + (mt.kind ? ' ' + mt.kind : '');
  renderViewMenu(st);
  document.body.classList.toggle('dept', !!st.dept);
  if (st.dept) { lastFlash = st.flash; renderDept(st.dept); return; }   // the department view shows GO itself
  lastExKey = null;

  const cues = $('bCues'), meta = $('bMeta'), note = $('bNote');
  cues.innerHTML = ''; meta.innerHTML = ''; note.textContent = '';
  if (!st.count) {
    cues.textContent = '-';
    meta.textContent = 'No GO points yet';
  } else if (st.end) {
    cues.innerHTML = '<span class="end">END</span>';
    meta.textContent = `All ${st.count} GO point${st.count === 1 ? '' : 's'} called`;
  } else if (st.standby) {
    // A Warn / Standby call is the next step (calling.js): say which, above its cues
    if (st.standby.step) {
      const lab = document.createElement('span');
      lab.className = 'b-step ' + st.standby.step;
      lab.textContent = st.standby.step === 'warn' ? 'WARNING' : 'STANDBY';
      cues.appendChild(lab);
    }
    cues.appendChild(cueSpans(st.standby.cues, true));
    meta.append((st.standby.step ? `${st.standby.step === 'warn' ? 'Warn' : 'Standby'} for GO ${st.standby.n} of ${st.count}` : `GO ${st.standby.n} of ${st.count}`) +
      (st.standby.page ? ` · page ${st.standby.page}` : ''));
    if (st.standby.visual) {
      const v = document.createElement('span');
      v.className = 'b-visual';
      v.textContent = 'VISUAL';
      meta.appendChild(v);
    }
    note.textContent = st.standby.note || '';
  }

  const last = $('bLast');
  last.innerHTML = '';
  if (st.last) last.appendChild(cueSpans(st.last.cues, false));
  else last.innerHTML = '<span class="b-empty">-</span>';

  const next = $('bNext');
  next.innerHTML = '';
  if (!st.next || !st.next.length) next.innerHTML = '<span class="b-empty">-</span>';
  (st.next || []).forEach(g => {
    const row = document.createElement('div');
    row.className = 'b-row';
    const n = document.createElement('span');
    n.className = 'b-n';
    n.textContent = String(g.n);
    row.appendChild(n);
    row.appendChild(cueSpans(g.cues, false));
    if (g.page) {
      const p = document.createElement('span');
      p.className = 'b-pg';
      p.textContent = `p.${g.page}`;
      row.appendChild(p);
    }
    next.appendChild(row);
  });

  if (st.flash && st.flash !== lastFlash) {
    lastFlash = st.flash;
    const m = $('bMain');
    m.classList.add('flash');
    setTimeout(() => m.classList.remove('flash'), 220);
  }
}

// ── View menu ─────────────────────────────────────────────────────────
function renderViewMenu(st) {
  const sel = $('bView');
  const opts = [{ v: 'all', t: 'Full call' }].concat((st.depts || []).map(d => ({ v: d.code, t: d.code + (d.name ? ' · ' + d.name : '') })));
  const html = opts.map(o => `<option value="${escAttr(o.v)}">${escHtml(o.t)}</option>`).join('');
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
  if (document.activeElement !== sel) sel.value = st.view || 'all';
}
function escHtml(v) { return String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }
function escAttr(v) { return escHtml(v).replace(/"/g, '&quot;'); }
$('bView').addEventListener('change', e => { window.booth.setView(e.target.value); e.target.blur(); });
$('bView').addEventListener('dblclick', e => e.stopPropagation());

// ── One department's view ─────────────────────────────────────────────
let lastExKey = null;
let lastEx = null;

function renderDept(d) {
  const main = $('dMain');
  main.className = 'b-main d-main dept-only st-' + d.state;
  $('dDept').textContent = d.code + (d.name ? ' · ' + d.name : '');
  $('dDept').style.color = d.color;
  $('dState').textContent = { go: 'GO', standby: 'STANDBY', warn: 'WARN', waiting: 'WAITING', none: '' }[d.state] || '';
  $('dSm').textContent = d.sm || '';

  const cues = $('dCues'), meta = $('dMeta'), note = $('dNote');
  cues.innerHTML = ''; meta.innerHTML = ''; note.textContent = ''; $('dMics').textContent = '';
  if (!d.cue) {
    cues.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'd-done';
    s.textContent = d.done || '';
    cues.appendChild(s);
  } else {
    cues.appendChild(cueSpans(d.cue.cues, true));
    if (d.cue.with) {
      const w = document.createElement('span');
      w.className = 'd-with';
      w.textContent = 'with ' + d.cue.with;
      cues.appendChild(w);
    }
    meta.append(`GO ${d.cue.n}` + (d.cue.page ? ` · page ${d.cue.page}` : '') +
      (d.cue.away > 0 ? ` · in ${d.cue.away} GO${d.cue.away === 1 ? '' : 's'}` : ''));
    if (d.cue.visual) {
      const v = document.createElement('span');
      v.className = 'b-visual';
      v.textContent = 'VISUAL';
      meta.appendChild(v);
    }
    note.textContent = d.cue.note || '';
    $('dMics').textContent = d.cue.mics || '';
  }

  // Excerpt: images arrive once per GO point ("same" = keep what's shown)
  const ex = d.excerpt;
  if (!ex) { if (lastExKey !== null) { $('dEx').innerHTML = ''; lastExKey = null; } }
  else if (!ex.same) { lastEx = ex; drawEx(ex); lastExKey = ex.key; }
  else if (ex.key !== lastExKey && lastEx && lastEx.key === ex.key) { drawEx(lastEx); lastExKey = ex.key; }

  // Then: the next two
  const next = $('dNext');
  next.innerHTML = '';
  if (!d.next.length) next.innerHTML = '<span class="b-empty d-card-meta">Nothing after this</span>';
  d.next.forEach(n => {
    const card = document.createElement('div');
    card.className = 'd-card';
    const head = document.createElement('div');
    head.className = 'd-card-head';
    head.appendChild(cueSpans(n.cues, true));
    const m = document.createElement('span');
    m.className = 'd-card-meta';
    m.textContent = `GO ${n.n}` + (n.page ? ` · p.${n.page}` : '');
    head.appendChild(m);
    card.appendChild(head);
    if (n.mics) {
      const mm = document.createElement('div');
      mm.className = 'd-card-mics';
      mm.textContent = n.mics;
      card.appendChild(mm);
    }
    if (n.note) {
      const nn = document.createElement('div');
      nn.className = 'd-card-note';
      nn.textContent = n.note;
      card.appendChild(nn);
    }
    next.appendChild(card);
  });
}

function pct(v, of) { return (100 * v / of).toFixed(3) + '%'; }

function drawEx(ex) {
  const box = $('dEx');
  box.innerHTML = '';
  if (!ex.clips.length) {
    if (ex.none) { const n = document.createElement('div'); n.className = 'd-exnone'; n.textContent = ex.none; box.appendChild(n); }
    return;
  }
  for (const c of ex.clips) {
    const wrap = document.createElement('div');
    wrap.className = 'd-clip';
    wrap.style.aspectRatio = `${c.w} / ${c.h}`;
    const img = document.createElement('img');
    img.src = c.src;
    img.draggable = false;
    wrap.appendChild(img);
    for (const p of c.marks) {
      if (p.kind === 'GO') {
        const band = document.createElement('div');
        band.className = 'd-band';
        band.style.left = pct(Math.max(0, p.x - 4), c.w);
        band.style.right = '0.5%';
        band.style.top = pct(p.y - p.half * 0.95, c.h);
        band.style.height = pct(p.half * 1.9, c.h);
        wrap.appendChild(band);
      }
      const tag = document.createElement('div');
      tag.className = 'd-tag';
      tag.textContent = p.kind;
      tag.style.top = pct(p.y, c.h);
      tag.style.borderColor = ex.color;
      tag.style.color = p.kind === 'GO' ? '#111' : ex.color;
      if (p.kind === 'GO') tag.style.background = ex.color;
      wrap.appendChild(tag);
      const arrow = document.createElement('div');
      arrow.className = 'd-arrow';
      arrow.style.left = pct(p.x, c.w);
      arrow.style.top = pct(p.y - p.half * 1.1, c.h);
      arrow.style.borderTopColor = ex.color;
      wrap.appendChild(arrow);
    }
    if (c.page) {
      const pg = document.createElement('div');
      pg.className = 'd-page';
      pg.textContent = `page ${c.page}`;
      wrap.appendChild(pg);
    }
    box.appendChild(wrap);
  }
  fitEx();
}

// Shrink the clips (keeping their shape) until they all fit the space
function fitEx() {
  const box = $('dEx');
  const clips = [...box.querySelectorAll('.d-clip')];
  if (!clips.length) return;
  clips.forEach(c => { c.style.width = '100%'; });
  const need = box.scrollHeight, have = box.clientHeight;
  if (have > 0 && need > have) {
    const f = Math.max(0.3, (have - 2) / need);
    clips.forEach(c => { c.style.width = (f * 100).toFixed(2) + '%'; });
  }
}
let fitTimer = 0;
window.addEventListener('resize', () => { clearTimeout(fitTimer); fitTimer = setTimeout(fitEx, 100); });

function tick() {
  const d = new Date();
  $('bClock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}
tick();
setInterval(tick, 1000);

window.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) window.booth.key('go'); }
  else if (e.key === 'Backspace') { e.preventDefault(); if (!e.repeat) window.booth.key('back'); }
  else if (e.key === 'F11') { e.preventDefault(); window.booth.key('fullscreen'); }
});
document.addEventListener('dblclick', e => { if (e.target.closest('select')) return; window.booth.key('fullscreen'); });

window.booth.onState(render);
window.booth.ready();
