'use strict';
// SoundBridge renderer: audio capture, WebRTC peers, playback routing, UI.
// The main process owns the password-protected signaling channel; this file
// only ever sees plain SDP/ICE messages addressed by peer id.

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
// Stereo, no DTX: this carries game/music audio, not speech. Bitrate comes from the Quality select.
const opusParams = () => `minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${state.quality};maxplaybackrate=48000;cbr=0;usedtx=0`;
const DEFAULT_QUALITY = 256000;

const ui = {
  version: $('#version'), hostname: $('#hostname'), addresses: $('#addresses'),
  roleInputs: [...document.querySelectorAll('input[name=role]')],
  joinFields: $('#join-fields'), hostHint: $('#host-hint'),
  address: $('#address'), port: $('#port'), password: $('#password'), togglePw: $('#toggle-pw'),
  displayName: $('#displayName'), autoConnect: $('#autoConnect'),
  btnStart: $('#btn-start'), btnStop: $('#btn-stop'), status: $('#status'), statusText: $('#status-text'),
  shareSystem: $('#shareSystem'), muteLocal: $('#muteLocal'), micSelect: $('#micSelect'), quality: $('#quality'), sendMeter: $('#send-meter i'),
  outputSelect: $('#outputSelect'), refreshDevices: $('#refresh-devices'), volume: $('#volume'), volumeValue: $('#volume-value'),
  muteIncoming: $('#muteIncoming'), recvMeter: $('#recv-meter i'),
  profileSelect: $('#profileSelect'), btnLoad: $('#btn-load'), btnDelete: $('#btn-delete'), profileName: $('#profileName'), btnSave: $('#btn-save'),
  peers: $('#peers'), log: $('#log'), btnClearLog: $('#btn-clear-log'), btnOpenData: $('#btn-open-data'),
};

const state = {
  info: null,
  running: false,
  role: 'host',
  statusLine: 'Idle',
  peers: new Map(),          // peerId -> Peer
  pendingSignals: new Map(), // peerId -> [msg] (arrived before the peer object existed)
  local: { system: null, mic: null }, // MediaStreams we send
  outputId: '',
  volume: 1,
  muteIncoming: false,
  quality: DEFAULT_QUALITY, // Opus bits per second for what this PC sends
  devices: { inputs: [], outputs: [] },
  profiles: [],
};

// ------------------------------------------------------------------ logging

const logLines = [];
function log(line) {
  const stamp = new Date().toLocaleTimeString([], { hour12: false });
  logLines.push(`${stamp}  ${line}`);
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400);
  const atBottom = ui.log.scrollTop + ui.log.clientHeight >= ui.log.scrollHeight - 4;
  ui.log.textContent = logLines.join('\n');
  if (atBottom) ui.log.scrollTop = ui.log.scrollHeight;
}

// ------------------------------------------------------------------ SDP tuning

function tuneSdp(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/);
  if (!m) return sdp;
  const pt = m[1];
  const fmtp = new RegExp(`a=fmtp:${pt} [^\\r\\n]*\\r?\\n`);
  if (fmtp.test(sdp)) sdp = sdp.replace(fmtp, `a=fmtp:${pt} ${opusParams()}\r\n`);
  else sdp = sdp.replace(`a=rtpmap:${pt} opus/48000/2\r\n`, `a=rtpmap:${pt} opus/48000/2\r\na=fmtp:${pt} ${opusParams()}\r\n`);
  // 10 ms packets shave latency; Chromium honours ptime from the remote description.
  if (!/a=ptime:/.test(sdp)) sdp = sdp.replace(/(m=audio[^\r\n]*\r\n)/, `$1a=ptime:10\r\n`);
  return sdp;
}

// ------------------------------------------------------------------ level meters

let audioCtx = null;
const getCtx = () => (audioCtx ||= new AudioContext({ latencyHint: 'interactive' }));

