'use strict';

/* ════════════════════════════════════════════════════════════════════
   MiKallbook: live link (page side)
   The SM's computer SHARES its calling position on the local network;
   operators' computers JOIN with the SM's address and 4-digit code and
   follow it: Standby, GO (with the green flash) and Back all come from
   the SM. The network side is link-main.js in the main process.

   What is sent: the show's ID and name, the calling position, a GO count,
   and for every GO point its ID and a short checksum of its cues and
   marks, so an operator's copy that differs from the SM's is noticed.
   The script itself never leaves the SM's computer.

   While linked, Space / Backspace on an operator's computer do nothing
   (the SM calls). If the link is lost they work locally until it comes
   back, then the SM's position takes over again.

   Uses app.js / marks.js / calling.js globals.
   ════════════════════════════════════════════════════════════════════ */

const LINK_DEFAULT_PORT = 8095;

let linkRole = null;          // null | 'host' (SM) | 'client' (operator)
let hostInfo = null;          // { port, code, addresses[], clients[], name }
let linkStatus = 'off';       // client: 'connecting' | 'linked' | 'lost' | 'off'
let linkTarget = '';          // address being followed, for messages
let linkError = '';
let smState = null;           // latest state from the SM
let smLastFlash = null;
let linkDiff = null;          // how this copy differs from the SM's
let lastLocalSig = '';
let linkDlgOpen = false;
let hostSendQueued = false;
let recheckTimer = 0;
let nudgeAt = 0;

// GO / Back / click-to-standby are the SM's while linked (not while the link is lost)
function linkLocked() { return linkRole === 'client' && (linkStatus === 'linked' || linkStatus === 'connecting'); }
function linkDialogIsOpen() { return linkDlgOpen; }

function linkNudge() {
  const now = performance.now();
  if (now - nudgeAt < 3000) return;
  nudgeAt = now;
  toast('Following the SM: GO and Back come from the SM’s computer.');
}

// ── Checksums ─────────────────────────────────────────────────────────
function linkHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function anchorSig(a) {
  if (!a) return '';
  if (typeof a.offset === 'number') return 'o' + a.offset;
  return `${a.page}:${Math.round((a.x || 0) * 1000)}:${Math.round((a.y || 0) * 1000)}`;
}
// Cues (by department code, so it matches across computers), marks, VISUAL and note
function goSig(gp) {
  return linkHash([gp.cues.map(cueText).join('+'), anchorSig(gp.at), anchorSig(gp.standby), anchorSig(gp.warn),
    gp.visual ? 1 : 0, gp.note || ''].join('|'));
}
function localSig() {
  return linkHash((show.id || '') + '#' + callList().map(g => g.id + ':' + goSig(g)).join(','));
}

// ── SM side ───────────────────────────────────────────────────────────
function hostPayload() {
  const list = callList();
  const si = atEnd ? list.length : standbyIndex();
  return {
    v: 1,
    showId: show.id || '',
    show: show.name || 'Untitled Show',
    by: hostInfo ? hostInfo.name : '',
    mode,
    end: atEnd,
    si,
    k: stepK,                                   // Warn / Standby steps called before the standby GO
    step: (() => { const s = !atEnd && list.length ? curStep() : null; return s && s.gp ? [s.kind, s.gp.id] : null; })(),
    flash: goFlash,
    order: list.map(g => [g.id, goSig(g)])
  };
}

// Called at the end of every renderStandby (calling.js)
function linkAfterRender() {
  if (linkRole === 'host') {
    if (hostSendQueued) return;
    hostSendQueued = true;
    queueMicrotask(() => {                     // several renders in one go: send once, no delay
      hostSendQueued = false;
      if (linkRole === 'host') bridge.link.hostState(hostPayload());
    });
  } else if (linkRole === 'client' && smState) {
    // This copy was edited, or another show opened: check it against the SM again
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => {
      if (linkRole === 'client' && smState && localSig() !== lastLocalSig) applySm(smState, true);
    }, 250);
  }
}

async function startSharing() {
  linkError = '';
  const r = await bridge.link.hostStart();
  if (!r || !r.ok) { linkError = (r && r.error) || 'Could not start sharing.'; renderLinkUi(); return; }
  hostInfo = r;
  linkRole = 'host';
  smState = null; linkDiff = null;
  bridge.link.hostState(hostPayload());
  renderLinkUi();
}

async function stopSharing() {
  await bridge.link.hostStop();
  linkRole = null; hostInfo = null;
  renderLinkUi();
}

