'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: pasted-text scripts
   Lays plain text out as fixed script pages and keeps marks attached to
   the text when it is edited.

   Page: US Letter (612 x 792 pt), 1" margins, 12 pt monospace,
   65 characters per line, 54 lines per page. Wrapping counts characters,
   so the layout is identical on every computer whatever font is installed.

   Script layout (on by default) is a display rule only, so it never
   changes the text or the offsets marks are stored at:
     - short ALL-CAPS lines (character names, titles) are centered
     - "( ... )" stage directions are indented 15 characters, with a blank
       row before and after
     - short "( ... )" asides inside a speech are indented 10 characters

   rejoinLines() repairs text copied out of a PDF, where every printed line
   arrives as a hard line break.

   Marks on a text script store a character offset into the text
   ({ offset }), not a page position. After an edit, remapOffsets() moves
   each offset to the same spot in the new text; marks whose text was
   deleted or rewritten are flagged so they can be checked.

   Pure functions; works in the page (window.MiTextDoc) and in Node tests.
   ════════════════════════════════════════════════════════════════════ */

(function (root) {

const PAGE_W = 612, PAGE_H = 792;          // points
const LEFT   = 72,  TOP    = 72;           // 1" margins
const COLS   = 65;                         // characters per line
const LEAD   = 12;                         // points per line (6 lines per inch)
const ROWS   = 54;                         // lines per page
const CW     = 7.2;                        // points per character (12 pt mono = 0.6 em)
const FONT_PT = 12;
const TAB    = '    ';

// Clean pasted text once, before it is stored: one kind of line break,
// tabs as spaces, no stray control characters, no trailing spaces.
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, TAB)
    .replace(/[   ]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n').map(l => l.replace(/\s+$/, '')).join('\n')
    .replace(/\n+$/, '');
}

// ── Recognising script elements ──────────────────────────────────────
const DIRECTION_INDENT = 15;   // characters (about 1.5")
const ASIDE_INDENT     = 10;   // characters (about 1")
const ASIDE_MAX        = 25;   // a "( ... )" this short, inside a speech, is an aside

// A character name or title: short, all capitals, optionally followed by
// a parenthetical such as (Continued), (CONT'D), (V.O.)
function isNameLine(t) {
  t = t.trim();
  if (!t || t.length > 40) return false;
  const m = t.match(/^([^()]*?)\s*(\([^()]*\))?$/);
  if (!m) return false;
  const name = m[1];
  if ((name.match(/[A-Za-z]/g) || []).length < 2) return false;
  if (/[a-z]/.test(name)) return false;
  return /^[A-Z0-9][A-Z0-9 .,'’&\-]*$/.test(name) && /[A-Z.]$/.test(name);
}
function isParenLine(t) { return /^\s*\(/.test(t); }

// Wrap one paragraph s (starting at text offset o) into lines of width cols.
function wrapPara(lines, s, o, indent, cols) {
  let i = 0;
  while (i < s.length && s[i] === ' ' && indent > 0) i++;   // indented elements ignore their own leading spaces
  if (i >= s.length) { lines.push({ start: o + i, end: o + i, indent: 0 }); return; }
  while (i < s.length) {
    if (s.length - i <= cols) { lines.push({ start: o + i, end: o + s.length, indent }); break; }
    // last space within this line's width, so words are not split
    let j = s.lastIndexOf(' ', i + cols);
    if (j <= i || j < i + Math.floor(cols / 3)) j = -1;          // no useful break: cut the word
    if (j > 0) {
      lines.push({ start: o + i, end: o + j, indent });
      i = j + 1;                                                 // the space is not drawn
    } else {
      lines.push({ start: o + i, end: o + i + cols, indent });
      i += cols;
    }
  }
}

// Wrap into display lines: [{ start, end, indent, gap? }] offsets into text
// (end exclusive). gap rows are blank spacing added by script layout.
function layout(text, opts) {
  const script = !opts || opts.script !== false;
  const lines = [];
  const blankLast = () => !lines.length || lines[lines.length - 1].end === lines[lines.length - 1].start;
  const gapRow = o => { if (!blankLast()) lines.push({ start: o, end: o, indent: 0, gap: true }); };
  let o = 0;
  const paras = text.split('\n');
  let prevKind = 'blank';
  for (let p = 0; p < paras.length; p++) {
    const s = paras[p];
    let kind = 'text';
    if (!s.trim()) kind = 'blank';
    else if (script && isNameLine(s)) kind = 'name';
    else if (script && isParenLine(s)) {
      // An aside sits inside a speech: text (or a name) before it, and the speech carries on after it
      const next = paras[p + 1];
      const speechGoesOn = next != null && next.trim() && !isNameLine(next) && !isParenLine(next);
      kind = (s.trim().length <= ASIDE_MAX && (prevKind === 'text' || prevKind === 'name') && speechGoesOn) ? 'aside' : 'direction';
    }

    if (kind === 'blank') {
      lines.push({ start: o, end: o, indent: 0 });
    } else if (kind === 'name') {
      gapRow(o);
      const t = s.trim();
      const lead = s.length - s.trimStart().length;
      lines.push({ start: o + lead, end: o + lead + t.length, indent: Math.max(0, Math.floor((COLS - t.length) / 2)) });
    } else if (kind === 'direction') {
      gapRow(o);
      wrapPara(lines, s, o, DIRECTION_INDENT, COLS - DIRECTION_INDENT);
    } else if (kind === 'aside') {
      wrapPara(lines, s, o, ASIDE_INDENT, COLS - ASIDE_INDENT);
    } else {
      // Plain text after a stage direction gets breathing room too
      if (prevKind === 'direction') gapRow(o);
      wrapPara(lines, s, o, 0, COLS);
    }
    prevKind = kind;
    o += s.length + 1;   // + the '\n'
  }
  if (!lines.length) lines.push({ start: 0, end: 0, indent: 0 });
  const pages = Math.max(1, Math.ceil(lines.length / ROWS));
  return { lines, pages };
}

// ── Repairing text copied from a PDF ─────────────────────────────────
// Joins lines that were only broken because the printed page ran out of
// width. Works on the raw pasted text (trailing spaces are a strong hint
// that the line was wrapped, so this runs before normalize()).
function rejoinLines(raw) {
  // Page numbers from the PDF ("1", "2", "Page 3") are dropped, so a speech
  // that ran over a page break joins back together.
  const src = String(raw == null ? '' : raw).replace(/\r\n?|[\u2028\u2029\u000b\u000c]/g, '\n').split('\n')
    .filter(l => !/^\s*(page\s*)?\d{1,4}\.?\s*$/i.test(l));
  // A line much shorter than the usual printed width ended its paragraph
  const lens = src.map(l => l.trim().length).filter(n => n > 0).sort((a, b) => a - b);
  const typical = lens.length ? lens[Math.floor(lens.length * 0.8)] : 0;
  const shortLine = n => typical > 30 && n < typical * 0.6;
  const out = [];
  let open = 0;            // unclosed "(" in the paragraph being built
  let canJoin = false;     // may the next line continue the last output line?
  for (const line of src) {
    const t = line.trim();
    const softWrapped = /[ \t\u00a0]$/.test(line);
    if (!t) { out.push(''); canJoin = false; open = 0; continue; }
    const name = isNameLine(t), paren = isParenLine(t);
    const joinable = canJoin && !name && (open > 0 || !paren);
    if (joinable) {
      const prev = out[out.length - 1];
      out[out.length - 1] = (/-$/.test(prev) && !/ -$/.test(prev) ? prev : prev + ' ') + t;
    } else {
      out.push(t);
      open = 0;
    }
    for (const ch of t) { if (ch === '(') open++; else if (ch === ')') open = Math.max(0, open - 1); }
    if (name) { canJoin = false; continue; }
    if (open > 0) { canJoin = true; continue; }
    const endsSentence = /[.!?:;)\]"”’…]$/.test(t) || /[.!?]["”’)]?$/.test(t);
    // A line that ran the full printed width was wrapped, even if it ends a sentence
    const fullWidth = typical > 30 && t.length >= typical * 0.85;
    canJoin = softWrapped || fullWidth || (!endsSentence && !shortLine(t.length));
    // a closed "( ... )" direction is its own paragraph
    if (paren && open === 0) canJoin = false;
  }
  return out.join('\n');
}

