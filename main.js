'use strict';

/**
 * MiKallbook: Electron main process
 *
 *   - One main window (same reveal pattern as MiKonsole and MiKue: born at
 *     work-area size, maximized at opacity 0, then revealed; 10 s failsafe)
 *   - Show files: open and save. Each show lives in its own folder:
 *       <Show>/<Show>.mikallbook   (JSON; older .micallbook files still open)
 *       <Show>/script/             (the script PDF, copied in on save)
 *       <Show>/reports/            (rehearsal / performance report PDFs)
 *   - Close requests go to the page first so unsaved changes can be kept
 *   - Live link to operators' computers on the local network (link-main.js)
 *
 * The script never leaves this computer: nothing here uploads anything.
 * The live link sends only the calling position and cue numbers, never the script.
 */

const { app, BrowserWindow, ipcMain, dialog, screen, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');

// ── Settings carried over from MiCallbook (renamed MiKallbook 2026-10-19) ──────────
// The app's data folder follows package.json "name" (micallbook → mikallbook). The
// first time MiKallbook starts with no data folder of its own, MiCallbook's is copied
// in (settings, saved preferences, unsaved-session recovery). The old folder
// is left as it was. Must run before anything uses userData (single-instance
// lock, sessions, localStorage).
(function carryOverOldSettings() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'micallbook');
    const newDir = app.getPath('userData');
    if (path.resolve(oldDir).toLowerCase() === path.resolve(newDir).toLowerCase()) return;
    if (!fs.existsSync(oldDir)) return;
    if (fs.existsSync(path.join(newDir, 'Local Storage')) || fs.existsSync(path.join(newDir, 'micallbook-settings.json'))) return;
    const skip = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket',
                          'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad']);
    fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false,
                                 filter: src => !skip.has(path.basename(src)) });
  } catch (err) {
    console.error('Could not carry over MiCallbook settings:', err && err.message);
  }
})();

// Same Windows DPI handling as MiKonsole (see its main.js for the history)
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('high-dpi-support', 'true');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
}

const SHOW_EXT   = 'mikallbook';
const OLD_EXT    = 'micallbook';   // MiCallbook show files (before 2026-10-19): opened, then saved as .mikallbook beside them
const SCRIPT_DIR = 'script';
const REPORT_DIR = 'reports';

let mainWindow = null;
let allowClose = false;