async function newLinkCode() {
  const ok = await askInLink('Make a new code?', 'Every linked operator is dropped and has to join again with the new code.');
  if (!ok) return;
  hostInfo = await bridge.link.hostNewCode();
  renderLinkUi();
}

// ── Operator side ─────────────────────────────────────────────────────
async function joinSm() {
  const addr = document.getElementById('linkAddr').value.trim();
  const code = document.getElementById('linkCode').value.trim();
  const d = deptById(opDept);
  linkError = '';
  const r = await bridge.link.join({ address: addr, code, dept: d ? d.code : '' });
  if (!r || !r.ok) { linkError = (r && r.error) || 'Could not join.'; renderLinkUi(); return; }
  linkRole = 'client';
  linkStatus = 'connecting';
  linkTarget = addr;
  smState = null; smLastFlash = null; linkDiff = null;
  renderLinkUi();
}

async function leaveSm() {
  await bridge.link.leave();
  linkRole = null; linkStatus = 'off'; smState = null; linkDiff = null; smLastFlash = null;
  renderStandby(); decorateCalling(); renderCalling();
  renderLinkUi();
}

function onLinkStatus(st) {
  const s = st && st.status;
  if (st && st.host) linkTarget = st.port && st.port !== LINK_DEFAULT_PORT ? `${st.host}:${st.port}` : st.host;
  if (s === 'connecting' || s === 'linked' || s === 'lost') {
    const was = linkStatus;
    linkRole = 'client';
    linkStatus = s;
    if (s === 'linked') linkError = '';
    if (s === 'linked' && was === 'lost') toast('Link back: following the SM again', 'ok');
    if (s === 'lost' && was === 'linked') toast('LINK LOST: Space / Backspace work on this computer until it is back', 'err');
  } else if (s === 'refused' || s === 'error') {
    linkRole = null; linkStatus = 'off'; smState = null; linkDiff = null;
    linkError = (st && st.message) || 'Could not link.';
    if (!linkDlgOpen) openLinkDialog();
  } else if (s === 'off') {
    linkRole = null; linkStatus = 'off'; smState = null; linkDiff = null;
  }
  renderStandby(); decorateCalling(); renderCalling();
  renderLinkUi();
}

// The SM's state arrived (or this copy changed: recheck = true)
function applySm(st, recheck) {
  if (!st || !Array.isArray(st.order)) return;
  smState = st;
  const list = callList();
  const localIdx = new Map(list.map((g, k) => [g.id, k]));
  const smIds = st.order.map(o => o[0]);
  const smSet = new Set(smIds);
  const common = smIds.filter(id => localIdx.has(id));
  const differentShow = st.showId !== show.id && common.length === 0;

  const changed = [], missing = [];
  st.order.forEach(([id, sig], k) => {
    if (!localIdx.has(id)) missing.push(k + 1);
    else if (goSig(list[localIdx.get(id)]) !== sig) changed.push(k + 1);
  });
  const extra = list.filter(g => !smSet.has(g.id)).length;
  const order = list.map(g => g.id).filter(id => smSet.has(id)).join() !== common.join();
  linkDiff = { differentShow, smShow: st.show, changed, missing, extra, order };
  lastLocalSig = localSig();

  // GO count from the SM: a rise is a GO (a fall means the SM restarted)
  const fired = !recheck && smLastFlash !== null && st.flash > smLastFlash;
  if (!recheck) smLastFlash = st.flash;

  if (!differentShow) {
    let target = null;
    let end = !!st.end;
    if (!end) {
      // The SM's standby, or the next GO point after it that this copy has
      for (let k = Math.max(0, st.si); k < st.order.length; k++) {
        if (localIdx.has(st.order[k][0])) { target = st.order[k][0]; break; }
      }
      if (!target && st.order.length) end = true;
    }
    standbyGoId = end ? null : target;
    atEnd = end && list.length > 0;
    // The SM's Warn / Standby step: the same step here if this copy has it, else at the GO
    stepK = 0;
    if (!end && target) {
      const { list: cl, pre } = callSteps();
      const ti = cl.findIndex(g => g.id === target);
      const ps = pre[ti] || [];
      const smAt = st.order[Math.max(0, st.si)] && st.order[Math.max(0, st.si)][0] === target;
      if (!smAt) stepK = 0;                              // the SM's GO isn't in this copy: from the start of the next one
      else if (Array.isArray(st.step) && st.step[0] !== 'go') {
        const m = ps.findIndex(x => x.kind === st.step[0] && x.gp.id === st.step[1]);
        stepK = m >= 0 ? m : Math.min(Number(st.k) || 0, ps.length);
      } else stepK = ps.length;                          // at the GO (also an SM from before Warn / Standby steps)
    }
    if (fired) {
      goFlash++;
      const btn = document.getElementById('btnGo');
      btn.classList.add('flash');
      setTimeout(() => btn.classList.remove('flash'), 180);
    }
    renderStandby();
    decorateCalling();
    renderCalling();
    if (!recheck) followStandby(true);
  }
  renderLinkUi();
}