class Meter {
  constructor(el) {
    this.el = el;
    this.sources = new Map();
    this.analyser = null;
    this.raf = null;
    this.tick = this.tick.bind(this);
  }
  add(key, stream) {
    if (this.sources.has(key) || !stream.getAudioTracks().length) return;
    if (!this.analyser) { this.analyser = getCtx().createAnalyser(); this.analyser.fftSize = 512; this.buf = new Float32Array(this.analyser.fftSize); }
    const src = getCtx().createMediaStreamSource(stream);
    src.connect(this.analyser);
    this.sources.set(key, src);
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }
  remove(key) {
    const src = this.sources.get(key);
    if (src) { try { src.disconnect(); } catch {} this.sources.delete(key); }
    if (!this.sources.size) { cancelAnimationFrame(this.raf); this.raf = null; this.el.style.width = '0%'; }
  }
  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const db = 20 * Math.log10(Math.sqrt(sum / this.buf.length) || 1e-6);
    this.el.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    this.raf = requestAnimationFrame(this.tick);
  }
}
const sendMeter = new Meter(ui.sendMeter);
const recvMeter = new Meter(ui.recvMeter);

// ------------------------------------------------------------------ devices

function fillSelect(select, devices, noneLabel) {
  const prev = select.value;
  select.innerHTML = '';
  if (noneLabel) select.append(new Option(noneLabel, ''));
  for (const d of devices) select.append(new Option(d.label || `${d.kind} ${d.deviceId.slice(0, 8)}`, d.deviceId));
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
}

function pickDevice(select, id, label) {
  const opts = [...select.options];
  const byId = opts.find((o) => o.value === id && id);
  const byLabel = opts.find((o) => o.text === label && label);
  if (byId) select.value = byId.value;
  else if (byLabel) select.value = byLabel.value;
}

async function refreshDevices() {
  let list = await navigator.mediaDevices.enumerateDevices();
  if (list.some((d) => d.kind !== 'videoinput' && !d.label)) {
    // Labels unlock once any audio stream has been granted.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      list = await navigator.mediaDevices.enumerateDevices();
    } catch {}
  }
  state.devices.inputs = list.filter((d) => d.kind === 'audioinput');
  state.devices.outputs = list.filter((d) => d.kind === 'audiooutput');
  fillSelect(ui.micSelect, state.devices.inputs, 'None');
  fillSelect(ui.outputSelect, state.devices.outputs, state.devices.outputs.length ? null : 'No output devices found');
  state.outputId = ui.outputSelect.value;
}

// ------------------------------------------------------------------ local capture

async function acquireSystem() {
  if (state.local.system) return;
  sb.setCaptureMute(ui.muteLocal.checked);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  stream.getVideoTracks().forEach((t) => t.stop());
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('Windows gave no system audio track');
  track.contentHint = 'music';
  try { await track.applyConstraints({ echoCancellation: false, noiseSuppression: false, autoGainControl: false }); } catch {}
  const ms = new MediaStream([track]);
  track.onended = () => {
    if (state.local.system === ms) { state.local.system = null; log('system audio capture ended'); sendMeter.remove('system'); syncAllPeers(); }
  };
  state.local.system = ms;
  sendMeter.add('system', ms);
  const s = track.getSettings();
  log(`capturing system audio (${s.sampleRate || '?'} Hz, ${s.channelCount || '?'} ch${ui.muteLocal.checked ? ', local speakers muted' : ''})`);
}

async function acquireMic(deviceId) {
  const current = state.local.mic;
  if (current && current._deviceId === deviceId) return;
  releaseLocal('mic');
  const ms = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  ms._deviceId = deviceId;
  const track = ms.getAudioTracks()[0];
  track.contentHint = 'speech';
  track.onended = () => {
    if (state.local.mic === ms) { state.local.mic = null; log('microphone capture ended'); sendMeter.remove('mic'); syncAllPeers(); }
  };
  state.local.mic = ms;
  sendMeter.add('mic', ms);
  log(`capturing microphone: ${track.label}`);
}

function releaseLocal(kind) {
  const ms = state.local[kind];
  if (!ms) return;
  ms.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  state.local[kind] = null;
  sendMeter.remove(kind);
}

// Make what we capture match the checkboxes, then push it to every peer.
async function syncLocalCaptures() {
  if (ui.shareSystem.checked) {
    try { await acquireSystem(); }
    catch (err) { log(`system audio capture failed: ${err.message}`); ui.shareSystem.checked = false; }
  } else releaseLocal('system');

  const micId = ui.micSelect.value;
  if (micId) {
    try { await acquireMic(micId); }
    catch (err) { log(`microphone capture failed: ${err.message}`); ui.micSelect.value = ''; }
  } else releaseLocal('mic');

  await syncAllPeers();
}