// Does this pasted text look like it was copied out of a PDF?
function looksHardWrapped(raw) {
  const lines = String(raw || '').replace(/\r\n?|[\u2028\u2029\u000b\u000c]/g, '\n').split('\n').filter(l => l.trim() && !isNameLine(l));
  if (lines.length < 8) return false;
  let broken = 0;
  for (const l of lines) if (/[ \t\u00a0]$/.test(l) || !/[.!?:;)\]"”’…]$/.test(l.trim())) broken++;
  return broken / lines.length > 0.35;
}

// The display line holding a character offset
function lineIndexFor(lay, offset) {
  const L = lay.lines;
  let lo = 0, hi = L.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (L[mid].start <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Character offset -> { page, x, y } with x/y as 0..1 of the page (y = middle of the line)
function locate(lay, offset) {
  const li = lineIndexFor(lay, Math.max(0, offset | 0));
  const ln = lay.lines[li];
  const col = Math.max(0, Math.min(ln.end - ln.start, offset - ln.start));
  const row = li % ROWS;
  return {
    page: Math.floor(li / ROWS),
    x: (LEFT + ((ln.indent || 0) + col) * CW) / PAGE_W,
    y: (TOP + row * LEAD + LEAD * 0.5) / PAGE_H
  };
}

// Point on a page (x/y 0..1) -> nearest character offset
function anchorAt(lay, page, nx, ny) {
  const first = page * ROWS;
  const last  = Math.min(lay.lines.length - 1, first + ROWS - 1);
  if (first > last) return lay.lines[lay.lines.length - 1].end;
  let row = Math.floor((ny * PAGE_H - TOP) / LEAD);
  const li = Math.max(first, Math.min(last, first + row));
  const ln = lay.lines[li];
  let col = Math.round((nx * PAGE_W - LEFT) / CW) - (ln.indent || 0);
  col = Math.max(0, Math.min(ln.end - ln.start, col));
  return ln.start + col;
}

// ── Keeping marks attached through an edit ───────────────────────────
// Line-level Myers diff (after trimming the common start and end), then
// character-level matching inside each changed block.

function lineStarts(lines) {
  const s = new Array(lines.length + 1);
  let o = 0;
  for (let i = 0; i < lines.length; i++) { s[i] = o; o += lines[i].length + 1; }
  s[lines.length] = o;
  return s;
}

const MAX_D = 2000;   // give up on a fine diff past this many changed lines

// Myers shortest edit script on arrays a, b. Returns a list of
// { type: 'eq'|'chg', a0, a1, b0, b1 } blocks covering both arrays, or null.
function diffLines(a, b) {
  const N = a.length, M = b.length;
  if (!N && !M) return [];
  const max = N + M;
  const trace = [];
  let v = new Map([[1, 0]]);
  let found = false;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    const nv = new Map();
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      nv.set(k, x);
      if (x >= N && y >= M) { found = true; break; }
    }
    trace.push(nv);
    v = nv;
    if (found) break;
  }
  if (!found) return null;

  // Walk back to collect matched (equal) line pairs
  const pairs = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK;
    if (d === 0) prevK = 0;
    else {
      const vp = trace[d - 1];
      prevK = (k === -d || (k !== d && (vp.get(k - 1) ?? -1) < (vp.get(k + 1) ?? -1))) ? k + 1 : k - 1;
    }
    const prevX = d === 0 ? 0 : trace[d - 1].get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; pairs.push([x, y]); }
    if (d > 0) { x = prevX; y = prevY; }
  }
  pairs.reverse();

  // Group into blocks
  const blocks = [];
  let ia = 0, ib = 0;
  for (let p = 0; p < pairs.length; ) {
    const [pa, pb] = pairs[p];
    if (pa > ia || pb > ib) blocks.push({ type: 'chg', a0: ia, a1: pa, b0: ib, b1: pb });
    let q = p;
    while (q + 1 < pairs.length && pairs[q + 1][0] === pairs[q][0] + 1 && pairs[q + 1][1] === pairs[q][1] + 1) q++;
    blocks.push({ type: 'eq', a0: pa, a1: pairs[q][0] + 1, b0: pb, b1: pairs[q][1] + 1 });
    ia = pairs[q][0] + 1; ib = pairs[q][1] + 1;
    p = q + 1;
  }
  if (ia < N || ib < M) blocks.push({ type: 'chg', a0: ia, a1: N, b0: ib, b1: M });
  return blocks;
}

