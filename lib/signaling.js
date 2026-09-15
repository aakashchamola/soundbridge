'use strict';
// Signaling over WebSocket, protected by a shared password.
//
//   Host                                   Joiner
//   ---- {t:'hello', v, salt, nonce} ----->
//                                           keys = PBKDF2(password, salt)
//                                           connKey = HMAC(encKey, nonce)
//   <---- envelope{t:'hi', name, nonce} ---
//   (decrypt ok => password matched; nonce must echo)
//   ---- envelope{t:'hi', name} --------->  (decrypt ok => host proved the password too)
//   <==== envelope{t:'sig', msg} ========>  SDP / ICE for WebRTC, forwarded to the renderer
//
// Every envelope is AES-256-GCM with a fresh random IV and a monotonically
// increasing seq inside the plaintext, so nothing can be replayed or forged
// without the password. The password itself never crosses the wire.

const crypto = require('crypto');
const EventEmitter = require('events');
const { WebSocketServer, WebSocket } = require('ws');

const PROTOCOL = 1;
const PBKDF2_ITERS = 150000;
const AUTH_TIMEOUT_MS = 10000;
const CLOSE_AUTH_FAILED = 4001;
const CLOSE_PROTOCOL = 4002;

function pbkdf2(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERS, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function deriveBaseKey(password, salt) {
  const base = await pbkdf2(password, salt);
  return crypto.createHmac('sha256', base).update('soundbridge-enc-v1').digest();
}

function connectionKey(baseKey, nonce) {
  return crypto.createHmac('sha256', baseKey).update(nonce).digest();
}

// An authenticated, encrypted message channel over one WebSocket.
class Channel {
  constructor(ws, key) {
    this.ws = ws;
    this.key = key;
    this.sendSeq = 0;
    this.recvSeq = 0;
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    const seq = ++this.sendSeq;
    const iv = crypto.randomBytes(12);
    const plain = Buffer.from(JSON.stringify({ seq, ...obj }), 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    this.ws.send(JSON.stringify({ t: 'e', iv: iv.toString('base64'), d: ct.toString('base64') }));
    return true;
  }

  // Throws on any tampering, wrong key, or replay.
  open(envelope) {
    if (!envelope || envelope.t !== 'e' || typeof envelope.iv !== 'string' || typeof envelope.d !== 'string') {
      throw new Error('not an envelope');
    }
    const iv = Buffer.from(envelope.iv, 'base64');
    const buf = Buffer.from(envelope.d, 'base64');
    if (iv.length !== 12 || buf.length < 16) throw new Error('malformed envelope');
    const ct = buf.subarray(0, buf.length - 16);
    const tag = buf.subarray(buf.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    const obj = JSON.parse(plain.toString('utf8'));
    if (!(Number.isInteger(obj.seq) && obj.seq > this.recvSeq)) throw new Error('replayed message');
    this.recvSeq = obj.seq;
    return obj;
  }
}

function parseJson(data) {
  try { return JSON.parse(data.toString('utf8')); } catch { return null; }
}

function describeRemote(req) {
  const addr = req.socket.remoteAddress || '';
  return addr.replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------------------

class SignalHost extends EventEmitter {
  constructor({ port, password, name }) {
    super();
    this.port = port;
    this.password = password;
    this.name = name;
    this.peers = new Map();
    this.wss = null;
    this.baseKey = null;
    this.salt = crypto.randomBytes(16);
    this.counter = 0;
    this.pendingAuths = 0;
  }

  async start() {
    this.baseKey = await deriveBaseKey(this.password, this.salt);
    await new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '0.0.0.0', port: this.port, maxPayload: 256 * 1024 });
      wss.once('listening', () => { wss.off('error', reject); resolve(); });
      wss.once('error', reject);
      this.wss = wss;
    });
    this.wss.on('error', (err) => this.emit('log', `server error: ${err.message}`));
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.emit('log', `listening on port ${this.port}`);
  }

  stop() {
    for (const [id, peer] of this.peers) {
      try { peer.channel.send({ t: 'bye' }); } catch {}
      try { peer.ws.close(1000, 'host stopped'); } catch {}
      this.emit('peer-left', { id, reason: 'host stopped' });
    }
    this.peers.clear();
    if (this.wss) {
      for (const client of this.wss.clients) { try { client.terminate(); } catch {} }
      this.wss.close();
      this.wss = null;
    }
    this.emit('log', 'stopped');
  }

  send(peerId, msg) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    return peer.channel.send({ t: 'sig', msg });
  }

  peerList() {
    return [...this.peers].map(([id, p]) => ({ id, name: p.name, remote: p.remote }));
  }

  _onConnection(ws, req) {
    const remote = describeRemote(req);
    if (this.pendingAuths >= 8) {
      this.emit('log', `too many pending connections, dropping ${remote}`);
      ws.close(CLOSE_PROTOCOL, 'busy');
      return;
    }
    this.pendingAuths++;
    const nonce = crypto.randomBytes(32);
    const key = connectionKey(this.baseKey, nonce);
    const channel = new Channel(ws, key);
    let authed = false;

    const authTimer = setTimeout(() => {
      if (!authed) { this.emit('log', `auth timeout from ${remote}`); ws.close(CLOSE_PROTOCOL, 'auth timeout'); }
    }, AUTH_TIMEOUT_MS);

    const fail = (why) => {
      this.emit('log', `rejected ${remote}: ${why}`);
      this.emit('auth-failed', { remote, why });
      // Small delay makes online guessing slow without hurting real users.
      setTimeout(() => { try { ws.close(CLOSE_AUTH_FAILED, 'auth failed'); } catch {} }, 1000);
    };

    ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL, salt: this.salt.toString('base64'), nonce: nonce.toString('base64') }));

    ws.on('message', (data) => {
      const envelope = parseJson(data);
      let inner;
      try { inner = channel.open(envelope); }
      catch (err) {
        if (!authed) fail('wrong password');
        else { this.emit('log', `bad message from ${remote}: ${err.message}`); ws.close(CLOSE_PROTOCOL, 'bad message'); }
        return;
      }
      if (!authed) {
        if (inner.t !== 'hi' || inner.nonce !== nonce.toString('base64')) { fail('bad handshake'); return; }
        authed = true;
        clearTimeout(authTimer);
        this.pendingAuths--;
        const id = `p${++this.counter}`;
        const name = String(inner.name || remote).slice(0, 64);
        this.peers.set(id, { ws, channel, name, remote });
        ws._sbId = id;
        channel.send({ t: 'hi', name: this.name });
        this.emit('log', `${name} (${remote}) joined as ${id}`);
        this.emit('peer-joined', { id, name, remote });
        return;
      }
      const id = ws._sbId;
      if (inner.t === 'sig') this.emit('message', { id, msg: inner.msg });
      else if (inner.t === 'bye') ws.close(1000, 'peer left');
    });

    ws.on('close', (code, reason) => {
      clearTimeout(authTimer);
      if (!authed) { this.pendingAuths--; return; }
      const id = ws._sbId;
      const peer = this.peers.get(id);
      this.peers.delete(id);
      const why = reason && reason.length ? reason.toString() : `code ${code}`;
      this.emit('log', `${peer ? peer.name : id} left (${why})`);
      this.emit('peer-left', { id, reason: why });
    });

    ws.on('error', (err) => this.emit('log', `socket error from ${remote}: ${err.message}`));
  }
}