async function syncAllPeers() {
  for (const peer of state.peers.values()) await peer.syncLocal();
}

// ------------------------------------------------------------------ playback

function applyOutput(el) {
  el.volume = state.volume;
  el.muted = state.muteIncoming;
  if (state.outputId && typeof el.setSinkId === 'function') {
    el.setSinkId(state.outputId).catch((err) => log(`could not route to output device: ${err.message}`));
  }
}

function applyOutputToAll() {
  for (const peer of state.peers.values()) for (const p of peer.players.values()) applyOutput(p.el);
}

// ------------------------------------------------------------------ peers

class Peer {
  constructor(id, name, remote, polite) {
    this.id = id;
    this.name = name;
    this.remote = remote;
    this.polite = polite;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.senders = { system: null, mic: null };
    this.players = new Map(); // track id -> { el, track, mid }
    this.remoteKinds = {};    // mid -> 'system' | 'mic'
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.settingRemoteAnswer = false;
    this.disconnectTimer = null;
    this.stats = { in: 0, out: 0, rtt: null, bufferMs: null, lost: 0, path: '', lastTs: 0, lastIn: 0, lastOut: 0, lastJbDelay: 0, lastJbCount: 0 };

    const pc = this.pc;
    pc.onnegotiationneeded = () => this.negotiate();
    pc.onicecandidate = ({ candidate }) => { if (candidate) sb.sendSignal(this.id, { t: 'ice', candidate: candidate.toJSON() }); };
    pc.ontrack = (ev) => this.onTrack(ev);
    pc.onconnectionstatechange = () => this.onConnectionState();
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') { log(`[${this.name}] ICE failed, restarting`); pc.restartIce(); }
    };
  }

  get connectionState() { return this.pc.connectionState; }

  async negotiate() {
    const pc = this.pc;
    try {
      this.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription({ type: 'offer', sdp: tuneSdp(offer.sdp) });
      sb.sendSignal(this.id, { t: 'sdp', description: pc.localDescription.toJSON() });
      this.sendMeta();
    } catch (err) {
      log(`[${this.name}] offer failed: ${err.message}`);
    } finally {
      this.makingOffer = false;
    }
  }

  // Signaling messages are handled strictly one after another per peer.
  handle(msg) {
    this.queue = (this.queue || Promise.resolve()).then(() => this._handle(msg));
    return this.queue;
  }

  async _handle(msg) {
    const pc = this.pc;
    if (msg.t === 'meta') {
      this.remoteKinds = msg.mids || {};
      renderPeers();
      return;
    }
    if (msg.t === 'sdp') {
      const d = msg.description;
      const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.settingRemoteAnswer);
      const collision = d.type === 'offer' && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      this.settingRemoteAnswer = d.type === 'answer';
      try { await pc.setRemoteDescription({ type: d.type, sdp: tuneSdp(d.sdp) }); }
      finally { this.settingRemoteAnswer = false; }
      if (d.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({ type: 'answer', sdp: tuneSdp(answer.sdp) });
        sb.sendSignal(this.id, { t: 'sdp', description: pc.localDescription.toJSON() });
        this.sendMeta();
      }
      this.pruneInactive();
      return;
    }
    if (msg.t === 'ice') {
      try { await pc.addIceCandidate(msg.candidate); }
      catch (err) { if (!this.ignoreOffer) log(`[${this.name}] ICE candidate rejected: ${err.message}`); }
    }
  }

  // Tell the other side which of our transceivers carries what.
  sendMeta() {
    const mids = {};
    for (const kind of ['system', 'mic']) {
      const sender = this.senders[kind];
      const tr = sender && this.pc.getTransceivers().find((t) => t.sender === sender);
      if (tr && tr.mid != null) mids[tr.mid] = kind;
    }
    sb.sendSignal(this.id, { t: 'meta', mids });
  }

  async syncLocal() {
    for (const kind of ['system', 'mic']) {
      const stream = state.local[kind];
      const track = stream ? stream.getAudioTracks()[0] : null;
      const sender = this.senders[kind];
      try {
        if (track && !sender) {
          this.senders[kind] = this.pc.addTrack(track, stream);
          await this.tuneSender(this.senders[kind]);
        } else if (track && sender && sender.track !== track) {
          await sender.replaceTrack(track);
        } else if (!track && sender) {
          this.pc.removeTrack(sender);
          this.senders[kind] = null;
        }
      } catch (err) {
        log(`[${this.name}] could not update ${kind} track: ${err.message}`);
      }
    }
    this.sendMeta();
    renderPeers();
  }

  // Apply a new Quality setting live: cap the encoder now, then renegotiate so the
  // SDP-level cap follows (the encoder reads that from the remote description).
  async applyQuality() {
    for (const kind of ['system', 'mic']) if (this.senders[kind]) await this.tuneSender(this.senders[kind]);
    if (this.pc.signalingState === 'stable') this.negotiate();
  }

  async tuneSender(sender) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = state.quality;
      params.encodings[0].priority = 'high';
      params.encodings[0].networkPriority = 'high';
      await sender.setParameters(params);
    } catch { /* advisory only */ }
  }

  onTrack({ track, transceiver, receiver }) {
    // Ask the jitter buffer for the shortest delay it can manage.
    try { receiver.playoutDelayHint = 0; } catch {}
    try { receiver.jitterBufferTarget = 0; } catch {}
    if (this.players.has(track.id)) return;
    const ms = new MediaStream([track]);
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = ms;
    applyOutput(el);
    el.play().catch((err) => log(`[${this.name}] playback blocked: ${err.message}`));
    this.players.set(track.id, { el, track, mid: transceiver.mid, ms });
    recvMeter.add(`${this.id}:${track.id}`, ms);
    track.onended = () => this.dropTrack(track.id);
    track.onmute = renderPeers;
    track.onunmute = renderPeers;
    log(`[${this.name}] receiving ${this.kindOf(transceiver.mid)}`);
    renderPeers();
  }

  kindOf(mid) {
    const k = this.remoteKinds[mid];
    return k === 'system' ? 'system audio' : k === 'mic' ? 'microphone' : 'audio';
  }

  dropTrack(trackId) {
    const p = this.players.get(trackId);
    if (!p) return;
    p.el.pause();
    p.el.srcObject = null;
    recvMeter.remove(`${this.id}:${trackId}`);
    this.players.delete(trackId);
    renderPeers();
  }

  // After a renegotiation, stop playing tracks whose transceiver no longer sends to us.
  pruneInactive() {
    for (const tr of this.pc.getTransceivers()) {
      const cd = tr.currentDirection;
      const receiving = cd === 'sendrecv' || cd === 'recvonly';
      if (!receiving) this.dropTrack(tr.receiver.track.id);
    }
    renderPeers();
  }

  onConnectionState() {
    const s = this.pc.connectionState;
    log(`[${this.name}] media ${s}`);
    clearTimeout(this.disconnectTimer);
    if (s === 'disconnected') {
      this.disconnectTimer = setTimeout(() => {
        if (this.pc.connectionState === 'disconnected') { log(`[${this.name}] still disconnected, restarting ICE`); this.pc.restartIce(); }
      }, 4000);
    } else if (s === 'failed') {
      this.pc.restartIce();
    }
    renderPeers();
    updateStatusLine();
  }

  async updateStats() {
    if (this.pc.connectionState !== 'connected') return;
    let report;
    try { report = await this.pc.getStats(); } catch { return; }
    const now = performance.now();
    let inBytes = 0, outBytes = 0, jbDelay = 0, jbCount = 0, lost = 0, rtt = null, path = '';
    let pairId = null;
    report.forEach((s) => {
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        inBytes += s.bytesReceived || 0; jbDelay += s.jitterBufferDelay || 0; jbCount += s.jitterBufferEmittedCount || 0; lost += s.packetsLost || 0;
      } else if (s.type === 'outbound-rtp' && s.kind === 'audio') {
        outBytes += s.bytesSent || 0;
      } else if (s.type === 'transport' && s.selectedCandidatePairId) {
        pairId = s.selectedCandidatePairId;
      }
    });
    const pair = pairId ? report.get(pairId) : null;
    if (pair) {
      rtt = pair.currentRoundTripTime ?? null;
      const local = report.get(pair.localCandidateId), remote = report.get(pair.remoteCandidateId);
      if (local && remote) {
        const types = [local.candidateType, remote.candidateType];
        path = types.includes('relay') ? 'relayed' : types.every((t) => t === 'host') ? 'direct, same network' : 'direct, over internet';
      }
    }
    const st = this.stats;
    const dt = (now - st.lastTs) / 1000;
    if (st.lastTs && dt > 0) {
      st.in = ((inBytes - st.lastIn) * 8) / dt / 1000;
      st.out = ((outBytes - st.lastOut) * 8) / dt / 1000;
      const dCount = jbCount - st.lastJbCount;
      if (dCount > 0) st.bufferMs = ((jbDelay - st.lastJbDelay) / dCount) * 1000;
    }
    Object.assign(st, { lastTs: now, lastIn: inBytes, lastOut: outBytes, lastJbDelay: jbDelay, lastJbCount: jbCount, lost, rtt, path });
  }

  close() {
    clearTimeout(this.disconnectTimer);
    for (const id of [...this.players.keys()]) this.dropTrack(id);
    this.pc.onnegotiationneeded = this.pc.onicecandidate = this.pc.ontrack = this.pc.onconnectionstatechange = null;
    try { this.pc.close(); } catch {}
  }

  html() {
    const s = this.stats;
    const sending = ['system', 'mic'].filter((k) => this.senders[k] && this.senders[k].track).map((k) => (k === 'system' ? 'system audio' : 'microphone'));
    const receiving = [...this.players.values()].map((p) => this.kindOf(p.mid) + (p.track.muted ? ' (silent)' : ''));
    const kbps = (v) => (v ? `${v.toFixed(0)} kb/s` : '');
    const rtt = s.rtt != null ? `${(s.rtt * 1000).toFixed(0)} ms` : '–';
    const buf = s.bufferMs != null ? `${s.bufferMs.toFixed(0)} ms` : '–';
    const cs = this.pc.connectionState;
    return `<div class="peer ${esc(cs)}">
      <div class="peer-head"><b>${esc(this.name)}</b><span class="muted">${esc(this.remote)}</span><span class="badge">${esc(cs)}</span></div>
      <div class="peer-body">
        <span>Sending</span><span><b>${esc(sending.join(' + ') || 'nothing')}</b> ${esc(kbps(s.out))}</span>
        <span>Receiving</span><span><b>${esc(receiving.join(' + ') || 'nothing')}</b> ${esc(kbps(s.in))}</span>
        <span>Link</span><span>${esc(s.path || '–')} · RTT ${rtt} · buffer ${buf}${s.lost ? ` · lost ${s.lost}` : ''}</span>
      </div>
    </div>`;
  }
}