// ── Window ────────────────────────────────────────────────────────────────
function createMainWindow() {
  // Window/taskbar icon at runtime, once MiKallbook has one
  const iconPath = path.join(__dirname, 'icon.png');

  let bounds = null;
  try {
    bounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch (err) {
    console.error('[main] could not read display work area:', err);
  }

  const win = new BrowserWindow({
    ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
               : { width: 1600, height: 900 }),
    minWidth: 1100,
    minHeight: 680,
    title: 'MiKallbook',
    backgroundColor: '#141414',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    opacity: 0,
    // Closable (2026-11-20, as MiKonsole): the title-bar X, Alt+F4 and taskbar
    // Close all reach the 'close' handler below, which hands them to the page's
    // Exit (Save changes? / Exit?). File > Exit in the menu bar does the same.
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The show clock and calling view keep running when the window is
      // covered or minimised.
      backgroundThrottling: false
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));

  let revealed = false;
  const forceReveal = () => {
    if (revealed || win.isDestroyed()) return;
    revealed = true;
    try { win.setOpacity(1); } catch (_) {}
    if (!win.isVisible()) win.show();
  };
  const failsafe = setTimeout(() => {
    console.error('[main] ready-to-show did not fire within 10s; forcing reveal');
    forceReveal();
  }, 10000);

  win.once('ready-to-show', () => {
    clearTimeout(failsafe);
    win.maximize();
    win.show();
    setTimeout(forceReveal, 250);
  });

  // Close goes through the page so it can ask about unsaved changes.
  // A crashed or never-loaded page must not be able to block closing.
  win.on('close', (e) => {
    if (allowClose) return;
    const wc = win.webContents;
    if ((typeof wc.isCrashed === 'function' && wc.isCrashed()) || wc.isLoading()) return;
    e.preventDefault();
    wc.send('app:close-request');
  });
  win.on('session-end', () => { allowClose = true; releaseWindows(); });
  win.on('closed', () => { clearTimeout(failsafe); if (mainWindow === win) mainWindow = null; });

  return win;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function uniqueTarget(dir, fileName, srcStat) {
  const ext  = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let n = 2;
  while (fs.existsSync(candidate)) {
    // Same name and same size: treat as the same file already copied
    try {
      if (fs.statSync(candidate).size === srcStat.size) return { target: candidate, exists: true };
    } catch (_) {}
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return { target: candidate, exists: false };
}

function writeFileAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// The script PDF, if the show has one: { path, name }
function pdfRef(show) {
  const d = show && show.document;
  return d && d.type === 'script' && d.pdf && typeof d.pdf.path === 'string' && d.pdf.path ? d.pdf : null;
}


// ── Remembered folders: file dialogs open where you were last ────────────
// 'shows' = the folder that holds the show folders (Open, first Save,
// Save As); the import kinds = the folder last picked from. Kept in this
// computer's settings; a folder that no longer exists falls back to Documents.
function rememberedDir(kind) {
  const d = (readSettings().dirs || {})[kind];
  try { if (d && fs.statSync(d).isDirectory()) return d; } catch (_) {}
  return app.getPath('documents');
}
function rememberDir(kind, dir) {
  if (!dir) return;
  const s = readSettings();
  s.dirs = Object.assign({}, s.dirs, { [kind]: dir });
  writeSettings(s);
}
// <Shows>/<Name>/<Name>.ext -> <Shows> (a show file not in its own folder -> its folder)
function showsDirOf(showPath) {
  const dir = path.dirname(showPath);
  return path.basename(dir) === path.basename(showPath, path.extname(showPath)) ? path.dirname(dir) : dir;
}

// ── IPC: show files ───────────────────────────────────────────────────────
// ── Recent files, for the start screen (2026.01 step 2; the same as MiStage) ──
const RECENT_MAX = 8;
function recentKind(show) { return show && show.document && show.document.type === 'runningOrder' ? 'concert' : 'script'; }
function recentList() {
  const r = readSettings().recents;
  return Array.isArray(r) ? r.filter(x => x && typeof x.path === 'string' && x.path) : [];
}
function addRecent(p, data) {
  const s = readSettings();
  const key = q => path.resolve(q).toLowerCase();
  s.recents = [{ path: p, name: path.basename(p, path.extname(p)), kind: recentKind(data) }]
    .concat(recentList().filter(x => key(x.path) !== key(p)))
    .slice(0, RECENT_MAX);
  writeSettings(s);
  try { app.addRecentDocument(s.recents[0].path); } catch (_) {}   // Windows Jump List / Mac Dock menu
  installAppMenu();                                                // File > Open Recent (2026-11-20)
}
// The start screen's list: files that are still there
ipcMain.handle('show:recents', () => recentList()
  .filter(x => { try { return fs.statSync(x.path).isFile(); } catch (_) { return false; } })
  .map(x => ({ path: x.path, name: String(x.name || path.basename(x.path, path.extname(x.path))), kind: String(x.kind || recentKind()), folder: path.dirname(x.path) })));
// Open one of them. Only paths on the recent list, so the page can't ask for any file.
ipcMain.handle('show:openPath', (_e, p) => {
  p = String(p || '');
  if (!recentList().some(x => x.path === p) && !launchPaths.has(p)) return { error: 'That file is not on the recent list.' };
  return readShowFile(p);
});

ipcMain.handle('show:open', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Show',
    defaultPath: rememberedDir('shows'),
    filters: [{ name: 'MiKallbook Show', extensions: [SHOW_EXT, OLD_EXT] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };

  return readShowFile(r.filePaths[0]);
});

// Read a show file (Open, and the start screen's Recent list)
function readShowFile(filePath) {
  let showPath = filePath;
  const showDir  = path.dirname(showPath);
  // An old .micallbook show is read as it is; showPath becomes <Name>.mikallbook beside it,
  // so the first save writes the new file and the old one is never touched.
  let convertedPath = null;
  if (path.extname(showPath).toLowerCase() === '.' + OLD_EXT) {
    const newPath = path.join(showDir, path.basename(showPath, path.extname(showPath)) + '.' + SHOW_EXT);
    if (fs.existsSync(newPath)) {
      const c = dialog.showMessageBoxSync(mainWindow, {
        type: 'question', buttons: ['Open the MiKallbook copy', 'Cancel'], defaultId: 0, cancelId: 1,
        message: `This show has already been saved as "${path.basename(newPath)}".`,
        detail: 'Open that copy instead? (The old .micallbook file is kept as it was.)'
      });
      if (c !== 0) return { canceled: true };
      showPath = newPath;
    } else {
      convertedPath = newPath;
    }
  }
  rememberDir('shows', showsDirOf(showPath));
  let show;
  try {
    show = JSON.parse(fs.readFileSync(showPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { error: `"${path.basename(showPath)}" is no longer there. It may have been moved or deleted.` };
    return { error: 'Could not read show file: ' + err.message };
  }
  if (!show || show.format !== 'micallbook' || !show.document || typeof show.document !== 'object') {
    return { error: 'Not a MiKallbook show file.' };
  }

  const missing = [];
  const pdf = pdfRef(show);
  if (pdf) {
    const p = path.isAbsolute(pdf.path) ? pdf.path : path.join(showDir, pdf.path);
    pdf.path = p;
    if (!fs.existsSync(p)) missing.push(p);
  }
  if (!convertedPath) addRecent(showPath, show);
  if (convertedPath) return { show, showPath: convertedPath, missing, converted: true };
  return { show, showPath, missing };
}

ipcMain.handle('show:save', async (_e, show, existingPath) => {
  let showPath = existingPath;

  if (!showPath) {
    const base0 = (show && show.name ? String(show.name) : 'Untitled Show').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled Show';
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Show (a show folder is created for it)',
      defaultPath: path.join(rememberedDir('shows'), base0 + '.' + SHOW_EXT),
      filters: [{ name: 'MiKallbook Show', extensions: [SHOW_EXT] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };

    let chosen = r.filePath;
    if (path.extname(chosen).toLowerCase() !== '.' + SHOW_EXT) chosen += '.' + SHOW_EXT;
    const base = path.basename(chosen, path.extname(chosen));
    const dir  = path.dirname(chosen);

    // Each show lives in its own folder: <Name>/<Name>.mikallbook + script/ + reports/
    const showDir = path.basename(dir) === base ? dir : path.join(dir, base);
    showPath = path.join(showDir, base + '.' + SHOW_EXT);
    if (showPath !== chosen && fs.existsSync(showPath)) {
      const c = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning', buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `A show named "${base}" already exists in that location.`,
        detail: 'Replace it?'
      });
      if (c !== 0) return { canceled: true };
    }
  }

  const showDir   = path.dirname(showPath);
  const scriptDir = path.join(showDir, SCRIPT_DIR);
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(path.join(showDir, REPORT_DIR), { recursive: true });
  } catch (err) {
    return { error: 'Could not create the show folder: ' + err.message };
  }

  // Copy the script PDF into script/. pathMap tells the page where it now lives.
  const out = JSON.parse(JSON.stringify(show));
  const pathMap = {};
  const missing = [];
  const pdf = pdfRef(out);
  if (pdf) {
    const src = pdf.path;
    let target = null;
    if (isInside(src, scriptDir)) {
      target = src;
    } else if (!fs.existsSync(src)) {
      missing.push(src);              // keep the old absolute path in the file
    } else {
      try {
        const st = fs.statSync(src);
        const u  = uniqueTarget(scriptDir, path.basename(src), st);
        if (!u.exists) fs.copyFileSync(src, u.target);
        target = u.target;
      } catch (err) {
        return { error: `Could not copy "${path.basename(src)}" into the show folder: ${err.message}` };
      }
    }
    if (target) {
      pathMap[src] = target;
      pdf.path = path.relative(showDir, target).split(path.sep).join('/');
    }
  }

  rememberDir('shows', showsDirOf(showPath));
  out.format  = 'micallbook';
  out.version = 1;
  out.savedAt = new Date().toISOString();

  try {
    writeFileAtomic(showPath, JSON.stringify(out, null, 2));
  } catch (err) {
    return { error: 'Could not write the show file: ' + err.message };
  }
  addRecent(showPath, out);
  return { showPath, pathMap, missing };
});

// ── IPC: script PDF ───────────────────────────────────────────────────────
ipcMain.handle('script:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Script (PDF)',
    defaultPath: rememberedDir('script'),
    filters: [{ name: 'PDF Script', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const p = r.filePaths[0];
  rememberDir('script', path.dirname(p));
  return { path: p, name: path.basename(p) };
});

ipcMain.handle('script:read', async (_e, p) => {
  if (typeof p !== 'string' || !p) throw new Error('No file path');
  if (path.extname(p).toLowerCase() !== '.pdf') throw new Error('Not a PDF: ' + path.basename(p));
  return await fs.promises.readFile(p);   // arrives in the page as a Uint8Array
});

// ── IPC: app ──────────────────────────────────────────────────────────────
ipcMain.on('app:title', (_e, t) => {
  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setDocumentEdited(/\s\*$/.test(String(t || ''))); } catch (_) {}   // 2026-11-20
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(t);
});

ipcMain.on('app:copy', (_e, text) => {
  try { clipboard.writeText(String(text || '')); } catch (_) {}
});

// ── IPC: reports (PDF into <Show>/reports/, or print) ─────────────────────
// The page sends the finished report as a complete HTML document. It is
// loaded into a hidden window (scripts off) and printed from there.
async function loadReportWindow(html) {
  const tmp = path.join(app.getPath('temp'), `micallbook-report-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, String(html || ''), 'utf8');
  const win = new BrowserWindow({
    show: false, width: 816, height: 1056,
    webPreferences: { contextIsolation: true, nodeIntegration: false, javascript: false, sandbox: true }
  });
  try {
    await win.loadFile(tmp);
  } catch (err) {
    try { win.destroy(); } catch (_) {}
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw err;
  }
  return { win, tmp };
}
function closeReportWindow(r) {
  try { if (!r.win.isDestroyed()) r.win.destroy(); } catch (_) {}
  try { fs.unlinkSync(r.tmp); } catch (_) {}
}
// <Show>/reports for a show file path
function reportsDirOf(showPath) {
  if (typeof showPath !== 'string' || path.extname(showPath).toLowerCase() !== '.' + SHOW_EXT) return null;
  return path.join(path.dirname(showPath), REPORT_DIR);
}

// opts: { landscape } (cue sheets are landscape)
ipcMain.handle('report:pdf', async (_e, html, showPath, fileName, opts) => {
  const dir = reportsDirOf(showPath);
  if (!dir) return { error: 'The show has not been saved.' };
  let name = String(fileName || 'Report').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Report';
  if (path.extname(name).toLowerCase() !== '.pdf') name += '.pdf';
  const target = path.join(dir, name);
  let r;
  try {
    fs.mkdirSync(dir, { recursive: true });
    r = await loadReportWindow(html);
    const data = await r.win.webContents.printToPDF({
      pageSize: 'Letter', printBackground: true, landscape: !!(opts && opts.landscape),
      margins: { top: 0.5, bottom: 0.5, left: 0.6, right: 0.6 }
    });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);              // replaces this report's earlier PDF
    return { path: target };
  } catch (err) {
    const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM');
    return { error: busy ? `${name} is open in another program. Close it and try again.` : (err && err.message) || String(err) };
  } finally {
    if (r) closeReportWindow(r);
  }
});

ipcMain.handle('report:print', async (_e, html, opts) => {
  let r;
  try { r = await loadReportWindow(html); }
  catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
  return await new Promise(resolve => {
    r.win.webContents.print({ silent: false, printBackground: true, landscape: !!(opts && opts.landscape) }, (ok, reason) => {
      closeReportWindow(r);
      resolve({ ok: !!ok, reason: ok ? '' : String(reason || '') });
    });
  });
});

// A text file (cue sheet CSV) into <Show>/reports/. Starts with a BOM so Excel reads it as UTF-8.
ipcMain.handle('report:text', async (_e, text, showPath, fileName) => {
  const dir = reportsDirOf(showPath);
  if (!dir) return { error: 'The show has not been saved.' };
  const name = String(fileName || 'Export.csv').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Export.csv';
  if (!/\.(csv|txt)$/i.test(name)) return { error: 'Only .csv or .txt files.' };
  const target = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, '\ufeff' + String(text || ''), 'utf8');
    fs.renameSync(tmp, target);
    return { path: target };
  } catch (err) {
    const busy = err && (err.code === 'EBUSY' || err.code === 'EPERM');
    return { error: busy ? `${name} is open in another program (Excel?). Close it and try again.` : (err && err.message) || String(err) };
  }
});

// Open a saved report file, or show it in Explorer (PDF / CSV in a reports folder only)
function isReportPdf(p) {
  return typeof p === 'string' && /^\.(pdf|csv|txt)$/i.test(path.extname(p)) &&
         path.basename(path.dirname(p)) === REPORT_DIR && fs.existsSync(p);
}
ipcMain.handle('report:open', async (_e, p) => { if (isReportPdf(p)) await shell.openPath(p); return true; });
ipcMain.handle('report:reveal', (_e, p) => { if (isReportPdf(p)) shell.showItemInFolder(p); return true; });

// ── Booth View (pop-out calling view) ─────────────────────────────────────
// A second window for a booth monitor. It shows what the main window sends
// it (popout:state) and never needs the keyboard: Space / Backspace pressed
// while it is in front are passed to the main window as GO / Back.
// Its monitor, position and size are remembered on this computer.
let popoutWin = null;
let popoutSaveTimer = null;

function settingsPath() { return path.join(app.getPath('userData'), 'micallbook-settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {}; } catch (_) { return {}; }
}
function writeSettings(obj) {
  try { writeFileAtomic(settingsPath(), JSON.stringify(obj, null, 2)); } catch (_) {}
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// Where to open: the remembered place if that monitor is still connected,
// otherwise centered on a monitor other than the main window's, if there is one.
function popoutBounds() {
  const saved = readSettings().popout;
  const displays = screen.getAllDisplays();
  if (saved && saved.bounds) {
    const d = displays.find(x => x.id === saved.displayId) || displays.find(x => rectsOverlap(x.workArea, saved.bounds));
    if (d && rectsOverlap(d.workArea, saved.bounds)) return { bounds: saved.bounds, fullScreen: !!saved.fullScreen, maximized: !!saved.maximized };
  }
  let mainDisplay = screen.getPrimaryDisplay();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainDisplay = screen.getDisplayMatching(mainWindow.getBounds()); } catch (_) {}
  const target = displays.find(x => x.id !== mainDisplay.id) || mainDisplay;
  const wa = target.workArea;
  const width = Math.min(1100, wa.width - 40), height = Math.min(800, wa.height - 40);
  return {
    bounds: { x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2), width, height },
    fullScreen: false
  };
}

function savePopoutPlace() {
  if (!popoutWin || popoutWin.isDestroyed()) return;
  clearTimeout(popoutSaveTimer);
  popoutSaveTimer = setTimeout(() => {
    if (!popoutWin || popoutWin.isDestroyed()) return;
    const fullScreen = popoutWin.isFullScreen();
    const maximized = !fullScreen && popoutWin.isMaximized();
    const s = readSettings();
    const prev = s.popout || {};
    // Keep the normal (restored) size, so un-maximizing / leaving full screen goes back to it
    let bounds = popoutWin.getNormalBounds();
    if (fullScreen && prev.bounds) bounds = prev.bounds;
    let displayId = prev.displayId;
    try { displayId = screen.getDisplayMatching(popoutWin.getBounds()).id; } catch (_) {}
    s.popout = { bounds, displayId, fullScreen, maximized };
    writeSettings(s);
  }, 300);
}

function openPopout() {
  if (popoutWin && !popoutWin.isDestroyed()) { popoutWin.showInactive(); return true; }
  const place = popoutBounds();
  const iconPath = path.join(__dirname, 'icon.png');
  popoutWin = new BrowserWindow({
    ...place.bounds,
    minWidth: 480,
    minHeight: 320,
    title: 'MiKallbook · Booth View',
    backgroundColor: '#111111',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'popout-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  popoutWin.setMenuBarVisibility(false);
  popoutWin.loadFile(path.join(__dirname, 'popout.html'));
  popoutWin.once('ready-to-show', () => {
    if (!popoutWin || popoutWin.isDestroyed()) return;
    popoutWin.showInactive();                      // don't take the keyboard from the main window
    if (place.fullScreen) popoutWin.setFullScreen(true);
    else if (place.maximized) popoutWin.maximize();
  });
  ['move', 'resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(ev => popoutWin.on(ev, savePopoutPlace));
  popoutWin.on('closed', () => {
    popoutWin = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('popout:closed');
  });
  return true;
}

ipcMain.handle('popout:open', () => openPopout());
ipcMain.handle('popout:close', () => { if (popoutWin && !popoutWin.isDestroyed()) popoutWin.close(); return true; });
ipcMain.handle('popout:isOpen', () => !!(popoutWin && !popoutWin.isDestroyed()));

// Main window -> Booth View
ipcMain.on('popout:state', (_e, state) => {
  if (popoutWin && !popoutWin.isDestroyed()) popoutWin.webContents.send('popout:state', state);
});
// Booth View loaded: ask the main window for the current state
ipcMain.on('popout:ready', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('popout:want-state');
});
// Booth View picked what to show (full call or a department) -> main window
ipcMain.on('popout:view', (_e, v) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('popout:view', String(v || 'all').slice(0, 12));
});
// Keys pressed in the Booth View -> main window
ipcMain.on('popout:key', (_e, k) => {
  if (k === 'fullscreen') {
    if (popoutWin && !popoutWin.isDestroyed()) popoutWin.setFullScreen(!popoutWin.isFullScreen());
    return;
  }
  if ((k === 'go' || k === 'back') && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('popout:key', k);
});

// ── Live link between computers (SM shares, operators join) ───────────────
const link = require('./link-main')({
  ipcMain,
  getMainWindow: () => mainWindow,
  readSettings,
  writeSettings
});

// ── MiKast link: calls become sessions, sign-ins fill the report ──────────
// Reads the linked production's files (never writes them). mikast-link-main.js
const mikastLink = require('./mikast-link-main')({
  ipcMain, dialog,
  getMainWindow: () => mainWindow,
  rememberedDir, rememberDir
});

function releaseWindows() {
  BrowserWindow.getAllWindows().forEach(w => {
    if (!w.isDestroyed()) { try { w.setClosable(true); } catch (_) {} }
  });
}

// ── User Manual window (Utilities › User Manual / F1) ──────────────────────
// One window, reused if already open. Exit closes it with everything else.
const MANUAL_FILE = 'MiKallbook_Manual_v2.html';
let manualWindow = null;
ipcMain.handle('app:version', () => app.getVersion());   // About (row 8)

ipcMain.on('app:manual', () => {
  if (manualWindow && !manualWindow.isDestroyed()) {
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.focus();
    return;
  }
  const file = path.join(__dirname, MANUAL_FILE);
  if (!fs.existsSync(file)) { console.error('[main] manual not found:', file); return; }
  const iconPath = path.join(__dirname, 'icon.png');
  manualWindow = new BrowserWindow({
    width: 1200, height: 800,
    title: 'MiKallbook Manual',
    backgroundColor: '#111110',
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  manualWindow.setMenuBarVisibility(false);
  manualWindow.loadFile(file);
  manualWindow.on('page-title-updated', e => e.preventDefault());   // keep "MiKallbook Manual"
  manualWindow.on('closed', () => { manualWindow = null; });
});

ipcMain.on('app:quit', () => {
  allowClose = true;
  releaseWindows();
  app.quit();
});

// ── Outside links open in the browser ─────────────────────────────────────
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const fileArg = findFileArg(argv);              // a file double-clicked while running (2026-11-20)
    if (fileArg) setTimeout(() => queueOpen(fileArg), 0);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Menu bar: File / Utilities (2026-11-20, the same as MiKonsole) ──────────
// Replaces the header's New / Open / Save / Save As buttons, its Utilities
// dropdown and its Exit button (mi-menubar.js in the page hides them). Every
// item runs what the header button did: runPageCmd() asks the page, which
// clicks that same button, so nothing about saving or opening changed.
//
// Windows: the menu is set on the main window only (setMenu); the application
// menu stays null, so the manual and every other window still have no menu
// bar. Only our own items: no Reload (Ctrl+R) or Developer Tools
// (Ctrl+Shift+I) as in Electron's default menu (2026.01, row 12/13). The page
// keeps its own Ctrl+N/O/S/Shift+S keys (registerAccelerator:false: the menu
// only shows them).
// Mac: the menu belongs to the app. App menu (About, Hide, Quit), File, Edit
// (Electron's role: copy / paste / undo in text boxes), Utilities, Window.
// Cmd+Q goes through before-quit, which asks the page first.
let utilMenuItems = [];          // the page's Utilities dropdown ('menubar:util')
let pendingOpen   = null;        // a file double-clicked before the page was ready
let openReady     = false;
const launchPaths = new Set();   // double-clicked files: openPath accepts them too

// Run a command in the page. userGesture=true, as a click would be (some
// Utilities items open file pickers or print).
function runPageCmd(cmd, arg) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const code = 'window.__mkMenuCmd && window.__mkMenuCmd(' + JSON.stringify(String(cmd)) + ',' +
               JSON.stringify(arg == null ? null : String(arg)) + '); void 0;';
  mainWindow.webContents.executeJavaScript(code, true)
    .catch(err => console.error('[main] menu command failed:', cmd, err && err.message));
}

const menuEsc = t => process.platform === 'win32' ? String(t).replace(/&/g, '&&') : String(t);   // & is a Windows mnemonic

function recentMenuItems() {
  const list = recentList().filter(x => { try { return fs.statSync(x.path).isFile(); } catch (_) { return false; } });
  if (!list.length) return [{ label: 'No recent files', enabled: false }];
  const nameOf = x => String(x.name || path.basename(x.path, path.extname(x.path)));
  const items = list.map((x, i) => {
    const n = nameOf(x);
    // Two files with the same name: add the folder each is in
    const dup = list.some((y, j) => j !== i && nameOf(y).toLowerCase() === n.toLowerCase());
    const label = dup ? `${n}  —  ${path.basename(path.dirname(x.path))}` : n;
    return { label: menuEsc(label), click: () => runPageCmd('open-path', x.path) };
  });
  return [...items, { type: 'separator' }, { label: 'Clear Recent', click: clearRecents }];
}
function clearRecents() {
  const s = readSettings();
  s.recents = [];
  writeSettings(s);
  try { app.clearRecentDocuments(); } catch (_) {}
  installAppMenu();
}

// The page's Utilities dropdown as menu items: hidden items left out,
// separators tidied, a key shown in a hint (F1, Ctrl+P) shown beside the item.
function utilityMenuItems(isMac) {
  const out = [];
  for (const it of utilMenuItems) {
    if (it.hidden) continue;
    if (it.sep) { if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' }); continue; }
    if (it.note) { out.push({ label: menuEsc(it.label), enabled: false }); continue; }
    if (isMac && it.id === 'miAbout') continue;                  // Mac: About is in the app menu
    const item = { label: menuEsc(it.label), enabled: !it.disabled, click: () => runPageCmd('util', it.id) };
    const key = /^(F\d{1,2}|Ctrl\+[A-Z0-9])$/i.test(it.key || '') ? it.key.replace(/^Ctrl\+/i, 'CmdOrCtrl+') : '';
    if (key && !isMac) { item.accelerator = key; item.registerAccelerator = false; }
    out.push(item);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out.length ? out : [{ label: 'Nothing here yet', enabled: false }];
}

function installAppMenu() {
  const isMac = process.platform === 'darwin';
  const acc = a => isMac ? { accelerator: a } : { accelerator: a, registerAccelerator: false };
  const sep = { type: 'separator' };
  const fileMenu = { label: isMac ? 'File' : '&File', submenu: [
    { label: 'New',           ...acc('CmdOrCtrl+N'),       click: () => runPageCmd('new') },
    { label: 'Open…',    ...acc('CmdOrCtrl+O'),       click: () => runPageCmd('open') },
    { label: 'Open Recent', submenu: recentMenuItems() },
    sep,
    { label: 'Save',          ...acc('CmdOrCtrl+S'),       click: () => runPageCmd('save') },
    { label: 'Save As…', ...acc('CmdOrCtrl+Shift+S'), click: () => runPageCmd('saveas') },
    sep,
    isMac
      ? { role: 'close' }    // Cmd+W: the window's close, which asks
      : { label: 'E&xit', accelerator: 'Alt+F4', registerAccelerator: false,
          click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); } }
  ] };
  const utilMenu = { label: isMac ? 'Utilities' : '&Utilities', submenu: utilityMenuItems(isMac) };

  if (isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.name, submenu: [
        { label: 'About ' + app.name, click: () => runPageCmd('about') },
        sep, { role: 'services' },
        sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        sep, { role: 'quit' }   // -> before-quit, which asks the page
      ] },
      fileMenu,
      { role: 'editMenu' },
      utilMenu,
      { label: 'Window', role: 'window', submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        sep,
        { role: 'togglefullscreen' },
        sep,
        { role: 'front' }
      ] }
    ]));
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setMenu(Menu.buildFromTemplate([fileMenu, utilMenu]));
  mainWindow.setMenuBarVisibility(true);
}

// Page -> main: the Utilities dropdown, whenever it changes
ipcMain.on('menubar:util', (event, items) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || !Array.isArray(items)) return;
  const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  utilMenuItems = items.slice(0, 60).map(it => ({
    id: str(it && it.id, 80), label: str(it && it.label, 100), key: str(it && it.key, 20),
    sep: !!(it && it.sep), note: !!(it && it.note), hidden: !!(it && it.hidden), disabled: !!(it && it.disabled)
  }));
  installAppMenu();
});

const OPEN_EXTS = ["mikallbook", "micallbook"];   // files this app opens

// ── Double-clicked files (file association in package.json) ──────────────
// Windows passes the file on the command line, to a first launch
// (process.argv) or to the running app (second-instance). The Mac uses
// 'open-file'. The page asks for a waiting file once it has started.
function findFileArg(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    const ext = path.extname(a).toLowerCase().replace(/^\./, '');
    if (!OPEN_EXTS.includes(ext)) continue;
    try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch (_) {}
  }
  return null;
}
function queueOpen(p) {
  if (!p) return;
  launchPaths.add(p);
  if (openReady && mainWindow && !mainWindow.isDestroyed()) runPageCmd('open-path', p);
  else pendingOpen = p;
}
pendingOpen = findFileArg(process.argv);
if (pendingOpen) launchPaths.add(pendingOpen);
app.on('open-file', (e, p) => { e.preventDefault(); queueOpen(p); });

// The page has started: from now on files open straight away. Returns the
// file double-clicked to start the app, if any (once).
ipcMain.handle('menubar:take-pending', (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
  openReady = true;
  const p = pendingOpen;
  pendingOpen = null;
  return p;
});

app.whenReady().then(() => {
  if (!gotLock) return;
  // Windows: no application menu (every window would get it); the main
  // window's own menu bar is set by installAppMenu() once it exists. Mac: the app menu.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  mainWindow = createMainWindow();
  installAppMenu();                                   // menu bar (2026-11-20)
  mainWindow.webContents.on('did-start-loading', () => { openReady = false; });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on('before-quit', (e) => {
  // Mac Cmd+Q / Dock > Quit (2026-11-20): ask the page first, as the X does.
  // Its Exit sends 'app:quit', which sets allowClose and quits.
  if (!allowClose && mainWindow && !mainWindow.isDestroyed()) {
    const wc = mainWindow.webContents;
    const dead = (typeof wc.isCrashed === 'function' && wc.isCrashed()) || wc.isLoading();
    if (!dead) { e.preventDefault(); wc.send('app:close-request'); return; }
  }
  try { mikastLink.shutdown(); } catch (_) {}
  allowClose = true;
  link.shutdown();
  releaseWindows();
});
app.on('window-all-closed', () => app.quit());
