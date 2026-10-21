'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: department cue sheets (Phase 3c)
   One sheet per department, or the whole calling order ("All"): each GO
   point in calling order with its cue, page, the script line of its GO
   (and of its Standby and Warn, when marked), VISUAL, the note, and what
   else is called on the same GO. Combo cues show which SQ cue fires them.

   Line text comes from the script: pasted text always; a text PDF through
   PDF.js; a scanned PDF has none (page only).

   Save PDF (landscape, into <Show>/reports/), Save CSV (same folder), Print.
   Uses app.js / marks.js / operator.js / cuelists.js / reports.js globals.
   ════════════════════════════════════════════════════════════════════ */

let csOpen = false;
let csDept = 'all';          // 'all' or a department id
let csRows = null;           // built rows for csDept, or null while reading
let csSeq = 0;

function cueSheetsDialogIsOpen() { return csOpen; }

function openCueSheets() {
  if (mode !== 'edit') return;
  if (csDept !== 'all' && !deptById(csDept)) csDept = 'all';
  csOpen = true;
  document.getElementById('csOverlay').classList.add('open');
  buildCueRows();
}
function closeCueSheets() {
  csOpen = false;
  document.getElementById('csOverlay').classList.remove('open');
}

function csDeptLabel(id) {
  if (id === 'all') return 'All departments';
  const d = deptById(id);
  return d ? (d.name ? `${d.name} (${d.code})` : d.code) : '?';
}

// GO points on this sheet, in calling order
function csGoPoints(id) {
  const list = orderedGoPoints();
  return id === 'all' ? list : list.filter(gp => gp.cues.some(c => c.dept === id));
}

// Read the script lines for the sheet (async for PDFs), then draw
async function buildCueRows() {
  const seq = ++csSeq;
  csRows = null;
  renderCueSheets();
  const all = orderedGoPoints();
  const index = new Map(all.map((g, k) => [g.id, k + 1]));
  const rows = await Promise.all(csGoPoints(csDept).map(async gp => {
    const p = goPos(gp);
    const sb = anchorPos(gp.standby), w = anchorPos(gp.warn);
    let goLine, sbLine, wLine;
    if (p && p.ro) {                         // running order: the item's title (and the line the GO is on)
      const it = roItem(gp.at.item);
      goLine = it ? (it.title || 'Untitled') + (gp.at.line ? ` · on “${gp.at.line}”` : '') : '';
      sbLine = ''; wLine = '';
    } else {
      [goLine, sbLine, wLine] = await Promise.all([
        p ? view.lineText(gp.at) : '', sb ? view.lineText(gp.standby) : '', w ? view.lineText(gp.warn) : ''
      ]);
    }
    const mine = csDept === 'all' ? gp.cues : cuesOf(gp, csDept);
    const cue = csDept === 'all'
      ? (gp.cues.length ? goText(gp) : 'GO')
      : mine.map(c => c.number).join(', ');
    const fired = mine.filter(c => c.via).map(c => {
      const [dId, num] = String(c.of || '').split('|');
      const d = deptById(dId);
      return `${cueText(c)} fired by ${d ? d.code : 'SQ'} ${num || ''}`.trim();
    });
    return {
      n: index.get(gp.id),
      cue,
      page: p ? p.page + 1 : null,
      sbPage: sb ? sb.page + 1 : null, wPage: w ? w.page + 1 : null,
      go: goLine, sb: sbLine, w: wLine,
      placed: !!p,
      visual: !!gp.visual,
      note: gp.note || '',
      with: csDept === 'all' ? '' : notCuesOf(gp, csDept).map(cueText).join(' · '),
      fired: fired.join('; '),
      // who wears the mics (MiKast); on All departments each line says which cue
      mics: csDept === 'all' ? (typeof micWhoLines === 'function' ? micWhoLines(mine) : []) : micWhoTexts(mine)
    };
  }));
  if (seq !== csSeq || !csOpen) return;
  csRows = rows;
  renderCueSheets();
}

function csScanned() {
  return show.document.type === 'script' && csRows && csRows.some(r => r.placed) && !csRows.some(r => r.go);
}