function renderPeers() {
  if (!state.peers.size) { ui.peers.innerHTML = '<div class="empty">No one connected yet.</div>'; return; }
  ui.peers.innerHTML = [...state.peers.values()].map((p) => p.html()).join('');
}

async function addPeer({ id, name, remote }) {
  removePeer(id);
  const peer = new Peer(id, name, remote, state.role === 'host');
  state.peers.set(id, peer);
  log(`${name} (${remote}) connected`);
  await peer.syncLocal();
  const queued = state.pendingSignals.get(id) || [];
  state.pendingSignals.delete(id);
  for (const msg of queued) await peer.handle(msg);
  renderPeers();
  updateStatusLine();
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.close();
  state.peers.delete(id);
  renderPeers();
  updateStatusLine();
}

function removeAllPeers() {
  for (const id of [...state.peers.keys()]) removePeer(id);
  state.pendingSignals.clear();
}

setInterval(async () => {
  if (!state.peers.size) return;
  for (const peer of state.peers.values()) await peer.updateStats();
  renderPeers();
}, 1000);

// ------------------------------------------------------------------ status / start / stop

function setStatus(kind, text) {
  ui.status.className = `status ${kind}`;
  ui.statusText.textContent = text;
  state.statusLine = text;
  document.title = kind === 'idle' ? 'SoundBridge' : `SoundBridge · ${text}`;
}

