'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: script viewer
   Shows a document as a column of pages (or two-page spreads) inside a
   scrolling element. Each page sits in a "slot":

     .page-slot
       .page            the sheet (canvas), sized to the current zoom
       .page-gutter     right-margin strip for GO-point tabs (step 1d)
       .mark-layer      overlay across sheet + gutter for marks (step 1d)

   Pages come from a "source", so PDFs and pasted text share all of this:
     { kind, count, size(i) -> {w, h} in PDF points,
       render(i, canvas, scale, dpr) -> Promise, destroy(),
       locate(anchor) -> { page, x, y }      x/y as 0..1 of the page
       anchorAt(page, x, y) -> anchor }      what a click on the page stores
   PDF anchors are { page, x, y }; text anchors are { offset } into the text.

   PDF.js is loaded on first use from vendor/pdfjs (bundled; never a CDN).
   Only pages near the visible area keep a canvas; others are released.
   ════════════════════════════════════════════════════════════════════ */

(() => {

const VENDOR     = new URL('vendor/pdfjs/', document.baseURI).href;
const GUTTER     = 150;          // px: tab strip to the right of each page
const ROW_GAP    = 18;           // px between rows
const COL_GAP    = 22;           // px between the two pages of a spread
const PAD        = 18;           // px around the page column
const PT_TO_PX   = 96 / 72;      // 100% zoom = actual printed size
const ZOOM_MIN   = 0.25;
const ZOOM_MAX   = 4;
const KEEP_MARGIN = '1500px';    // render this far beyond the visible area

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(VENDOR + 'pdf.min.mjs').then(lib => {
      lib.GlobalWorkerOptions.workerSrc = VENDOR + 'pdf.worker.min.mjs';
      return lib;
    }).catch(err => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}

// ── PDF source ──────────────────────────────────────────────────────────
async function pdfSource(bytes) {
  const lib = await loadPdfjs();
  const task = lib.getDocument({
    data: bytes,
    cMapUrl: VENDOR + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: VENDOR + 'standard_fonts/',
    wasmUrl: VENDOR + 'wasm/',
    iccUrl: VENDOR + 'iccs/',
    isEvalSupported: false,
    enableXfa: false
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    try { await task.destroy(); } catch (_) {}
    if (err && err.name === 'PasswordException') throw new Error('This PDF is password-protected. Save an unprotected copy and import that.');
    if (err && err.name === 'InvalidPDFException') throw new Error('This file is not a readable PDF.');
    throw err;
  }

  // Page sizes up front, so the whole script can be laid out at once
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));
  const sizes = pages.map(p => {
    const vp = p.getViewport({ scale: 1 });
    return { w: vp.width, h: vp.height };
  });

  // Text positions per page, read in the background, so a click can snap
  // to the start of the word under it. Scanned pages have none: clicks
  // there stay exactly where they land.
  const words = new Array(pages.length).fill(null);   // [{ x, y, w, fh, str }] in points, y = baseline from top
  (async () => {
    for (let i = 0; i < pages.length; i++) {
      try {
        const vp = pages[i].getViewport({ scale: 1 });
        const tc = await pages[i].getTextContent();
        words[i] = tc.items.filter(it => it.str && it.str.trim() && it.width > 0).map(it => {
          const [bx, by] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
          const fh = Math.hypot(it.transform[2], it.transform[3]) || it.height || 12;
          return { x: bx, y: by, w: it.width, fh, str: it.str };
        });
      } catch (_) { words[i] = []; }
    }
  })();

  function snap(page, nx, ny) {
    const list = words[page];
    const sz = sizes[page];
    const cx = nx * sz.w, cy = ny * sz.h;
    if (!list || !list.length) return { page, x: nx, y: ny };
    let best = null, bestScore = Infinity;
    for (const it of list) {
      const top = it.y - it.fh * 0.8, bot = it.y + it.fh * 0.25;
      const dy = cy < top ? top - cy : (cy > bot ? cy - bot : 0);
      const dx = cx < it.x ? it.x - cx : (cx > it.x + it.w ? cx - (it.x + it.w) : 0);
      const score = dy * 4 + dx;
      if (score < bestScore) { bestScore = score; best = { it, dx, dy }; }
    }
    if (!best || best.dy > best.it.fh * 1.2 || best.dx > best.it.fh * 4) return { page, x: nx, y: ny };
    const it = best.it;
    // Where the leader can run: halfway between the bottom of the line above
    // (its baseline + descenders) and the tops of this line's capitals.
    const capTop = it.y - it.fh * 0.72;
    let above = null;
    for (const o of list) {
      if (o.y >= it.y - it.fh * 0.5) continue;                       // not above this line
      if (o.x > it.x + it.w + 20 || o.x + o.w < it.x - 20) continue; // a different column
      if (!above || o.y > above.y) above = o;
    }
    // Stay close to the word when there is plenty of space above it
    const runY = Math.max(capTop - it.fh * 0.4,
      above ? Math.min(capTop - 1, ((above.y + above.fh * 0.22) + capTop) / 2) : capTop - it.fh * 0.25);
    const cw = it.w / it.str.length;                    // average character width in this run
    let k = Math.max(0, Math.min(it.str.length - 1, Math.floor((cx - it.x) / cw)));
    if (it.str[k] === ' ') { while (k < it.str.length - 1 && it.str[k] === ' ') k++; }
    else { while (k > 0 && it.str[k - 1] !== ' ') k--; }
    return {
      page,
      x: (it.x + k * cw) / sz.w,
      y: (it.y - it.fh * 0.35) / sz.h,                  // middle of the letters
      gap: Math.round(((it.y - it.fh * 0.35) - runY) * 10) / 10   // points from there up to the clear run
    };
  }

  // The printed line an anchor sits on (cue sheets): the text runs on the
  // same baseline, left to right. '' on a scanned page or off the text.
  async function lineText(a) {
    const page = a && a.page | 0;
    if (!(page >= 0 && page < pages.length)) return '';
    for (let t = 0; words[page] === null && t < 150; t++) await new Promise(r => setTimeout(r, 100));
    const list = words[page];
    if (!list || !list.length) return '';
    const sz = sizes[page];
    const cy = (+a.y || 0) * sz.h;                       // middle of the letters (see snap)
    const on = list.filter(it => Math.abs((it.y - it.fh * 0.35) - cy) < it.fh * 0.55).sort((p, q) => p.x - q.x);
    if (!on.length) return '';
    let out = '', end = null;
    for (const it of on) {
      if (end !== null && it.x - end > it.fh * 0.2 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
      out += it.str;
      end = it.x + it.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  return {
    count: doc.numPages,
    size: i => sizes[i],
    lineText,
    async render(i, canvas, scale, dpr) {
      const vp = pages[i].getViewport({ scale });
      canvas.width  = Math.max(1, Math.floor(vp.width * dpr));
      canvas.height = Math.max(1, Math.floor(vp.height * dpr));
      const task = pages[i].render({ canvas, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null });
      canvas._task = task;
      await task.promise;
    },
    destroy() { try { task.destroy(); } catch (_) {} },
    kind: 'pdf',
    locate: a => ({ page: a.page | 0, x: +a.x || 0, y: +a.y || 0, gap: +a.gap || 0 }),
    anchorAt: (page, x, y) => snap(page, x, y)
  };
}

// ── Text source (pasted script) ─────────────────────────────────────────
// Drawn in the same black-on-white as a PDF page, so Dark mode and marks
// work identically. Characters are placed on a fixed 7.2 pt grid; if the
// installed monospace font is a different width it is squeezed to fit.
const TEXT_FONT = '"Courier New", Courier, "Liberation Mono", monospace';
let textAdvanceRatio = null;   // measured font width / expected width
function textSource(text, opts) {
  const T = window.MiTextDoc;
  const lay = T.layout(text, opts);
  return {
    kind: 'text',
    count: lay.pages,
    size: () => ({ w: T.PAGE_W, h: T.PAGE_H }),
    async render(i, canvas, scale, dpr) {
      const k = scale * dpr;
      canvas.width  = Math.max(1, Math.floor(T.PAGE_W * k));
      canvas.height = Math.max(1, Math.floor(T.PAGE_H * k));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      ctx.font = `${T.FONT_PT}px ${TEXT_FONT}`;
      if (textAdvanceRatio == null) {
        const w = ctx.measureText('M'.repeat(100)).width / 100;
        textAdvanceRatio = w > 0 ? w / T.CW : 1;
      }
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'alphabetic';
      const first = i * T.ROWS, last = Math.min(lay.lines.length, first + T.ROWS);
      for (let li = first; li < last; li++) {
        const ln = lay.lines[li];
        if (ln.end <= ln.start) continue;
        const y = T.TOP + (li - first) * T.LEAD + T.LEAD * 0.78;
        ctx.save();
        ctx.translate(T.LEFT + (ln.indent || 0) * T.CW, y);
        if (Math.abs(textAdvanceRatio - 1) > 0.01) ctx.scale(1 / textAdvanceRatio, 1);
        ctx.fillText(text.slice(ln.start, ln.end), 0, 0);
        ctx.restore();
      }
    },
    destroy() {},
    locate: a => Object.assign(T.locate(lay, a.offset | 0), { gap: T.LEAD * 0.5 + 0.1 }),
    // The line (up to its line break) an anchor sits in, cut to about 160
    // characters around the anchor for a long speech (cue sheets)
    lineText: async a => {
      const o = Math.max(0, Math.min(text.length, a && a.offset | 0));
      const s0 = text.lastIndexOf('\n', o - 1) + 1;
      let e0 = text.indexOf('\n', o);
      if (e0 < 0) e0 = text.length;
      let s = s0, e = e0;
      if (o - s > 60) { s = o - 60; while (s < o && text[s - 1] !== ' ') s++; }
      if (e - o > 100) { e = o + 100; while (e > o && text[e] !== ' ') e--; if (e <= o) e = o + 100; }
      return ((s > s0 ? '… ' : '') + text.slice(s, e).replace(/\s+/g, ' ').trim() + (e < e0 ? ' …' : '')).trim();
    },
    anchorAt: (page, x, y) => {
      // Snap to the start of the word under the click
      let o = T.anchorAt(lay, page, x, y);
      const ln = lay.lines[T.lineIndexFor(lay, o)];
      if (text[o] === ' ') { while (o < ln.end && text[o] === ' ') o++; }
      else { while (o > ln.start && text[o - 1] !== ' ') o--; }
      return { offset: o };
    }
  };
}

// ── Viewer ──────────────────────────────────────────────────────────────
class ScriptView {
  constructor(scrollEl) {
    this.el = scrollEl;
    this.source = null;
    this.slots = [];             // per page: { slot, page, gutter, layer, canvas, state, gen }
    this.spread = false;
    this.zoom = 'fit';           // 'fit' (page width), 'page' (whole page) or a number (1 = actual size)
    this.scale = 1;              // current points -> CSS px factor
    this.current = 0;            // current page index
    this.onPageChange = null;
    this.onLayout = null;        // called after pages are (re)laid out
    this._gen = 0;               // bumps on every re-layout; stale renders are dropped
    this._docGen = 0;            // bumps on every open/close

    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pages';
    this.el.appendChild(this.pagesEl);

    this._io = new IntersectionObserver(entries => this._onIntersect(entries), { root: this.el, rootMargin: KEEP_MARGIN });
    this._ro = new ResizeObserver(() => { if ((this.zoom === 'fit' || this.zoom === 'page') && this.source) this._relayoutSoon(); });
    this._ro.observe(this.el);
    this.el.addEventListener('scroll', () => this._onScroll(), { passive: true });
    // Ctrl + wheel zooms the script (and never the whole app)
    this.el.addEventListener('wheel', e => {
      if (!e.ctrlKey || !this.source) return;
      e.preventDefault();
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });
  }

  get pageCount() { return this.source ? this.source.count : 0; }

  // The script line an anchor sits on ('' if none or no script)
  async lineText(a) {
    if (!a || !this.source || !this.source.lineText) return '';
    try { return await this.source.lineText(a); } catch (_) { return ''; }
  }
  get zoomPercent() { return Math.round(this.scale / PT_TO_PX * 100); }

  openText(text, opts) {
    this._docGen++;
    this._setSource(textSource(text, opts));
    return true;
  }

  // Swap the text without losing the reader's place (after Edit Text)
  replaceText(text, opts) {
    const anchor = this._anchor();
    this._docGen++;
    if (this.source) this.source.destroy();
    this.source = textSource(text, opts);
    this._build();
    this._restore(anchor);
    this._emitPage(true);
  }

  async openPdf(bytes) {
    const gen = ++this._docGen;
    const src = await pdfSource(bytes);
    if (gen !== this._docGen) { src.destroy(); return false; }   // another open/close won
    this._setSource(src);
    return true;
  }

  close() {
    this._docGen++;
    this._setSource(null);
  }

  _setSource(src) {
    if (this.source) this.source.destroy();
    this.source = src;
    this.current = 0;
    this._build();
    this.el.scrollTop = 0;
    this._emitPage(true);
  }

  // Build one slot per page
  _build() {
    this._io.disconnect();
    this.pagesEl.innerHTML = '';
    this.slots = [];
    if (!this.source) return;
    for (let i = 0; i < this.source.count; i++) {
      const slot = document.createElement('div');
      slot.className = 'page-slot';
      slot.dataset.page = String(i);
      const page = document.createElement('div');
      page.className = 'page';
      const gutter = document.createElement('div');
      gutter.className = 'page-gutter';
      const layer = document.createElement('div');
      layer.className = 'mark-layer';
      const num = document.createElement('div');
      num.className = 'page-num';
      num.textContent = String(i + 1);
      gutter.appendChild(num);
      slot.append(page, gutter, layer);
      this.slots.push({ slot, page, gutter, layer, canvas: null, state: 'none', gen: -1 });
    }
    this._layout();
    this.slots.forEach(s => this._io.observe(s.slot));
  }

  // Arrange rows and size every page for the current zoom
  _layout() {
    if (!this.source) return;
    this._gen++;
    const perRow = this.spread ? 2 : 1;

    if (this.zoom === 'fit' || this.zoom === 'page') {
      let maxW = 1, maxH = 1;
      for (let i = 0; i < this.source.count; i++) { const z = this.source.size(i); maxW = Math.max(maxW, z.w); maxH = Math.max(maxH, z.h); }
      const avail = this.el.clientWidth - PAD * 2 - perRow * GUTTER - (perRow - 1) * COL_GAP - 2;
      let s = avail / (maxW * perRow);
      // Whole page: also no taller than the window
      if (this.zoom === 'page') s = Math.min(s, (this.el.clientHeight - PAD * 2 - 2) / maxH);
      this.scale = Math.max(ZOOM_MIN * PT_TO_PX, Math.min(ZOOM_MAX * PT_TO_PX, s));
    } else {
      this.scale = this.zoom * PT_TO_PX;
    }

    // Rows
    this.pagesEl.innerHTML = '';
    this.pagesEl.style.padding = PAD + 'px';
    this.pagesEl.style.gap = ROW_GAP + 'px';
    for (let i = 0; i < this.slots.length; i += perRow) {
      const row = document.createElement('div');
      row.className = 'page-row';
      row.style.gap = COL_GAP + 'px';
      for (let k = i; k < Math.min(i + perRow, this.slots.length); k++) row.appendChild(this.slots[k].slot);
      this.pagesEl.appendChild(row);
    }

    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const sz = this.source.size(i);
      const w = Math.round(sz.w * this.scale), h = Math.round(sz.h * this.scale);
      s.w = w; s.h = h;
      s.page.style.width = w + 'px';
      s.page.style.height = h + 'px';
      s.gutter.style.width = GUTTER + 'px';
      s.gutter.style.height = h + 'px';
      s.layer.style.width = (w + GUTTER) + 'px';
      s.layer.style.height = h + 'px';
      if (s.state !== 'none') s.state = 'stale';   // keep the old canvas (scaled) until the new one is ready
      if (s.canvas) { s.canvas.style.width = w + 'px'; s.canvas.style.height = h + 'px'; }
    }
    if (typeof this.onLayout === 'function') this.onLayout(this);
    this._renderVisible();
  }

  _relayoutSoon() {
    clearTimeout(this._relayoutTimer);
    this._relayoutTimer = setTimeout(() => this._relayoutKeepingPlace(), 120);
  }

  // Re-layout without losing the reader's place on the page
  _relayoutKeepingPlace() {
    if (!this.source) return;
    const anchor = this._anchor();
    this._layout();
    this._restore(anchor);
  }

  _anchor() {
    const i = this.current;
    const s = this.slots[i];
    if (!s) return null;
    const top = this._slotTop(s);
    return { i, frac: s.h ? (this.el.scrollTop - top) / s.h : 0 };
  }
  _restore(a) {
    if (!a || !this.slots.length) return;
    if (!this.slots[a.i]) a = { i: this.slots.length - 1, frac: 0 };
    const s = this.slots[a.i];
    this.el.scrollTop = this._slotTop(s) + a.frac * s.h;
    this._onScroll();
  }
  _slotTop(s) {
    // offsetTop of the row inside .pages (rows are the offset parents' children)
    return s.slot.parentElement ? s.slot.parentElement.offsetTop : 0;
  }

  // ── Rendering ────────────────────────────────────────────────────────
  _onIntersect(entries) {
    for (const e of entries) {
      const i = Number(e.target.dataset.page);
      const s = this.slots[i];
      if (!s) continue;
      s.near = e.isIntersecting;
      if (e.isIntersecting) this._render(i);
      else this._release(i);
    }
  }

  _renderVisible() {
    this.slots.forEach((s, i) => { if (s.near) this._render(i); });
  }

  async _render(i) {
    const s = this.slots[i];
    if (!s || !this.source) return;
    if (s.state === 'ready' && s.gen === this._gen) return;
    if (s.state === 'rendering' && s.gen === this._gen) return;
    const gen = this._gen, docGen = this._docGen, src = this.source;
    s.state = 'rendering'; s.gen = gen;
    // Fresh canvas per render: the old one stays visible until this one is done
    const canvas = document.createElement('canvas');
    s.pending = canvas;
    const dpr = window.devicePixelRatio || 1;
    try {
      await src.render(i, canvas, this.scale, dpr);
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      if (gen === this._gen && docGen === this._docGen) { s.state = 'error'; s.page.classList.add('error'); }
      console.error('[script] page', i + 1, 'failed:', err);
      return;
    }
    if (s.pending === canvas) s.pending = null;
    if (gen !== this._gen || docGen !== this._docGen || !s.near) return;   // superseded or scrolled away
    canvas.style.width = s.w + 'px';
    canvas.style.height = s.h + 'px';
    if (s.canvas) s.canvas.remove();
    s.page.appendChild(canvas);
    s.canvas = canvas;
    s.state = 'ready';
    s.page.classList.remove('error');
  }

  _release(i) {
    const s = this.slots[i];
    if (!s) return;
    if (s.pending && s.pending._task) { try { s.pending._task.cancel(); } catch (_) {} }
    s.pending = null;
    if (s.canvas) {
      if (s.canvas._task) { try { s.canvas._task.cancel(); } catch (_) {} }
      s.canvas.width = 0; s.canvas.height = 0;     // frees the bitmap now
      s.canvas.remove();
      s.canvas = null;
    }
    s.state = 'none';
  }

  // ── Page tracking and navigation ─────────────────────────────────────
  _onScroll() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      this._emitPage(false);
    });
  }

  _emitPage(force) {
    let cur = 0;
    if (this.slots.length) {
      // The current page is the first one whose row reaches past 30% of the view
      const line = this.el.scrollTop + this.el.clientHeight * 0.3;
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (this._slotTop(s) + s.h >= line) { cur = i; break; }
        cur = i;
      }
      if (this.spread) cur -= cur % 2;
    }
    if (force || cur !== this.current) {
      this.current = cur;
      if (typeof this.onPageChange === 'function') this.onPageChange(cur, this.pageCount);
    }
  }

  goToPage(i) {
    if (!this.slots.length) return;
    i = Math.max(0, Math.min(this.slots.length - 1, i | 0));
    this.el.scrollTop = Math.max(0, this._slotTop(this.slots[i]) - PAD);
    this._emitPage(false);
  }
  step(dir) {
    const n = this.spread ? 2 : 1;
    this.goToPage(this.current + dir * n);
  }

  // ── Zoom / spread ────────────────────────────────────────────────────
  setZoom(z) {
    if (z !== 'fit' && z !== 'page') z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number(z) || 1));
    this.zoom = z;
    this._relayoutKeepingPlace();
  }
  zoomBy(f) {
    const cur = this.scale / PT_TO_PX;
    this.setZoom(Math.round(cur * f * 100) / 100);
  }
  setSpread(on) {
    this.spread = !!on;
    this._relayoutKeepingPlace();
  }
}

window.MiScriptView = ScriptView;
window.MiScriptView.GUTTER = GUTTER;

})();
