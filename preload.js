'use strict';

/**
 * MiKallbook: Electron preload
 * Narrow bridge from the page to the main process (contextIsolation on).
 *
 *   window.micallbook.openShow()                 -> { canceled } | { error } | { show, showPath, missing[] }
 *   window.micallbook.saveShow(show, showPath?)  -> { canceled } | { error } | { showPath, pathMap, missing[] }
 *   window.micallbook.pickScript()               -> { canceled } | { path, name }
 *   window.micallbook.readScript(path)           -> Uint8Array (PDF bytes)
 *   window.micallbook.popout.open() / close() / isOpen()
 *   window.micallbook.popout.send(state)         -> Booth View display
 *   window.micallbook.popout.onWantState(cb) / onKey(cb) / onClosed(cb) / onView(cb)
 *   window.micallbook.link.*                     -> live link (see link-main.js): hostStart/Stop/Info/NewCode,
 *                                                   hostState(state), join({address,code,dept}), leave(), saved(),
 *                                                   setDept(code), onClients/onStatus/onState(cb)
 *   window.micallbook.reports.savePdf(html, showPath, fileName, {landscape}?) -> { path } | { error }  (<Show>/reports/)
 *   window.micallbook.reports.saveText(text, showPath, fileName) -> { path } | { error }  (.csv / .txt, <Show>/reports/)
 *   window.micallbook.reports.print(html, {landscape}?) -> { ok, reason }  (printer dialog)
 *   window.micallbook.reports.open(path) / reveal(path)
 *   window.micallbook.notes.context(ctx)         -> what the phones' notes page shows (link-main.js)
 *   window.micallbook.notes.onIncoming(cb)       -> a note from a phone: { name, role, field, cue, text, from }
 *   window.micallbook.setTitle(text)
 *   window.micallbook.copyText(text)             -> clipboard
 *   window.micallbook.openManual()               -> the User Manual in its own window
 *   window.micallbook.quit()                     -> quit without asking
 *   window.micallbook.onCloseRequest(cb)         -> window close button / Alt+F4
 *   window.micallbook.mikast.pick(showPath)      -> { canceled } | { path, rel }  (a .mikast production)
 *   window.micallbook.mikast.watch(showPath, {path, rel}) / unwatch()
 *   window.micallbook.mikast.onData(cb)          -> the production's calls and sign-ins, when they change (mikast-link-main.js)
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('micallbook', {
  openShow:   ()               => ipcRenderer.invoke('show:open'),
  saveShow:   (show, showPath) => ipcRenderer.invoke('show:save', show, showPath || null),
  pickScript: ()               => ipcRenderer.invoke('script:pick'),
  readScript: (p)              => ipcRenderer.invoke('script:read', p),
  popout: {
    open:   ()      => ipcRenderer.invoke('popout:open'),
    close:  ()      => ipcRenderer.invoke('popout:close'),
    isOpen: ()      => ipcRenderer.invoke('popout:isOpen'),
    send:   (state) => ipcRenderer.send('popout:state', state),
    onWantState: (cb) => { if (typeof cb === 'function') ipcRenderer.on('popout:want-state', () => cb()); },
    onKey:       (cb) => { if (typeof cb === 'function') ipcRenderer.on('popout:key', (_e, k) => cb(k)); },
    onClosed:    (cb) => { if (typeof cb === 'function') ipcRenderer.on('popout:closed', () => cb()); },
    onView:      (cb) => { if (typeof cb === 'function') ipcRenderer.on('popout:view', (_e, v) => cb(v)); }
  },
  link: {
    hostStart:   ()      => ipcRenderer.invoke('link:host-start'),
    hostStop:    ()      => ipcRenderer.invoke('link:host-stop'),
    hostInfo:    ()      => ipcRenderer.invoke('link:host-info'),
    hostNewCode: ()      => ipcRenderer.invoke('link:host-newcode'),
    hostState:   (state) => ipcRenderer.send('link:host-state', state),
    join:        (opts)  => ipcRenderer.invoke('link:join', opts),
    leave:       ()      => ipcRenderer.invoke('link:leave'),
    saved:       ()      => ipcRenderer.invoke('link:saved'),
    setDept:     (code)  => ipcRenderer.send('link:dept', String(code || '')),
    onClients: (cb) => { if (typeof cb === 'function') ipcRenderer.on('link:clients', (_e, list) => cb(list)); },
    onStatus:  (cb) => { if (typeof cb === 'function') ipcRenderer.on('link:status', (_e, st) => cb(st)); },
    onState:   (cb) => { if (typeof cb === 'function') ipcRenderer.on('link:state', (_e, st) => cb(st)); }
  },
  reports: {
    savePdf: (html, showPath, fileName, opts) => ipcRenderer.invoke('report:pdf', String(html || ''), showPath || null, String(fileName || ''), { landscape: !!(opts && opts.landscape) }),
    saveText: (text, showPath, fileName) => ipcRenderer.invoke('report:text', String(text || ''), showPath || null, String(fileName || '')),
    print:   (html, opts) => ipcRenderer.invoke('report:print', String(html || ''), { landscape: !!(opts && opts.landscape) }),
    open:    (p)    => ipcRenderer.invoke('report:open', String(p || '')),
    reveal:  (p)    => ipcRenderer.invoke('report:reveal', String(p || ''))
  },
  mikast: {
    pick:    (showPath)      => ipcRenderer.invoke('mikast:pick', showPath || null),
    watch:   (showPath, ref) => ipcRenderer.invoke('mikast:watch', showPath || null, ref || null),
    unwatch: ()              => ipcRenderer.invoke('mikast:unwatch'),
    onData:  (cb) => { if (typeof cb === 'function') ipcRenderer.on('mikast:data', (_e, d) => cb(d)); }
  },
  notes: {
    context:    (ctx) => ipcRenderer.send('notes:context', ctx),
    onIncoming: (cb)  => { if (typeof cb === 'function') ipcRenderer.on('notes:incoming', (_e, n) => cb(n)); }
  },
  setTitle:   (t)              => ipcRenderer.send('app:title', String(t || 'MiKallbook')),
  copyText:   (t)              => ipcRenderer.send('app:copy', String(t || '')),
  openManual: ()               => ipcRenderer.send('app:manual'),
  quit:       ()               => ipcRenderer.send('app:quit'),
  onCloseRequest: (cb) => {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('app:close-request', () => cb());
  },
  platform: process.platform
});