function updateStatusLine() {
  if (!state.running) return;
  const live = [...state.peers.values()].filter((p) => p.connectionState === 'connected').length;
  if (state.role === 'host') {
    const n = state.peers.size;
    setStatus(n ? 'ok' : 'busy', n ? `Hosting · ${n} connected${live < n ? ` (${n - live} negotiating)` : ''}` : `Hosting on port ${ui.port.value} · waiting for someone to join`);
  } else if (state.peers.size) {
    const p = [...state.peers.values()][0];
    setStatus(live ? 'ok' : 'busy', live ? `Connected to ${p.name}` : `Joined ${p.name} · negotiating media`);
  }
}

function setRunningUi(running) {
  state.running = running;
  ui.btnStart.hidden = running;
  ui.btnStop.hidden = !running;
  for (const el of [...ui.roleInputs, ui.address, ui.port, ui.password, ui.displayName]) el.disabled = running;
  ui.hostHint.hidden = !(running && state.role === 'host');
}

function showHostHint() {
  const port = ui.port.value;
  const addrs = (state.info?.addresses || []).map((a) => `<code>${esc(a.address)}:${esc(port)}</code>`).join(' or ');
  ui.hostHint.innerHTML = `On the other PC choose <b>Join</b> and enter ${addrs || 'this PC\'s address'} with the same password.<br>
    From outside your network: forward TCP port <code>${esc(port)}</code> on your router to this PC and give them your public address instead. Audio itself finds its own way (STUN).`;
}

