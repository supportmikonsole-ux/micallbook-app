'use strict';

/**
 * MiKallbook: Booth View preload
 *   window.booth.onState(cb)   -> state sent by the main window
 *   window.booth.ready()       -> ask for the current state
 *   window.booth.key(k)        -> 'go' | 'back' | 'fullscreen'
 *   window.booth.setView(v)    -> 'all' or a department code
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booth', {
  onState: (cb) => { if (typeof cb === 'function') ipcRenderer.on('popout:state', (_e, s) => cb(s)); },
  ready:   ()   => ipcRenderer.send('popout:ready'),
  key:     (k)  => ipcRenderer.send('popout:key', String(k)),
  setView: (v)  => ipcRenderer.send('popout:view', String(v || 'all'))
});