// Map character offsets in oldText to newText.
// Returns [{ offset, moved }] in the same order; moved = the text at that
// spot was deleted or rewritten, so the mark should be checked.
function remapOffsets(oldText, newText, offsets) {
  if (oldText === newText) return offsets.map(o => ({ offset: o, moved: false }));
  const A = oldText.split('\n'), B = newText.split('\n');
  const sa = lineStarts(A), sb = lineStarts(B);

  let blocks = diffLines(A, B);
  if (!blocks) blocks = [{ type: 'chg', a0: 0, a1: A.length, b0: 0, b1: B.length }];

  return offsets.map(off0 => {
    const off = Math.max(0, Math.min(oldText.length, off0 | 0));
    // line of the offset in the old text
    let lo = 0, hi = A.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sa[mid] <= off) lo = mid; else hi = mid - 1; }
    const line = lo;
    const blk = blocks.find(b => line >= b.a0 && line < b.a1) || blocks[blocks.length - 1];
    if (!blk) return { offset: 0, moved: true };

    if (blk.type === 'eq') {
      return { offset: sb[blk.b0 + (line - blk.a0)] + (off - sa[line]), moved: false };
    }
    // Lines deleted outright: the mark's text is gone
    if (blk.b0 === blk.b1) return { offset: Math.min(newText.length, sb[blk.b0]), moved: true };
    // Changed block: match characters from its start and from its end
    const aS = sa[blk.a0], aE = Math.max(aS, sa[blk.a1] - 1);
    const bS = sb[blk.b0], bE = Math.max(bS, sb[blk.b1] - 1);
    const oa = oldText.slice(aS, aE), nb = newText.slice(bS, bE);
    let pre = 0;
    while (pre < oa.length && pre < nb.length && oa[pre] === nb[pre]) pre++;
    let suf = 0;
    while (suf < oa.length - pre && suf < nb.length - pre && oa[oa.length - 1 - suf] === nb[nb.length - 1 - suf]) suf++;
    const rel = off - aS;
    if (rel < pre) return { offset: bS + rel, moved: false };
    if (rel >= oa.length - suf) return { offset: bS + nb.length - (oa.length - rel), moved: false };
    return { offset: Math.min(newText.length, bS + pre), moved: true };
  });
}

const api = {
  PAGE_W, PAGE_H, LEFT, TOP, COLS, LEAD, ROWS, CW, FONT_PT,
  normalize, layout, locate, anchorAt, lineIndexFor, remapOffsets, diffLines,
  rejoinLines, looksHardWrapped, isNameLine
};
if (typeof module === 'object' && module.exports) module.exports = api;
else root.MiTextDoc = api;

})(typeof window !== 'undefined' ? window : globalThis);