async function start() {
  const role = ui.roleInputs.find((r) => r.checked).value;
  const password = ui.password.value;
  let address = ui.address.value.trim();
  let port = Number(ui.port.value) || state.info.defaultPort;
  if (password.length < 4) { setStatus('error', 'Password must be at least 4 characters'); ui.password.focus(); return; }
  if (role === 'join') {
    if (!address) { setStatus('error', 'Enter the host address'); ui.address.focus(); return; }
    const m = address.match(/^(.+):(\d{1,5})$/);
    if (m && !address.includes('[') && address.split(':').length === 2) { address = m[1]; port = Number(m[2]); ui.address.value = address; ui.port.value = port; }
  }
  state.role = role;
  await saveSettings();
  setRunningUi(true);
  setStatus('busy', role === 'host' ? 'Starting…' : 'Connecting…');
  await syncLocalCaptures();
  const res = await sb.start({ role, address, port, password, displayName: ui.displayName.value.trim() || state.info.hostname });
  if (!res.ok) {
    setRunningUi(false);
    releaseLocal('system'); releaseLocal('mic');
    setStatus('error', res.error);
    log(`start failed: ${res.error}`);
    return;
  }
  if (role === 'host') showHostHint();
}

async function stop() {
  await sb.stop();
  removeAllPeers();
  releaseLocal('system');
  releaseLocal('mic');
  setRunningUi(false);
  setStatus('idle', 'Idle');
}

// ------------------------------------------------------------------ settings & profiles

function readSettingsFromUi() {
  return {
    role: ui.roleInputs.find((r) => r.checked).value,
    address: ui.address.value.trim(),
    port: Number(ui.port.value) || state.info.defaultPort,
    password: ui.password.value,
    displayName: ui.displayName.value.trim(),
    autoConnect: ui.autoConnect.checked,
    shareSystem: ui.shareSystem.checked,
    muteLocal: ui.muteLocal.checked,
    micId: ui.micSelect.value,
    micLabel: ui.micSelect.selectedOptions[0]?.text || '',
    quality: Number(ui.quality.value) || DEFAULT_QUALITY,
    outputId: ui.outputSelect.value,
    outputLabel: ui.outputSelect.selectedOptions[0]?.text || '',
    volume: Number(ui.volume.value),
    muteIncoming: ui.muteIncoming.checked,
  };
}

function applySettingsToUi(s) {
  for (const r of ui.roleInputs) r.checked = r.value === (s.role || 'host');
  ui.address.value = s.address || '';
  ui.port.value = s.port || state.info.defaultPort;
  ui.password.value = s.password || '';
  ui.displayName.value = s.displayName || state.info.hostname;
  ui.autoConnect.checked = !!s.autoConnect;
  ui.shareSystem.checked = !!s.shareSystem;
  ui.muteLocal.checked = !!s.muteLocal;
  if (s.micId || s.micLabel) pickDevice(ui.micSelect, s.micId, s.micLabel); else ui.micSelect.value = '';
  ui.quality.value = String(s.quality || DEFAULT_QUALITY);
  if (!ui.quality.value) ui.quality.value = String(DEFAULT_QUALITY);
  state.quality = Number(ui.quality.value);
  pickDevice(ui.outputSelect, s.outputId, s.outputLabel);
  ui.volume.value = s.volume ?? 100;
  ui.muteIncoming.checked = !!s.muteIncoming;
  onRoleChange();
  onVolumeChange();
  state.outputId = ui.outputSelect.value;
  state.muteIncoming = ui.muteIncoming.checked;
}