// ── Display: header button, banner, Operator line, dialog ─────────────
function diffText(d) {
  if (!d) return '';
  const nums = (arr) => arr.length > 8 ? arr.slice(0, 8).join(', ') + ` and ${arr.length - 8} more` : arr.join(', ');
  const parts = [];
  if (d.changed.length) parts.push(`GO ${nums(d.changed)} changed`);
  if (d.missing.length) parts.push(`GO ${nums(d.missing)} missing here`);
  if (d.extra) parts.push(`${d.extra} GO point${d.extra === 1 ? '' : 's'} the SM doesn't have`);
  if (d.order) parts.push('calling order differs');
  return parts.join(' · ');
}

function renderLinkUi() {
  // Header button
  const b = document.getElementById('btnLink');
  b.classList.remove('on', 'lost', 'off');
  if (linkRole === 'host') {
    const n = hostInfo ? hostInfo.clients.length : 0;
    b.textContent = `Sharing · ${n}`;
    b.title = `Sharing this show: ${n} computer${n === 1 ? '' : 's'} following`;
    b.classList.add('on');
  } else if (linkRole === 'client') {
    b.textContent = linkStatus === 'lost' ? 'LINK LOST' : linkStatus === 'linked' ? 'Linked' : 'Linking…';
    b.title = `Following the SM at ${linkTarget}`;
    b.classList.add(linkStatus === 'lost' ? 'lost' : 'on');
  } else {
    // Not linked: no pill in the header (Utilities › Link Computers opens the window)
    b.textContent = 'Link';
    b.title = 'Link computers: share this show with operators, or follow the SM';
    b.classList.add('off');
  }

  // Banner
  const ban = document.getElementById('linkBanner');
  let msg = '', kind = '';
  if (linkRole === 'client' && linkStatus === 'lost') {
    msg = `LINK LOST · reconnecting to the SM at ${linkTarget}… Space / Backspace work on this computer until it is back.`;
    kind = 'lost';
  } else if (linkRole === 'client' && linkDiff && linkDiff.differentShow) {
    msg = `The SM is calling a different show: “${linkDiff.smShow}”. Open the same show file here to follow it.`;
    kind = 'lost';
  } else if (linkRole === 'client' && linkDiff) {
    const t = diffText(linkDiff);
    if (t) { msg = `Your copy of the show differs from the SM’s: ${t}. Get the latest show file from the SM.`; kind = 'warn'; }
  }
  ban.textContent = msg;
  ban.className = 'link-banner' + (msg ? ' ' + kind : ' hidden');

  // Operator mode: who it follows
  const op = document.getElementById('opLink');
  const hint = document.getElementById('opHint');
  op.classList.remove('lost', 'linked');
  if (linkRole === 'client') {
    const who = smState && smState.by ? smState.by : linkTarget;
    op.textContent = linkStatus === 'lost' ? `LINK LOST · ${linkTarget}`
      : linkStatus === 'linked' ? `Following the SM · ${who}${smState && smState.mode === 'edit' ? ' (SM in Edit mode)' : ''}`
      : `Linking to ${linkTarget}…`;
    op.classList.add(linkStatus === 'lost' ? 'lost' : 'linked');
  } else if (linkRole === 'host') {
    const n = hostInfo ? hostInfo.clients.length : 0;
    op.textContent = `Sharing · ${n} computer${n === 1 ? '' : 's'} following`;
  } else {
    op.textContent = 'Following this computer';
  }
  if (hint) hint.innerHTML = linkLocked() ? 'GO comes from the SM' : 'SPACE&nbsp;=&nbsp;GO &nbsp;·&nbsp; BACKSPACE&nbsp;=&nbsp;BACK';
  const callHint = document.getElementById('callHint');
  if (callHint) callHint.innerHTML = linkLocked() ? 'Following the SM: GO comes from the SM' : 'SPACE&nbsp;=&nbsp;GO &nbsp;·&nbsp; BACKSPACE&nbsp;=&nbsp;BACK';

  if (linkDlgOpen) renderLinkDialog();
}

// ── Link dialog ───────────────────────────────────────────────────────
let linkSaved = { joinAddress: '', joinCode: '' };
let linkAskResolve = null;

