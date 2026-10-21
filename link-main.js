'use strict';

/**
 * MiKallbook: live link between computers (main process)
 *
 * The stage manager's MiKallbook SHARES: a small web server on the local
 * network (port 8095, or the next free one up to 8099). Operators' copies
 * JOIN with the SM's address and a 4-digit code, and follow the SM's
 * calling position.
 *
 *   GET /micallbook/ping                      -> { app:'micallbook', v:1, name }
 *   GET /micallbook/link?code=&cid=&name=&dept=  -> event stream (text/event-stream)
 *         "event: state"  the SM's calling state (JSON), sent on connect and on every change
 *         ":hb"           heartbeat every second, so a dead link is noticed in 3.5 s
 *   GET /micallbook/who?code=&cid=&dept=      -> an operator changed department
 *
 * Rehearsal notes from phones and laptops (any browser, same network):
 *   GET  /notes                               -> the notes page (notes-page.html)
 *   GET  /micallbook/notes/info?code=         -> { show, target, fields:[{id,label}], cue } (from the page, notes:context)
 *   POST /micallbook/notes?code=   {name, role, field, cue, text} -> passed to the page (notes:incoming)
 *
 * Wrong code -> 403. Operators can never send commands to the SM; a note only
 * adds text to the current report.
 * Everything here is plain Node http; nothing leaves the local network.
 */

const http = require('http');
const os   = require('os');
const fs   = require('fs');
const path = require('path');

const PORT_FIRST = 8095;
const PORT_LAST  = 8099;
const MAX_CLIENTS = 32;
const HEARTBEAT_MS = 1000;
const DEAD_MS = 3500;          // no data this long = link lost
const RETRY_MS = 1500;
const NOTE_MAX_BYTES = 8192;
const NOTE_GAP_MS = 400;       // one note per device this often, at most