let saveTimer = null;
function saveSettingsSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveSettings, 300); }
async function saveSettings() { clearTimeout(saveTimer); await sb.storeSet('settings', readSettingsFromUi()); }

async function refreshProfiles() {
  state.profiles = (await sb.storeGet('profiles')) || [];
  const prev = ui.profileSelect.value;
  ui.profileSelect.innerHTML = '<option value="">— saved profiles —</option>';
  for (const p of state.profiles) ui.profileSelect.append(new Option(p.name, p.name));
  if (state.profiles.some((p) => p.name === prev)) ui.profileSelect.value = prev;
}

async function saveProfile() {
  const name = ui.profileName.value.trim() || ui.profileSelect.value;
  if (!name) { ui.profileName.focus(); ui.profileName.placeholder = 'Give the profile a name first'; return; }
  const profile = { name, ...readSettingsFromUi() };
  const idx = state.profiles.findIndex((p) => p.name === name);
  if (idx >= 0) state.profiles[idx] = profile; else state.profiles.push(profile);
  await sb.storeSet('profiles', state.profiles);
  await refreshProfiles();
  ui.profileSelect.value = name;
  ui.profileName.value = '';
  log(`profile "${name}" saved`);
}

async function loadProfile() {
  const p = state.profiles.find((x) => x.name === ui.profileSelect.value);
  if (!p) return;
  if (state.running) await stop();
  applySettingsToUi(p);
  await saveSettings();
  log(`profile "${p.name}" loaded`);
}

async function deleteProfile() {
  const name = ui.profileSelect.value;
  if (!name) return;
  state.profiles = state.profiles.filter((p) => p.name !== name);
  await sb.storeSet('profiles', state.profiles);
  await refreshProfiles();
  log(`profile "${name}" deleted`);
}

// ------------------------------------------------------------------ UI events

function onRoleChange() {
  const role = ui.roleInputs.find((r) => r.checked).value;
  ui.joinFields.hidden = role !== 'join';
}

function onVolumeChange() {
  state.volume = Number(ui.volume.value) / 100;
  ui.volumeValue.textContent = `${ui.volume.value}%`;
  applyOutputToAll();
}