// ---------------------------------------------------------------------------

class SignalClient extends EventEmitter {
  constructor({ address, port, password, name }) {
    super();
    this.address = address;
    this.port = port;
    this.password = password;
    this.name = name;
    this.ws = null;
    this.channel = null;
    this.stopped = false;
    this.retryMs = 2000;
    this.retryTimer = null;
    this.peerName = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.channel) { try { this.channel.send({ t: 'bye' }); } catch {} }
    if (this.ws) { try { this.ws.close(1000, 'stopped'); } catch {} }
    this.ws = null;
    this.channel = null;
  }

  send(msg) {
    return this.channel ? this.channel.send({ t: 'sig', msg }) : false;
  }

  _scheduleRetry(why) {
    if (this.stopped) return;
    this.emit('log', `${why}; retrying in ${Math.round(this.retryMs / 1000)}s`);
    this.emit('state', { state: 'waiting', detail: why });
    this.retryTimer = setTimeout(() => this._connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 1.5, 15000);
  }

  _connect() {
    if (this.stopped) return;
    const host = this.address.includes(':') && !this.address.startsWith('[') ? `[${this.address}]` : this.address;
    const url = `ws://${host}:${this.port}`;
    this.emit('log', `connecting to ${url}`);
    this.emit('state', { state: 'connecting', detail: url });
    let ws;
    try { ws = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 256 * 1024 }); }
    catch (err) { this._scheduleRetry(`bad address (${err.message})`); return; }
    this.ws = ws;
    let channel = null;
    let joined = false;

    ws.on('open', () => { this.retryMs = 2000; });

    ws.on('message', async (data) => {
      const packet = parseJson(data);
      if (!channel) {
        if (!packet || packet.t !== 'hello' || packet.v !== PROTOCOL) {
          this.emit('log', 'host spoke an unexpected protocol');
          ws.close(CLOSE_PROTOCOL, 'bad hello');
          return;
        }
        try {
          const baseKey = await deriveBaseKey(this.password, Buffer.from(packet.salt, 'base64'));
          const key = connectionKey(baseKey, Buffer.from(packet.nonce, 'base64'));
          if (ws !== this.ws) return; // stopped while deriving
          channel = new Channel(ws, key);
          channel.send({ t: 'hi', name: this.name, nonce: packet.nonce });
        } catch (err) {
          this.emit('log', `handshake error: ${err.message}`);
          ws.close(CLOSE_PROTOCOL, 'handshake error');
        }
        return;
      }
      let inner;
      try { inner = channel.open(packet); }
      catch (err) {
        this.emit('log', `could not read host message (${err.message})`);
        this.stopped = true;
        ws.close(CLOSE_AUTH_FAILED, 'host failed auth');
        this.emit('auth-failed', { why: 'host could not prove the password' });
        return;
      }
      if (!joined) {
        if (inner.t !== 'hi') { ws.close(CLOSE_PROTOCOL, 'bad hi'); return; }
        joined = true;
        this.channel = channel;
        this.peerName = String(inner.name || this.address).slice(0, 64);
        this.emit('log', `joined ${this.peerName}`);
        this.emit('connected', { name: this.peerName, remote: this.address });
        return;
      }
      if (inner.t === 'sig') this.emit('message', { msg: inner.msg });
      else if (inner.t === 'bye') ws.close(1000, 'host left');
    });

    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.channel = null;
      const why = reason && reason.length ? reason.toString() : `code ${code}`;
      if (joined) this.emit('disconnected', { reason: why });
      if (code === CLOSE_AUTH_FAILED) {
        this.stopped = true;
        this.emit('auth-failed', { why: 'wrong password' });
        return;
      }
      this._scheduleRetry(joined ? `connection lost (${why})` : `could not join (${why})`);
    });

    ws.on('error', (err) => {
      // 'close' follows and schedules the retry; just report.
      this.emit('log', `connection error: ${err.message}`);
    });
  }
}

module.exports = { SignalHost, SignalClient, PROTOCOL };