async function openLinkDialog() {
  try { linkSaved = await bridge.link.saved(); } catch (_) {}
  if (linkRole === 'host') { try { hostInfo = await bridge.link.hostInfo(); } catch (_) {} }
  linkDlgOpen = true;
  document.getElementById('linkOverlay').classList.add('open');
  renderLinkDialog(true);
}
function closeLinkDialog() {
  linkDlgOpen = false;
  linkAskResolve = null;
  document.getElementById('linkOverlay').classList.remove('open');
}

// A yes/no question inside the link dialog (the main modal can't sit on top of it)
function askInLink(msg, detail) {
  return new Promise(resolve => {
    linkAskResolve = resolve;
    const box = document.getElementById('linkBody');
    box.innerHTML = `<div class="modal-msg">${esc(msg)}</div><div class="modal-detail">${esc(detail)}</div>
      <div class="modal-btns"><button class="mi-btn" data-a="no">Cancel</button><button class="mi-btn mi-btn-go" data-a="yes" style="padding:9px 18px">OK</button></div>`;
  });
}

function renderLinkDialog(focus) {
  if (linkAskResolve) return;
  const box = document.getElementById('linkBody');
  const keepAddr = document.getElementById('linkAddr');
  const keepCode = document.getElementById('linkCode');
  const addrVal = keepAddr ? keepAddr.value : linkSaved.joinAddress;
  const codeVal = keepCode ? keepCode.value : linkSaved.joinCode;
  const err = linkError ? `<div class="lk-error">${esc(linkError)}</div>` : '';
  let html = '';

  if (linkRole === 'host') {
    const h = hostInfo || { addresses: [], clients: [], port: LINK_DEFAULT_PORT, code: '----' };
    const portTxt = h.port !== LINK_DEFAULT_PORT ? ':' + h.port : '';
    const addrs = h.addresses.length
      ? h.addresses.map(a => `<div class="lk-addr">${esc(a.address + portTxt)}<span class="lk-iface">${esc(a.iface)}</span></div>`).join('')
      : '<div class="lk-error">This computer has no network address. Connect it to the booth network (Wi-Fi or cable).</div>';
    const clients = h.clients.length
      ? h.clients.map(c => `<div class="lk-client"><span>${esc(c.name)}</span><span class="lk-dept">${esc(c.dept || '')}</span><span class="lk-iface">${esc(c.addr)}</span></div>`).join('')
      : '<div class="lk-none">No operators linked yet</div>';
    html = `
      <div class="modal-msg">Sharing “${esc(show.name || 'Untitled Show')}”</div>
      <div class="lk-cols">
        <div><div class="mi-label">Address</div>${addrs}</div>
        <div><div class="mi-label">Code</div><div class="lk-code">${esc(h.code)}</div></div>
      </div>
      <div class="lk-hint">On each operator's computer: open the same show, click <b>Link</b>, type this address and code, then <b>Join</b>.</div>
      ${h.addresses.length ? `<div class="lk-hint">Rehearsal notes from phones: <b>http://${esc(h.addresses[0].address)}:${h.port}/notes</b> with the same code (QR code in the Reports window).</div>` : ''}
      ${dirty ? '<div class="lk-warn">This show has unsaved changes. Save it and give operators the saved copy, or their GO points won’t match.</div>' : ''}
      <div class="mi-label lk-gap">Following (${h.clients.length})</div>
      <div class="lk-clients mi-scroll">${clients}</div>
      <div class="lk-note"><b>If operators can't connect:</b> the computers must be on the same network, and Windows must allow MiKallbook on <b>Private</b> networks.
        When Windows asks the first time, tick <b>Private networks</b> and Allow. If it didn't ask: Windows Security › Firewall &amp; network protection ›
        Allow an app through firewall › MiKallbook (Electron when started with npm start) › Private. The network itself must be set to Private, not Public.</div>
      ${err}
      <div class="modal-btns"><button class="mi-btn" data-a="newcode">New Code</button><button class="mi-btn mi-btn-exit" data-a="stop">Stop Sharing</button><div class="tb-fill"></div><button class="mi-btn" data-a="close">Close</button></div>`;
  } else if (linkRole === 'client') {
    const st = linkStatus === 'lost' ? '<span class="lk-st lost">LINK LOST · reconnecting…</span>'
      : linkStatus === 'linked' ? '<span class="lk-st ok">Linked</span>' : '<span class="lk-st">Linking…</span>';
    const t = linkDiff ? (linkDiff.differentShow ? `The SM is calling a different show: “${esc(linkDiff.smShow)}”.` : esc(diffText(linkDiff))) : '';
    html = `
      <div class="modal-msg">Following the SM</div>
      <div class="lk-row"><span class="lk-addr">${esc(linkTarget)}</span>${st}</div>
      ${smState ? `<div class="lk-hint">SM's computer: ${esc(smState.by || '')} · show “${esc(smState.show)}” · ${smState.order.length} GO point${smState.order.length === 1 ? '' : 's'}</div>` : ''}
      ${t ? `<div class="lk-warn">${linkDiff.differentShow ? t : 'Your copy differs: ' + t + '. Get the latest show file from the SM.'}</div>`
          : (smState ? '<div class="lk-ok">Your copy of the show matches the SM’s.</div>' : '')}
      <div class="lk-hint">While linked, the SM calls: Space and Backspace do nothing here. If the link is lost they work on this computer until it is back.</div>
      ${err}
      <div class="modal-btns"><button class="mi-btn mi-btn-exit" data-a="leave">Leave</button><div class="tb-fill"></div><button class="mi-btn" data-a="close">Close</button></div>`;
  } else {
    html = `
      <div class="modal-msg">Link Computers</div>
      <div class="lk-section">
        <div class="lk-title">Stage manager: share this show</div>
        <div class="lk-hint">Operators' computers follow your Standby and GO. They need a copy of this show folder.</div>
        <div class="modal-btns lk-left"><button class="mi-btn mi-btn-go" data-a="share" style="padding:9px 18px">Start Sharing</button></div>
      </div>
      <div class="lk-section">
        <div class="lk-title">Operator: follow the stage manager</div>
        <div class="lk-hint">Type the address and code shown on the SM's Link window.</div>
        <div class="lk-form">
          <label><span class="mi-label">SM's address</span><input class="mi-input" id="linkAddr" placeholder="192.168.1.20" spellcheck="false" value="${esc(addrVal)}"></label>
          <label><span class="mi-label">Code</span><input class="mi-input lk-codein" id="linkCode" placeholder="0000" maxlength="4" inputmode="numeric" spellcheck="false" value="${esc(codeVal)}"></label>
          <button class="mi-btn mi-btn-go" data-a="join" style="padding:9px 18px">Join</button>
        </div>
      </div>
      ${err}
      <div class="modal-btns"><button class="mi-btn" data-a="close">Close</button></div>`;
  }
  box.innerHTML = html;
  if (focus) {
    const a = document.getElementById('linkAddr');
    if (a) setTimeout(() => (a.value ? document.getElementById('linkCode') : a).focus(), 0);
  }
}

function onLinkDialogClick(e) {
  const btn = e.target.closest('button[data-a]');
  if (!btn) { if (e.target.id === 'linkOverlay') closeLinkDialog(); return; }
  const a = btn.dataset.a;
  if (linkAskResolve) {
    const r = linkAskResolve; linkAskResolve = null;
    r(a === 'yes');
    if (a !== 'yes') renderLinkDialog();
    return;
  }
  if (a === 'close') closeLinkDialog();
  else if (a === 'share') startSharing();
  else if (a === 'stop') stopSharing();
  else if (a === 'newcode') newLinkCode();
  else if (a === 'join') joinSm();
  else if (a === 'leave') leaveSm();
}

// Keys while the dialog is open (app.js passes them here)
function linkDialogKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (linkAskResolve) { const r = linkAskResolve; linkAskResolve = null; r(false); renderLinkDialog(); }
    else closeLinkDialog();
    return;
  }
  if (e.key === 'Enter' && (e.target.id === 'linkAddr' || e.target.id === 'linkCode')) { e.preventDefault(); joinSm(); }
}

// Operator changed department: tell the SM's list
function linkDeptChanged() {
  if (linkRole !== 'client') return;
  const d = deptById(opDept);
  bridge.link.setDept(d ? d.code : '');
}

function initLink() {
  document.getElementById('btnLink').addEventListener('click', openLinkDialog);
  document.getElementById('linkBanner').addEventListener('click', openLinkDialog);
  document.getElementById('linkOverlay').addEventListener('click', onLinkDialogClick);
  document.getElementById('linkOverlay').addEventListener('input', e => {
    if (e.target.id === 'linkCode') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4);
  });
  bridge.link.onStatus(onLinkStatus);
  bridge.link.onState(st => { if (linkRole === 'client') applySm(st, false); });
  bridge.link.onClients(list => {
    if (hostInfo) hostInfo.clients = Array.isArray(list) ? list : [];
    renderLinkUi();
  });
  renderLinkUi();
}