function bindEvents() {
  for (const r of ui.roleInputs) r.addEventListener('change', () => { onRoleChange(); saveSettingsSoon(); });
  for (const el of [ui.address, ui.port, ui.password, ui.displayName, ui.autoConnect]) el.addEventListener('input', saveSettingsSoon);
  ui.togglePw.addEventListener('click', () => {
    const show = ui.password.type === 'password';
    ui.password.type = show ? 'text' : 'password';
    ui.togglePw.textContent = show ? 'hide' : 'show';
  });
  ui.btnStart.addEventListener('click', () => start().catch((err) => { log(`start error: ${err.message}`); setStatus('error', err.message); setRunningUi(false); }));
  ui.btnStop.addEventListener('click', () => stop().catch((err) => log(`stop error: ${err.message}`)));
  for (const el of [ui.address, ui.password, ui.port]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.running) ui.btnStart.click(); });

  const resync = () => { saveSettingsSoon(); if (state.running) syncLocalCaptures().catch((err) => log(err.message)); };
  ui.shareSystem.addEventListener('change', resync);
  ui.micSelect.addEventListener('change', resync);
  ui.quality.addEventListener('change', () => {
    state.quality = Number(ui.quality.value) || DEFAULT_QUALITY;
    saveSettingsSoon();
    log(`quality set to ${Math.round(state.quality / 1000)} kb/s`);
    for (const peer of state.peers.values()) peer.applyQuality().catch((err) => log(`[${peer.name}] quality change failed: ${err.message}`));
  });
  ui.muteLocal.addEventListener('change', () => {
    saveSettingsSoon();
    // Mute mode is fixed when capture starts, so restart the capture to apply it.
    if (state.running && state.local.system) { releaseLocal('system'); syncLocalCaptures().catch((err) => log(err.message)); }
  });

  ui.outputSelect.addEventListener('change', () => { state.outputId = ui.outputSelect.value; applyOutputToAll(); saveSettingsSoon(); });
  ui.refreshDevices.addEventListener('click', () => refreshDevices().then(() => { state.outputId = ui.outputSelect.value; applyOutputToAll(); }));
  ui.volume.addEventListener('input', () => { onVolumeChange(); saveSettingsSoon(); });
  ui.muteIncoming.addEventListener('change', () => { state.muteIncoming = ui.muteIncoming.checked; applyOutputToAll(); saveSettingsSoon(); });

  ui.btnSave.addEventListener('click', saveProfile);
  ui.btnLoad.addEventListener('click', loadProfile);
  ui.btnDelete.addEventListener('click', deleteProfile);
  ui.profileName.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveProfile(); });
  ui.btnClearLog.addEventListener('click', () => { logLines.length = 0; ui.log.textContent = ''; });
  ui.btnOpenData.addEventListener('click', () => sb.openPath(state.info.userData));

  navigator.mediaDevices.addEventListener('devicechange', () => {
    const prevOut = ui.outputSelect.selectedOptions[0]?.text;
    const prevMic = ui.micSelect.selectedOptions[0]?.text;
    refreshDevices().then(() => {
      pickDevice(ui.outputSelect, ui.outputSelect.value, prevOut);
      pickDevice(ui.micSelect, ui.micSelect.value, prevMic);
      state.outputId = ui.outputSelect.value;
      applyOutputToAll();
    });
  });

  // ---- events from the main process
  sb.onLog(log);
  sb.onState((s) => {
    if (s.state === 'idle') { if (state.running) { removeAllPeers(); setRunningUi(false); } setStatus('idle', 'Idle'); }
    else if (s.state === 'hosting') updateStatusLine();
    else if (s.state === 'connecting') setStatus('busy', `Connecting to ${s.detail || 'host'}…`);
    else if (s.state === 'waiting') setStatus('busy', `Retrying: ${s.detail}`);
    else if (s.state === 'joined') updateStatusLine();
    else if (s.state === 'error') { removeAllPeers(); releaseLocal('system'); releaseLocal('mic'); setRunningUi(false); setStatus('error', s.detail); }
  });
  sb.onPeer((p) => {
    if (p.event === 'joined') addPeer(p).catch((err) => log(`peer setup failed: ${err.message}`));
    else if (p.event === 'left') { log(`${p.id === 'host' ? 'host' : state.peers.get(p.id)?.name || p.id} disconnected (${p.reason})`); removePeer(p.id); }
    else if (p.event === 'auth-failed') log(`someone at ${p.remote} tried the wrong password`);
  });
  sb.onSignal(({ peerId, msg }) => {
    const peer = state.peers.get(peerId);
    if (peer) peer.handle(msg).catch((err) => log(`[${peer.name}] signaling error: ${err.message}`));
    else {
      if (!state.pendingSignals.has(peerId)) state.pendingSignals.set(peerId, []);
      state.pendingSignals.get(peerId).push(msg);
    }
  });
}

// ------------------------------------------------------------------ boot

async function init() {
  state.info = await sb.getInfo();
  ui.version.textContent = `v${state.info.version}`;
  ui.hostname.textContent = state.info.hostname;
  ui.addresses.textContent = state.info.addresses.length ? `· ${state.info.addresses.map((a) => a.address).join(' · ')}` : '· no network';
  bindEvents();
  await refreshDevices();
  const saved = (await sb.storeGet('settings')) || {};
  applySettingsToUi(saved);
  await refreshProfiles();
  log(`ready · ${state.devices.outputs.length} output device(s), ${state.devices.inputs.length} microphone(s)`);
  if (state.info.testTone) {
    // Test hook: a quiet tone on this PC's default output, so "system audio" has something to capture.
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.02;
    osc.frequency.value = 440;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    log('test tone playing at 440 Hz');
  }
  if (saved.autoConnect && saved.password) {
    log('auto-start is on');
    start().catch((err) => { log(`auto-start failed: ${err.message}`); setStatus('error', err.message); setRunningUi(false); });
  }
}

init().catch((err) => { log(`startup error: ${err.message}`); setStatus('error', err.message); });
