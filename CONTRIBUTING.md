# Contributing to SoundBridge

Thanks for helping. This is a small project with a clear purpose: move audio between two
Windows PCs with as little fuss and latency as possible. Changes that keep it small and
obvious are the easiest to accept.

## Setting up

```powershell
git clone https://github.com/<you>/soundbridge
cd soundbridge
npm install          # Node 20+; Electron 39 is pinned (40+ needs Node 22 to install)
npm start
```

From a VS Code terminal, run `Remove-Item Env:ELECTRON_RUN_AS_NODE` first, otherwise
Electron starts as plain Node.

## Tests

| Command | What it checks |
|---|---|
| `npm test` | the signaling handshake: wrong password, right password, both directions, tampering, reconnect |
| `powershell -File scripts\test-e2e.ps1` | a real host + joiner on this PC with system-audio capture; screenshots and logs in `dist\e2e\` |

Run both before opening a pull request that touches `lib/` or `renderer/app.js`. The
end-to-end script needs a display and an audio output device, so it does not run in CI.

## Layout

```
main.js              Electron main: window, permissions, IPC, signaling lifecycle
preload.js           the window.sb bridge
lib/signaling.js     SignalHost / SignalClient (password auth + AES-GCM envelopes)
lib/store.js         atomic JSON file store
renderer/index.html  the page
renderer/style.css   the look
renderer/app.js      capture, Peer (WebRTC), playback, stats, settings, profiles, UI
scripts/pack.js      portable folder + zip
scripts/render-icon.js  assets/icon.svg -> assets/icon.png
scripts/test-*.      tests
assets/              icon
docs/                ARCHITECTURE.md, TROUBLESHOOTING.md
.github/workflows/   build.yml (every push), release.yml (v* tags)
```

`npm run dist` builds the installer locally (electron-builder downloads NSIS into its
cache on first run). Releases are cut by tagging, see the README.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains the protocol and the WebRTC
negotiation; read it before changing either.

## Ground rules

- **No frameworks, no build step.** Plain HTML/CSS/JS in the renderer, CommonJS in main.
  It keeps the app inspectable and the package small.
- **No native modules.** Everything must work with the stock, signed `electron.exe`.
- **Keep the main/renderer split.** Audio stays in the renderer, secrets and sockets stay
  in main.
- **Protocol changes bump `PROTOCOL`** in `lib/signaling.js`, and a host must reject
  older clients clearly.
- Prefer a log line the user can read over a silent fallback.

## Good first issues

- Tray icon with connection state, minimize to tray, start with Windows.
- Per-peer volume on the host.
- Let the sender choose which output device to capture (needs a native helper or a
  virtual cable; Chromium only captures the default device).
- TURN configuration in the UI.
- A tiny public rendezvous server so neither side needs a port forward.
- Linux/macOS capture (Chromium's loopback is Windows-only; PulseAudio monitors and
  BlackHole are the equivalents).

## Pull requests

One change per PR, a sentence on *why* in the description, and a note on how you tested
it (which of the two test commands, on how many machines). Update `CHANGELOG.md` under
*Unreleased*.
