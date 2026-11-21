'use strict';
/**
 * MiKollection: the window's menu bar (2026-11-20, the same as MiKonsole).
 * Shared by every Mi app; keep the copies identical. Load it after app.js.
 *
 * As the app (window.miMenuBar from preload.js), the File / Utilities menu
 * bar replaces the header's New / Open / Save / Save As buttons, the file
 * status, the Utilities dropdown and Exit (mi-theme.css hides them under
 * html.mk-app). They stay in the page, hidden: every menu command clicks
 * the same button the header did, so nothing about saving or opening changed.
 *
 *   - The Utilities dropdown (#utilMenu) is copied into the menu bar, and
 *     copied again whenever it changes (items shown or hidden by mode,
 *     renamed, added), so the two always match.
 *   - Open Recent and a double-clicked file go through the page's
 *     openRecent(path), which asks to save first, like Open.
 */
(function () {
  const api = window.miMenuBar;
  if (!api || typeof api.setUtil !== 'function') return;     // plain browser: keep the header buttons
  document.documentElement.classList.add('mk-app');

  const um = document.getElementById('utilMenu');
  const isShown = el => !el.hidden && getComputedStyle(el).display !== 'none';

  // What the Utilities dropdown holds right now
  function snapshot() {
    if (!um) return [];
    const out = [];
    let n = 0;
    for (const el of um.children) {
      if (el.classList.contains('menu-sep')) {
        out.push({ sep: true, hidden: !isShown(el) });
      } else if (el.classList.contains('menu-item')) {
        if (!el.id) el.id = 'mkMenuItem' + (n++);
        const first = el.querySelector('span');
        const hint  = el.querySelector('.menu-hint');
        out.push({
          id: el.id,
          label: ((first || el).textContent || '').trim(),
          key: hint ? (hint.textContent || '').trim() : '',
          hidden: !isShown(el),
          disabled: !!el.disabled
        });
      } else if (el.classList.contains('menu-note')) {
        out.push({ note: true, label: (el.textContent || '').trim(), hidden: !isShown(el) });
      }
    }
    return out;
  }

  let last = '', timer = 0;
  function push() {
    timer = 0;
    const items = snapshot();
    const k = JSON.stringify(items);
    if (k === last) return;
    last = k;
    try { api.setUtil(items); } catch (_) {}
  }
  const soon = () => { if (!timer) timer = setTimeout(push, 60); };
  if (um) new MutationObserver(soon).observe(um, { subtree: true, childList: true, attributes: true, characterData: true });
  // Mode classes on <body> show and hide some items (Edit / Show / Operator)
  new MutationObserver(soon).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  push();

  const busy = () => typeof modalOpen === 'function' && modalOpen();
  const click = id => { const el = document.getElementById(id); if (el && !el.disabled) el.click(); };

  // main.js runPageCmd() calls this
  window.__mkMenuCmd = function (cmd, arg) {
    switch (cmd) {
      case 'new':    if (!busy()) click('btnNew');    break;
      case 'open':   if (!busy()) click('btnOpen');   break;
      case 'save':   if (!busy()) click('btnSave');   break;
      case 'saveas': if (!busy()) click('btnSaveAs'); break;
      case 'about':  if (!busy()) click('miAbout');   break;
      case 'util': {
        const el = arg && document.getElementById(arg);
        if (el && um && um.contains(el) && !busy()) click(arg);
        break;
      }
      case 'open-path':
        if (arg && typeof openRecent === 'function' && !busy()) openRecent(arg);
        break;
    }
  };

  // A file double-clicked to start the app (or that arrived while it started)
  if (typeof api.takePending === 'function') {
    api.takePending()
      .then(p => { if (p) window.__mkMenuCmd('open-path', p); })
      .catch(err => console.error('[menu] pending file:', err));
  }
})();
