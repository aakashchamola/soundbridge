'use strict';
// SoundBridge main process: window, system-audio capture permission, password
// protected signaling (host or join), and the settings/profile store.
// All audio work (capture, WebRTC, playback) happens in the renderer.

const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell } = require('electron');
const path = require('path');
const os = require('os');
const { SignalHost, SignalClient } = require('./lib/signaling');
const { JsonStore } = require('./lib/store');

// Both peers are ours, so put real LAN IPs in ICE candidates instead of mDNS
// names; that makes same-network connections direct and reliable.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const DEFAULT_PORT = 47800;

// Dev/test hooks, all optional environment variables. Used by scripts/test-e2e.ps1
// to run a host and a joiner on one PC; they do nothing when unset.
const TEST = {
  userData: process.env.SB_USER_DATA,                // separate settings folder per instance
  seed: process.env.SB_SEED_SETTINGS,                // JSON written to settings.json before the window opens
  tone: process.env.SB_TONE === '1',                 // renderer plays a quiet 440 Hz tone (to be captured as system audio)
  screenshot: process.env.SB_SCREENSHOT,             // save a PNG of the window here ...
  screenshotAfter: Number(process.env.SB_SCREENSHOT_AFTER || 8000), // ... after this many ms
  quitAfter: Number(process.env.SB_QUIT_AFTER || 0), // quit after this many ms
  windowX: process.env.SB_WINDOW_X,
  logConsole: process.env.SB_LOG_CONSOLE === '1',    // echo app log + renderer console to stdout
  hostname: process.env.SB_HOSTNAME,                 // display name override, for documentation screenshots
};
if (TEST.userData) app.setPath('userData', TEST.userData);

let win = null;
let net = null; // { role: 'host' | 'join', obj }
let loopbackMode = 'loopback'; // or 'loopbackWithMute'
let store = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const log = (line) => { if (TEST.logConsole) console.log(`[main] ${line}`); send('log', line); };

function lanAddresses() {
  const out = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

function stopNet(emitIdle = true) {
  if (net) {
    try { net.obj.stop(); } catch (err) { log(`stop error: ${err.message}`); }
    net = null;
  }
  if (emitIdle) send('net:state', { state: 'idle' });
}

function wireHost(host) {
  host.on('log', log);
  host.on('peer-joined', (p) => send('net:peer', { event: 'joined', ...p }));
  host.on('peer-left', (p) => send('net:peer', { event: 'left', ...p }));
  host.on('auth-failed', (p) => send('net:peer', { event: 'auth-failed', ...p }));
  host.on('message', ({ id, msg }) => send('net:signal', { peerId: id, msg }));
}

function wireClient(client) {
  client.on('log', log);
  client.on('state', (s) => send('net:state', s));
  client.on('connected', (p) => {
    send('net:state', { state: 'joined', detail: p.name });
    send('net:peer', { event: 'joined', id: 'host', ...p });
  });
  client.on('disconnected', (p) => send('net:peer', { event: 'left', id: 'host', ...p }));
  client.on('auth-failed', (p) => {
    stopNet(false);
    send('net:state', { state: 'error', detail: p.why });
  });
  client.on('message', ({ msg }) => send('net:signal', { peerId: 'host', msg }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 940,
    height: 800,
    minWidth: 720,
    minHeight: 560,
    title: 'SoundBridge',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    ...(TEST.windowX ? { x: Number(TEST.windowX), y: 40 } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });

  if (TEST.logConsole) {
    win.webContents.on('console-message', (event, level, message) => console.log(`[renderer] ${event.message ?? message}`));
  }
  if (TEST.screenshot) {
    setTimeout(async () => {
      try {
        const fs = require('fs');
        const base = TEST.screenshot.replace(/\.png$/i, '');
        fs.writeFileSync(`${base}-top.png`, (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('window.scrollTo(0, document.body.scrollHeight); true');
        await new Promise((r) => setTimeout(r, 300));
        fs.writeFileSync(`${base}-bottom.png`, (await win.webContents.capturePage()).toPNG());
        log(`screenshots saved to ${base}-top.png / -bottom.png`);
      } catch (err) { log(`screenshot failed: ${err.message}`); }
    }, TEST.screenshotAfter);
  }
  if (TEST.quitAfter) setTimeout(() => { stopNet(false); app.quit(); }, TEST.quitAfter);
}

app.whenReady().then(() => {
  store = new JsonStore(app.getPath('userData'));
  if (TEST.seed) store.write('settings', JSON.parse(TEST.seed));
  const ses = session.defaultSession;

  // getDisplayMedia() in the renderer becomes "capture what this PC is playing".
  // The video part is mandatory for Chromium; the renderer stops it immediately.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      callback({ video: sources[0], audio: loopbackMode });
    } catch (err) {
      log(`system audio capture failed: ${err.message}`);
      callback({});
    }
  }, { useSystemPicker: false });

  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
  ses.setPermissionCheckHandler(() => true);
  ses.setDevicePermissionHandler(() => true);

  createWindow();
});

app.on('window-all-closed', () => { stopNet(false); app.quit(); });

// ---------------------------------------------------------------- IPC

ipcMain.handle('info:get', () => ({
  hostname: TEST.hostname || os.hostname(),
  addresses: lanAddresses(),
  version: app.getVersion(),
  defaultPort: DEFAULT_PORT,
  userData: app.getPath('userData'),
  testTone: TEST.tone,
}));

ipcMain.handle('net:start', async (_e, opts) => {
  stopNet(false);
  const name = String(opts.displayName || TEST.hostname || os.hostname()).slice(0, 64);
  const port = Number(opts.port) || DEFAULT_PORT;
  try {
    if (opts.role === 'host') {
      const host = new SignalHost({ port, password: opts.password, name });
      wireHost(host);
      await host.start();
      net = { role: 'host', obj: host };
      send('net:state', { state: 'hosting', detail: `port ${port}` });
    } else {
      const client = new SignalClient({ address: String(opts.address || '').trim(), port, password: opts.password, name });
      wireClient(client);
      net = { role: 'join', obj: client };
      client.start();
    }
    return { ok: true };
  } catch (err) {
    stopNet(false);
    const error = err.code === 'EADDRINUSE' ? `port ${port} is already in use on this PC` : err.message;
    return { ok: false, error };
  }
});

ipcMain.handle('net:stop', () => { stopNet(true); return { ok: true }; });

ipcMain.on('net:send', (_e, { peerId, msg }) => {
  if (!net) return;
  if (net.role === 'host') net.obj.send(peerId, msg);
  else net.obj.send(msg);
});

ipcMain.on('capture:mode', (_e, mute) => { loopbackMode = mute ? 'loopbackWithMute' : 'loopback'; });

ipcMain.handle('store:get', (_e, name) => store.read(name, null));
ipcMain.handle('store:set', (_e, { name, value }) => { store.write(name, value); return true; });
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));