module.exports = function setupLink({ ipcMain, getMainWindow, readSettings, writeSettings }) {
  const toPage = (ch, data) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, data);
  };

  function linkSettings() { return readSettings().link || {}; }
  function saveLinkSettings(patch) {
    const s = readSettings();
    s.link = Object.assign({}, s.link || {}, patch);
    writeSettings(s);
  }
  function newCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

  function lanAddresses() {
    const out = [];
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const a of nets[name] || []) {
        const v4 = a.family === 'IPv4' || a.family === 4;
        if (!v4 || a.internal || /^169\.254\./.test(a.address)) continue;
        out.push({ address: a.address, iface: name });
      }
    }
    return out;
  }

  // ── Host (SM) ─────────────────────────────────────────────────────────
  let server = null;
  let port = 0;
  let code = null;
  let latest = null;                 // latest state, as the JSON text sent
  const clients = new Map();         // cid -> { res, name, dept, addr }
  let hbTimer = 0;
  let notesCtx = null;               // what the notes page shows (from the page)
  const lastNoteAt = new Map();      // remote address -> time of its last note
  let notesPageHtml = null;
  function notesPage() {
    if (notesPageHtml === null) {
      try { notesPageHtml = fs.readFileSync(path.join(__dirname, 'notes-page.html'), 'utf8'); }
      catch (err) { console.error('[notes] page missing:', err); notesPageHtml = ''; }
    }
    return notesPageHtml;
  }

  // POST /micallbook/notes: one note, passed to the page
  function takeNote(req, res, json) {
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const now = Date.now();
    if (now - (lastNoteAt.get(addr) || 0) < NOTE_GAP_MS) { json(429, { ok: false, error: 'Too fast: wait a moment and send again.' }); req.resume(); return; }
    let size = 0, body = '', over = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > NOTE_MAX_BYTES) { over = true; return; }
      body += chunk;
    });
    req.on('end', () => {
      if (over) { json(413, { ok: false, error: 'That note is too long.' }); return; }
      let n;
      try { n = JSON.parse(body); } catch (_) { json(400, { ok: false, error: 'Bad note.' }); return; }
      const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
      const note = {
        name: clean(n && n.name, 40), role: clean(n && n.role, 40), field: clean(n && n.field, 40),
        cue: clean(n && n.cue, 40), text: clean(n && n.text, 2000), from: addr
      };
      if (!note.text || !note.name) { json(400, { ok: false, error: 'A note needs your name and some text.' }); return; }
      const w = getMainWindow();
      if (!w || w.isDestroyed()) { json(503, { ok: false, error: 'MiKallbook isn’t ready.' }); return; }
      lastNoteAt.set(addr, now);
      toPage('notes:incoming', note);
      json(200, { ok: true, to: notesCtx && notesCtx.target ? notesCtx.target : '' });
    });
  }

  function clientList() {
    return [...clients.values()].map(c => ({ name: c.name, dept: c.dept, addr: c.addr }));
  }
  function notifyClients() { toPage('link:clients', clientList()); }

  function hostInfo() {
    return { hosting: !!server, port, code, addresses: lanAddresses(), clients: clientList(), name: os.hostname() };
  }

  function dropAllClients() {
    for (const c of clients.values()) { try { c.res.end(); } catch (_) {} }
    clients.clear();
  }

  function handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); res.end(); return; }
    const q = url.searchParams;
    const json = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    // The notes page and its two calls (see the top of this file)
    if (url.pathname === '/notes' || url.pathname === '/notes/') {
      if (req.method !== 'GET') { json(405, { error: 'method' }); return; }
      const html = notesPage();
      res.writeHead(html ? 200 : 404, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      });
      res.end(html || 'Notes page missing');
      return;
    }
    if (url.pathname === '/micallbook/notes/info') {
      if (q.get('code') !== code) { json(403, { error: 'code' }); return; }
      json(200, notesCtx || { show: '', target: '', fields: [], cue: '' });
      return;
    }
    if (url.pathname === '/micallbook/notes') {
      if (q.get('code') !== code) { json(403, { ok: false, error: 'code' }); req.resume(); return; }
      if (req.method !== 'POST') { json(405, { ok: false, error: 'method' }); return; }
      takeNote(req, res, json);
      return;
    }

    if (req.method !== 'GET') { json(405, { error: 'method' }); return; }

    if (url.pathname === '/micallbook/ping') { json(200, { app: 'micallbook', v: 1, name: os.hostname() }); return; }

    if (url.pathname === '/micallbook/who') {
      if (q.get('code') !== code) { json(403, { error: 'code' }); return; }
      const c = clients.get(String(q.get('cid') || ''));
      if (c) { c.dept = String(q.get('dept') || '').slice(0, 12); notifyClients(); }
      json(200, { ok: true });
      return;
    }

    if (url.pathname === '/micallbook/link') {
      if (q.get('code') !== code) { json(403, { error: 'code' }); return; }
      const cid = String(q.get('cid') || '').slice(0, 40) || Math.random().toString(36).slice(2);
      if (!clients.has(cid) && clients.size >= MAX_CLIENTS) { json(503, { error: 'full' }); return; }
      const old = clients.get(cid);                       // same operator reconnecting
      if (old) { try { old.res.end(); } catch (_) {} }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.socket && res.socket.setNoDelay && res.socket.setNoDelay(true);
      const entry = {
        res,
        name: String(q.get('name') || 'Operator').slice(0, 40),
        dept: String(q.get('dept') || '').slice(0, 12),
        addr: String(req.socket.remoteAddress || '').replace(/^::ffff:/, '')
      };
      clients.set(cid, entry);
      res.write(':hello\n\n');
      if (latest) res.write('event: state\ndata: ' + latest + '\n\n');
      const gone = () => {
        if (clients.get(cid) === entry) { clients.delete(cid); notifyClients(); }
      };
      req.on('close', gone);
      res.on('error', gone);
      notifyClients();
      return;
    }
    json(404, { error: 'not found' });
  }

  function listenOn(p) {
    return new Promise((resolve) => {
      const s = http.createServer(handle);
      s.keepAliveTimeout = 0;
      s.once('error', (err) => resolve({ err }));
      s.listen(p, '0.0.0.0', () => resolve({ server: s }));
    });
  }

  async function startHost() {
    if (server) return { ok: true, ...hostInfo() };
    stopClient(false);
    let lastErr = null;
    for (let p = PORT_FIRST; p <= PORT_LAST; p++) {
      const r = await listenOn(p);
      if (r.server) { server = r.server; port = p; break; }
      lastErr = r.err;
      if (!r.err || r.err.code !== 'EADDRINUSE') break;
    }
    if (!server) {
      return { ok: false, error: lastErr && lastErr.code === 'EADDRINUSE'
        ? `Ports ${PORT_FIRST}–${PORT_LAST} are all in use on this computer.`
        : 'Could not start sharing: ' + (lastErr ? lastErr.message : 'unknown error') };
    }
    code = linkSettings().code;
    if (!/^\d{4}$/.test(code || '')) { code = newCode(); saveLinkSettings({ code }); }
    server.on('error', (err) => console.error('[link] server error:', err));
    clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      for (const c of clients.values()) { try { c.res.write(':hb\n\n'); } catch (_) {} }
    }, HEARTBEAT_MS);
    return { ok: true, ...hostInfo() };
  }

  function stopHost() {
    clearInterval(hbTimer);
    dropAllClients();
    if (server) { try { server.close(); } catch (_) {} }
    server = null; port = 0;
    return { ok: true };
  }

  ipcMain.handle('link:host-start', () => startHost());
  ipcMain.handle('link:host-stop', () => stopHost());
  ipcMain.handle('link:host-info', () => hostInfo());
  ipcMain.handle('link:host-newcode', () => {
    code = newCode();
    saveLinkSettings({ code });
    dropAllClients();                 // everyone must join again with the new code
    notifyClients();
    return hostInfo();
  });
  // What the notes page shows: show name, which report notes go to, its fields, the last cue called
  ipcMain.on('notes:context', (_e, ctx) => {
    if (!ctx || typeof ctx !== 'object') return;
    notesCtx = {
      show: String(ctx.show || '').slice(0, 120),
      target: String(ctx.target || '').slice(0, 80),
      cue: String(ctx.cue || '').slice(0, 60),
      fields: (Array.isArray(ctx.fields) ? ctx.fields : []).slice(0, 80)
        .map(f => ({ id: String(f && f.id || '').slice(0, 40), label: String(f && f.label || '').slice(0, 80) }))
    };
  });

  ipcMain.on('link:host-state', (_e, state) => {
    if (!server) return;
    let text;
    try { text = JSON.stringify(state); } catch (_) { return; }
    if (text === latest) return;
    latest = text;
    const msg = 'event: state\ndata: ' + text + '\n\n';
    for (const c of clients.values()) { try { c.res.write(msg); } catch (_) {} }
  });

  // ── Client (operator) ─────────────────────────────────────────────────
  // status: 'connecting' | 'linked' | 'lost' | 'refused' | 'error' | 'off'
  let target = null;                 // { host, port, code, dept }
  let req = null;
  let deadTimer = 0, retryTimer = 0;
  let everLinked = false;
  const cid = Math.random().toString(36).slice(2) + Date.now().toString(36);

  function status(s, extra) { toPage('link:status', Object.assign({ status: s }, extra || {})); }

  function parseAddress(text) {
    const t = String(text || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(t);
    if (!m) return null;
    const p = m[2] ? Number(m[2]) : PORT_FIRST;
    if (!(p > 0 && p < 65536)) return null;
    return { host: m[1], port: p };
  }

  function clearTimers() { clearTimeout(deadTimer); clearTimeout(retryTimer); }

  function stopClient(tell) {
    clearTimers();
    const r = req; req = null;
    target = null;
    if (r) { try { r.destroy(); } catch (_) {} }
    if (tell) status('off');
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (!target) return;
    retryTimer = setTimeout(connect, RETRY_MS);
  }

  function connect() {
    if (!target) return;
    clearTimers();
    const t = target;
    status(everLinked ? 'lost' : 'connecting', { host: t.host, port: t.port });
    const qs = new URLSearchParams({ code: t.code, cid, name: os.hostname(), dept: t.dept || '' });
    const r = http.get({ host: t.host, port: t.port, path: '/micallbook/link?' + qs.toString(), timeout: 4000 });
    req = r;
    let failed = false;
    const fail = (msg) => {
      if (failed || req !== r) return;
      failed = true;
      try { r.destroy(); } catch (_) {}
      req = null;
      if (!target) return;
      if (!everLinked) {
        // First attempt: tell the operator and stop, so they can check the address
        status('error', { message: msg, host: t.host, port: t.port });
        target = null;
        return;
      }
      status('lost', { host: t.host, port: t.port });
      scheduleRetry();
    };
    const armDead = () => {
      clearTimeout(deadTimer);
      deadTimer = setTimeout(() => fail('No answer from the SM'), DEAD_MS);
    };
    r.on('timeout', () => fail('No answer from ' + t.host));
    r.on('error', (err) => {
      const m = err && err.code === 'ECONNREFUSED' ? `MiKallbook isn't sharing at ${t.host}:${t.port}`
        : err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') ? `Can't find ${t.host} on the network`
        : err && (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') ? `Can't reach ${t.host}: check this computer is on the same network`
        : err && err.code === 'ETIMEDOUT' ? `No answer from ${t.host}`
        : 'Link error: ' + (err ? err.message : 'unknown');
      fail(m);
    });
    r.on('response', (res) => {
      if (req !== r) { res.resume(); return; }
      if (res.statusCode === 403) {
        res.resume();
        failed = true;
        req = null; target = null; clearTimers();
        status('refused', { message: 'Wrong code. Check the 4-digit code on the SM\'s Link window.', host: t.host, port: t.port });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        fail(res.statusCode === 503 ? 'The SM has too many computers linked' : `The SM's computer answered ${res.statusCode}`);
        return;
      }
      r.setTimeout(0);
      everLinked = true;
      saveLinkSettings({ joinAddress: t.port === PORT_FIRST ? t.host : `${t.host}:${t.port}`, joinCode: t.code });
      status('linked', { host: t.host, port: t.port });
      armDead();
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk) => {
        if (req !== r) return;
        armDead();
        buf += chunk;
        if (buf.length > 4 * 1024 * 1024) { buf = ''; return; }   // runaway: drop
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let ev = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) ev = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          }
          if (ev === 'state' && data.length) {
            try { toPage('link:state', JSON.parse(data.join('\n'))); } catch (_) {}
          }
        }
      });
      res.on('end', () => fail('The SM stopped sharing'));
      res.on('error', () => fail('The link dropped'));
      res.on('close', () => fail('The link dropped'));
    });
  }

  ipcMain.handle('link:join', (_e, opts) => {
    const o = opts || {};
    const a = parseAddress(o.address);
    if (!a) return { ok: false, error: 'Type the SM computer\'s address, like 192.168.1.20' };
    if (!/^\d{4}$/.test(String(o.code || ''))) return { ok: false, error: 'The code is 4 digits.' };
    stopHost();
    stopClient(false);
    everLinked = false;
    target = { host: a.host, port: a.port, code: String(o.code), dept: String(o.dept || '') };
    connect();
    return { ok: true };
  });
  ipcMain.handle('link:leave', () => { everLinked = false; stopClient(true); return { ok: true }; });
  ipcMain.handle('link:saved', () => { const s = linkSettings(); return { joinAddress: s.joinAddress || '', joinCode: s.joinCode || '' }; });
  ipcMain.on('link:dept', (_e, dept) => {
    if (!target) return;
    target.dept = String(dept || '');
    if (!everLinked) return;
    const qs = new URLSearchParams({ code: target.code, cid, dept: target.dept });
    const r = http.get({ host: target.host, port: target.port, path: '/micallbook/who?' + qs.toString(), timeout: 3000 });
    r.on('response', (res) => res.resume());
    r.on('timeout', () => r.destroy());
    r.on('error', () => {});
  });

  return { shutdown() { stopHost(); stopClient(false); } };
};
