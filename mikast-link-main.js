'use strict';

/**
 * MiKallbook: the MiKast link (main process) (MiKast Phase 4, Mike 2026-10-19)
 *
 * A show can be linked to one MiKast production (Utilities › MiKast Link).
 * MiKallbook then reads MiKast's files directly. It only ever reads them;
 * nothing is written to MiKast's folder, and there is no network.
 *
 *   <Production>.mikast   the calls as MiKast last saved them (its "link"
 *                         block: each call with who is called, and names)
 *   attendance.json       sign-ins, written by MiKast the moment they happen
 *
 * Both are checked every 2 s (modified time and size); when either changes the
 * page gets 'mikast:data'.
 *
 *   mikast:pick(showPath)          -> { canceled } | { path, rel }  (rel: relative to the show folder, when it has one)
 *   mikast:watch(showPath, ref)    -> starts watching ref = { path, rel }; the page then gets 'mikast:data'
 *   mikast:unwatch()
 *   'mikast:data' -> { ok:true, path, prod:{ id, name, link }, attendance, read }
 *                  | { ok:false, path, error:'missing'|'unreadable'|'old', message }
 */

const fs   = require('fs');
const path = require('path');

const POLL_MS = 2000;
const MAX_BYTES = 20 * 1024 * 1024;

module.exports = function setupMikastLink({ ipcMain, dialog, getMainWindow, rememberedDir, rememberDir }) {
  let watched = null;       // absolute path of the .mikast file
  let timer = 0;
  let sig = '';             // what was last sent: modified times and sizes

  const toPage = (data) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mikast:data', data);
  };

  function statSig(p) {
    try { const st = fs.statSync(p); return `${st.mtimeMs}:${st.size}`; } catch (_) { return 'none'; }
  }

  function readJson(p) {
    const st = fs.statSync(p);
    if (st.size > MAX_BYTES) throw new Error('too large');
    let text = fs.readFileSync(p, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  }

  // Read both files and say what they hold
  function readNow(p) {
    if (!fs.existsSync(p)) return { ok: false, path: p, error: 'missing', message: `${path.basename(p)} can't be found.` };
    let prod;
    try { prod = readJson(p); }
    catch (err) {
      // MiKast writes through a temporary file, so a half-written file is rare; the next check tries again
      return { ok: false, path: p, error: 'unreadable', message: `${path.basename(p)} can't be read (${err.message}).` };
    }
    if (!prod || prod.format !== 'mikast') return { ok: false, path: p, error: 'unreadable', message: `${path.basename(p)} isn't a MiKast production.` };
    if (!prod.link || !Array.isArray(prod.link.calls)) {
      return { ok: false, path: p, error: 'old', message: 'Open this production in MiKast and save it once, so MiKallbook can read its calls (MiKast from 2026-10-20 on).' };
    }
    let attendance = null;
    const ap = path.join(path.dirname(p), 'attendance.json');
    if (fs.existsSync(ap)) { try { attendance = readJson(ap); } catch (_) { attendance = null; } }
    return {
      ok: true, path: p, read: Date.now(),
      prod: { id: String(prod.id || ''), name: String(prod.name || path.basename(p, path.extname(p))), link: prod.link },
      attendance
    };
  }

  function check(force) {
    if (!watched) return;
    const s = statSig(watched) + '|' + statSig(path.join(path.dirname(watched), 'attendance.json'));
    if (!force && s === sig) return;
    sig = s;
    toPage(readNow(watched));
  }

  function stop() { clearInterval(timer); timer = 0; watched = null; sig = ''; }

  // { path, rel } -> the file to use: the absolute path if it is there, else the
  // relative one (the folders were moved together), else the absolute one (missing)
  function resolveRef(showPath, ref) {
    const abs = ref && typeof ref.path === 'string' ? ref.path : '';
    if (abs && fs.existsSync(abs)) return abs;
    if (ref && typeof ref.rel === 'string' && ref.rel && typeof showPath === 'string' && showPath) {
      const r = path.resolve(path.dirname(showPath), ref.rel);
      if (fs.existsSync(r)) return r;
    }
    return abs;
  }

  function relOf(showPath, abs) {
    if (typeof showPath !== 'string' || !showPath) return '';
    const rel = path.relative(path.dirname(showPath), abs);
    // Only for files near the show: in its folder, below it, or one level up and across (sibling show folders)
    if (!rel || path.isAbsolute(rel) || /^(\.\.[\\/]){2,}/.test(rel)) return '';
    return rel.split(path.sep).join('/');
  }

  ipcMain.handle('mikast:pick', async (_e, showPath) => {
    const w = getMainWindow();
    const r = await dialog.showOpenDialog(w, {
      title: 'Link to a MiKast Production',
      defaultPath: rememberedDir('mikast'),
      filters: [{ name: 'MiKast Production', extensions: ['mikast'] }],
      properties: ['openFile']
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const p = r.filePaths[0];
    rememberDir('mikast', path.dirname(path.dirname(p)));
    return { path: p, rel: relOf(showPath, p) };
  });

  ipcMain.handle('mikast:watch', (_e, showPath, ref) => {
    stop();
    const p = resolveRef(showPath, ref);
    if (!p) return { ok: false };
    watched = p;
    check(true);
    timer = setInterval(() => check(false), POLL_MS);
    return { ok: true, path: p, rel: relOf(showPath, p) };
  });

  ipcMain.handle('mikast:unwatch', () => { stop(); return { ok: true }; });

  return { shutdown: stop, _readNow: readNow, _relOf: relOf, _resolveRef: resolveRef };
};