function renderCueSheets() {
  const body = document.getElementById('csBody');
  const all = orderedGoPoints();
  const depts = show.departments.map(d => {
    const n = all.filter(gp => gp.cues.some(c => c.dept === d.id)).length;
    return `<div class="rp-item cs-item${csDept === d.id ? ' sel' : ''}" data-dept="${d.id}">
      <div class="rp-item-t"><span class="cs-chip" style="background:${esc(d.color)}"></span>${esc(d.name || d.code)}</div>
      <div class="rp-item-m"><span>${esc(d.code)}</span><span>${n ? `${n} cue${n === 1 ? '' : 's'}` : 'none'}</span></div>
    </div>`;
  }).join('');
  const isAll = csDept === 'all';
  let table;
  if (!csRows) table = '<div class="in-empty cs-wait">Reading the script…</div>';
  else if (!csRows.length) table = `<div class="in-empty cs-wait">${isAll ? 'No GO points marked yet.' : 'No cues for this department yet.'}</div>`;
  else {
    table = `<table class="cs-table">
      <thead><tr><th>GO</th><th>${isAll ? 'Cues' : 'Cue'}</th><th>${isRO() ? 'Item' : 'Page'}</th><th>${isRO() ? 'Item' : 'Script line'}</th><th>${isAll ? 'Note' : 'Also called · Note'}</th></tr></thead>
      <tbody>${csRows.map(r => `<tr>
        <td class="cs-n">${r.n}</td>
        <td class="cs-cue${r.mics.length ? ' has-mics' : ''}">${esc(r.cue)}${r.visual ? ' <span class="mk-vis">VISUAL</span>' : ''}${r.mics.map(t => `<div class="cs-mics">${esc(t)}</div>`).join('')}</td>
        <td class="cs-pg">${r.page || '-'}</td>
        <td class="cs-line">${lineCell(r)}</td>
        <td class="cs-note">${[r.with ? `<div class="cs-with">with ${esc(r.with)}</div>` : '', r.fired ? `<div class="cs-with">${esc(r.fired)}</div>` : '', r.note ? `<div>${esc(r.note)}</div>` : ''].join('')}</td>
      </tr>`).join('')}</tbody></table>`;
  }
  body.innerHTML = `
    <div class="rp-side">
      <div class="rp-side-head"><span class="mi-label">Cue Sheets</span><span class="mi-label">${esc(show.name || '')}</span></div>
      <div class="rp-list mi-scroll">
        <div class="rp-item cs-item${isAll ? ' sel' : ''}" data-dept="all">
          <div class="rp-item-t">All departments</div>
          <div class="rp-item-m"><span>calling order</span><span>${all.length} GO${all.length === 1 ? '' : 's'}</span></div>
        </div>
        ${depts}
      </div>
    </div>
    <div class="rp-main">
      <div class="rp-head">
        <div class="rp-head-t">
          <div class="rp-title">${esc(csDeptLabel(csDept))}</div>
          <div class="rp-sub">${csRows ? `${csRows.length} ${isAll ? 'GO point' : 'cue'}${csRows.length === 1 ? '' : 's'} in calling order` : ''}${csScanned() ? ' · scanned script: no line text, page numbers only' : ''}${docState !== 'ready' && show.document.type !== 'none' ? ' · the script isn’t loaded: page numbers only' : ''}</div>
        </div>
      </div>
      <div class="rp-scroll mi-scroll">${table}</div>
      <div class="rp-foot">
        <div class="tb-fill"></div>
        <button class="mi-btn" data-act="csv" title="Save as a spreadsheet file (CSV) in the show’s reports folder"${csRows && csRows.length ? '' : ' disabled'}>Save CSV</button>
        <button class="mi-btn" data-act="print" title="Print (Ctrl+P)"${csRows && csRows.length ? '' : ' disabled'}>Print</button>
        <button class="mi-btn" data-act="pdf" title="Save as a PDF in the show’s reports folder"${csRows && csRows.length ? '' : ' disabled'}>Save PDF</button>
        <button class="mi-btn mi-btn-go" data-act="close" style="padding:9px 18px">Close</button>
      </div>
    </div>`;
}

function lineCell(r) {
  if (!r.placed) return `<span class="cs-none">${isRO() ? 'not on an item' : 'not placed on the script'}</span>`;
  const out = [];
  if (r.w) out.push(`<div class="cs-sub"><b>W</b>${r.wPage && r.wPage !== r.page ? ` p.${r.wPage}` : ''} ${esc(r.w)}</div>`);
  if (r.sb) out.push(`<div class="cs-sub"><b>SB</b>${r.sbPage && r.sbPage !== r.page ? ` p.${r.sbPage}` : ''} ${esc(r.sb)}</div>`);
  out.push(`<div class="cs-go">${r.go ? esc(r.go) : '<span class="cs-none">-</span>'}</div>`);
  return out.join('');
}

// ── Output ────────────────────────────────────────────────────────────
function csFileBase() {
  const d = csDept === 'all' ? null : deptById(csDept);
  return `Cue Sheet - ${d ? d.code + (d.name ? ' ' + d.name : '') : 'All'}`.replace(/[\\/:*?"<>|]+/g, '-').trim();
}

function cueSheetDocHtml() {
  const isAll = csDept === 'all';
  const d = isAll ? null : deptById(csDept);
  const printed = new Date().toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const line = r => {
    if (!r.placed) return '<span class="none">not placed</span>';
    return (r.w ? `<div class="sub"><b>W</b>${r.wPage && r.wPage !== r.page ? ` p.${r.wPage}` : ''} ${esc(r.w)}</div>` : '') +
      (r.sb ? `<div class="sub"><b>SB</b>${r.sbPage && r.sbPage !== r.page ? ` p.${r.sbPage}` : ''} ${esc(r.sb)}</div>` : '') +
      `<div>${r.go ? esc(r.go) : '<span class="none">-</span>'}</div>`;
  };
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(show.name || 'Show')} · ${esc(csFileBase())}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1a1a1a; font-size: 9.5pt; line-height: 1.3; }
  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
  .show { font-size: 17pt; font-weight: 700; }
  .what { font-size: 11.5pt; font-weight: 600; color: #333; margin-top: 1px; }
  .what .chip { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: 0; }
  .meta { font-size: 9pt; color: #555; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 1px; color: #555; border-bottom: 1.5px solid #444; padding: 3px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr { break-inside: avoid; }
  td.n { width: 34px; color: #777; text-align: right; }
  td.cue { width: ${csRows.some(r => r.mics.length) ? '26%' : isAll ? '15%' : '9%'}; font-weight: 700; font-size: 10.5pt; white-space: nowrap; }
  td.pg { width: 40px; text-align: center; }
  td.note { width: 26%; }
  .sub { color: #666; font-size: 8.5pt; }
  .sub b { display: inline-block; min-width: 18px; color: #888; font-weight: 600; }
  .with { color: #555; font-size: 8.5pt; }
  .vis { font-size: 7pt; font-weight: 700; letter-spacing: 0.5px; border: 1px solid #996; color: #663; border-radius: 2px; padding: 0 2px; margin-left: 4px; vertical-align: 1px; }
  .none { color: #999; }
  .mics { font-size: 8.5pt; font-weight: 400; color: #333; white-space: normal; }
  footer { margin-top: 10px; font-size: 7.5pt; color: #888; display: flex; justify-content: space-between; }
</style></head><body>
<header>
  <div><div class="show">${esc(show.name || 'Untitled Show')}</div>
    <div class="what">${d ? `<span class="chip" style="background:${esc(d.color)}"></span>` : ''}Cue Sheet · ${esc(csDeptLabel(csDept))}</div></div>
  <div class="meta">${csRows.length} ${isAll ? 'GO point' : 'cue'}${csRows.length === 1 ? '' : 's'} · calling order</div>
</header>
<table>
  <thead><tr><th style="text-align:right">GO</th><th>${isAll ? 'Cues' : 'Cue'}</th><th style="text-align:center">${isRO() ? 'Item' : 'Page'}</th><th>${isRO() ? 'Item' : 'Script line'}</th><th>${isAll ? 'Note' : 'Also called · Note'}</th></tr></thead>
  <tbody>${csRows.map(r => `<tr>
    <td class="n">${r.n}</td>
    <td class="cue">${esc(r.cue)}${r.visual ? '<span class="vis">VISUAL</span>' : ''}${r.mics.map(t => `<div class="mics">${esc(t)}</div>`).join('')}</td>
    <td class="pg">${r.page || '-'}</td>
    <td>${line(r)}</td>
    <td class="note">${r.with ? `<div class="with">with ${esc(r.with)}</div>` : ''}${r.fired ? `<div class="with">${esc(r.fired)}</div>` : ''}${r.note ? `<div>${esc(r.note)}</div>` : ''}</td>
  </tr>`).join('')}</tbody>
</table>
<footer><span>${esc(show.name || '')} · ${esc(csDeptLabel(csDept))}</span><span>MiKallbook · ${esc(printed)}</span></footer>
</body></html>`;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function cueSheetCsv() {
  const isAll = csDept === 'all';
  const withMics = csRows.some(r => r.mics.length);
  const head = ['GO', isAll ? 'Cues' : 'Cue', isRO() ? 'Item' : 'Page', isRO() ? 'Item title' : 'GO line', 'Standby line', 'Standby page', 'Warn line', 'Warn page', 'Visual', 'Also called', 'Fired by', 'Note']
    .concat(withMics ? ['Mic names'] : []);
  const rows = csRows.map(r => [r.n, r.cue, r.page || '', r.go, r.sb, r.sbPage || '', r.w, r.wPage || '', r.visual ? 'Yes' : '', r.with, r.fired, r.note]
    .concat(withMics ? [r.mics.join(' / ')] : []));
  return [head, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

async function savedAsk(path) {
  const ans = await ask('Cue sheet saved', path, [
    { label: 'Show in Folder', value: 'folder' },
    { label: 'Open', value: 'open' },
    { label: 'OK', value: 'ok', cls: 'mi-btn-go' }
  ], 'ok');
  if (ans === 'open') bridge.reports.open(path);
  else if (ans === 'folder') bridge.reports.reveal(path);
}

async function csPdfCmd() {
  if (!csRows || !csRows.length || !(await ensureSavedForReports())) return;
  let r;
  try { r = await bridge.reports.savePdf(cueSheetDocHtml(), showPath, csFileBase() + '.pdf', { landscape: true }); }
  catch (err) { toast('PDF failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.error) { toast('PDF failed: ' + (r ? r.error : 'no answer'), 'err'); return; }
  await savedAsk(r.path);
}
async function csCsvCmd() {
  if (!csRows || !csRows.length || !(await ensureSavedForReports())) return;
  let r;
  try { r = await bridge.reports.saveText(cueSheetCsv(), showPath, csFileBase() + '.csv'); }
  catch (err) { toast('CSV failed: ' + cleanErr(err), 'err'); return; }
  if (!r || r.error) { toast('CSV failed: ' + (r ? r.error : 'no answer'), 'err'); return; }
  await savedAsk(r.path);
}
async function csPrintCmd() {
  if (!csRows || !csRows.length) return;
  let r;
  try { r = await bridge.reports.print(cueSheetDocHtml(), { landscape: true }); }
  catch (err) { toast('Print failed: ' + cleanErr(err), 'err'); return; }
  if (r && !r.ok && r.reason && !/cancel/i.test(r.reason)) toast('Print failed: ' + r.reason, 'err');
}

// ── Keys and wiring ───────────────────────────────────────────────────
function cueSheetsDialogKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { e.preventDefault(); closeCueSheets(); return; }
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveShow(e.shiftKey); return; }
  if (ctrl && e.key.toLowerCase() === 'p') { e.preventDefault(); csPrintCmd(); return; }
  if (ctrl && ['o', 'n', 'z', 'y'].includes(e.key.toLowerCase())) { e.preventDefault(); return; }
  // ↑ ↓ move through the departments
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const ids = ['all', ...show.departments.map(d => d.id)];
    const i = ids.indexOf(csDept);
    const j = Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (j !== i) { csDept = ids[j]; buildCueRows(); }
  }
}

function initCueSheets() {
  document.getElementById('btnCueSheets').addEventListener('click', openCueSheets);
  document.getElementById('csOverlay').addEventListener('click', async e => {
    if (e.target === e.currentTarget) { closeCueSheets(); return; }
    const item = e.target.closest('.cs-item');
    if (item) { csDept = item.dataset.dept; buildCueRows(); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') closeCueSheets();
    else if (act === 'pdf') await csPdfCmd();
    else if (act === 'csv') await csCsvCmd();
    else if (act === 'print') await csPrintCmd();
  });
}
