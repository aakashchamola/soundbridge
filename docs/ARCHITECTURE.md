# SoundBridge architecture

This document explains how the pieces fit, what crosses the network, and why the
design looks the way it does. Read it before changing `lib/signaling.js` or the
`Peer` class in `renderer/app.js`.

## The big picture

```
┌─────────────────────────── Host PC ───────────────────────────┐
│  main process                       renderer (Chromium)       │
│  ┌────────────────────┐   IPC       ┌──────────────────────┐  │
│  │ SignalHost (ws)    │◄──────────► │ Peer (RTCPeerConn.)  │  │
│  │ password, AES-GCM  │  sdp / ice  │ ontrack → <audio>    │  │
│  │ store (JSON)       │             │   .setSinkId(earph.) │  │
│  └─────────▲──────────┘             └──────────▲───────────┘  │
└────────────┼───────────────────────────────────┼──────────────┘
             │ TCP :47800  (signaling only)      │ UDP  (Opus / SRTP, via ICE)
┌────────────┼───────────────────────────────────┼──────────────┐
│  ┌─────────▼──────────┐             ┌──────────▼───────────┐  │
│  │ SignalClient (ws)  │◄──────────► │ Peer (RTCPeerConn.)  │  │
│  │ retries, AES-GCM   │  sdp / ice  │ getDisplayMedia() ──►│  │
│  └────────────────────┘             │   loopback capture   │  │
│  main process                       └──────────────────────┘  │
└────────────────────────── Joiner (laptop) ────────────────────┘
```

Two processes per instance, as in every Electron app:

| Process | Owns | Never touches |
|---|---|---|
| **main** (`main.js`, `lib/`) | window, WebSocket signaling, password crypto, settings/profile files, the display-media permission that turns `getDisplayMedia()` into "capture what this PC plays" | audio samples |
| **renderer** (`renderer/`) | device lists, capture, `RTCPeerConnection` per peer, playback elements, level meters, stats, all UI | the password after handing it to main, the network socket |

They talk through the small `window.sb` bridge in `preload.js` (context isolation on,
node integration off). Signals are addressed by an opaque peer id; the renderer never
sees a socket.

## Signaling protocol (`lib/signaling.js`)

Purpose: get SDP offers/answers and ICE candidates between two machines that share a
password, and nothing else. Transport is a plain WebSocket (`ws://host:port`). TLS is
not used because the payload is already encrypted end to end with a key only the two
sides can derive.

```
Host                                              Joiner
 │  {t:'hello', v:1, salt, nonce}  (plaintext)      │
 │ ───────────────────────────────────────────────► │
 │                                                  │ base = PBKDF2-SHA256(password, salt, 150k)
 │                                                  │ encKey = HMAC(base, "soundbridge-enc-v1")
 │                                                  │ connKey = HMAC(encKey, nonce)
 │  envelope{t:'hi', name, nonce}                    │
 │ ◄─────────────────────────────────────────────── │
 │ decrypts? nonce echoes? → joined                 │
 │  envelope{t:'hi', name}                           │
 │ ───────────────────────────────────────────────► │
 │                                                  │ decrypts? → host knew the password too
 │  envelope{t:'sig', msg}      (both directions)   │
 │ ◄══════════════════════════════════════════════► │
 │  envelope{t:'bye'}                                │
```

- **Envelope** = `{t:'e', iv, d}` where `d` is AES-256-GCM ciphertext + 16-byte tag,
  `iv` is 12 random bytes, and the plaintext JSON carries a `seq` that must strictly
  increase. Any tampering, wrong key, or replay throws and the socket is closed.
- The **salt** is per host session (derived once, so a flood of connections cannot make
  the host burn PBKDF2 CPU); the **nonce** is per connection, and the connection key is
  bound to it, so nothing recorded from one connection can be replayed into another.
- **Mutual authentication** falls out of GCM: the joiner proves the password by producing
  a decryptable `hi`; the host proves it by answering with one.
- Wrong password: the host waits one second, then closes with code **4001**. The client
  stops retrying on 4001. Protocol errors use **4002**.
- Only 8 connections may sit in the unauthenticated state at once; each has 10 s to
  finish the handshake.
- The joiner reconnects on any other failure with a 2 s → 15 s backoff (×1.5).

Messages after the handshake are `{t:'sig', msg}` where `msg` is whatever the renderer
put in: `{t:'sdp', description}`, `{t:'ice', candidate}` or `{t:'meta', mids}`.

## WebRTC session (`Peer` in `renderer/app.js`)

One `RTCPeerConnection` per remote peer. The host is the **polite** peer, joiners are
**impolite**, and the code follows the standard *perfect negotiation* pattern so either
side can add or remove tracks at any time (toggling "System audio", changing the mic,
changing Quality, ICE restarts) without a coordinator.

Deviations from the textbook version:

- Offers and answers are created explicitly (not `setLocalDescription()` with no
  argument) because the SDP is edited first. `tuneSdp()` rewrites the Opus `fmtp` line to
  `stereo=1;sprop-stereo=1;maxaveragebitrate=<quality>;usedtx=0;useinbandfec=1;
  minptime=10` and adds `a=ptime:10`. Both local and remote descriptions get the same
  treatment, so each side's encoder follows that side's Quality setting.
- Track identity is signaled out of band. WebRTC does not carry "this is the system
  audio", so after every `setLocalDescription` the sender posts `{t:'meta', mids}`
  mapping transceiver `mid` → `system | mic`. The receiver uses it to label streams.
- After every remote description is applied, `pruneInactive()` stops playing any track
  whose transceiver is no longer sending towards us (that is how "untick System audio"
  reaches the other side).
- `receiver.playoutDelayHint = 0` and `jitterBufferTarget = 0` ask NetEq for its minimum
  buffer. It still adapts upward under jitter; the Peers card shows the live value.
- Signals for a peer are processed strictly in order through a per-peer promise queue.
- `connectionState` "failed" restarts ICE immediately; "disconnected" restarts it after
  4 s if it has not recovered.
- ICE uses two public STUN servers. Local IPs are not hidden behind mDNS names
  (`WebRtcHideLocalIpsWithMdns` is disabled) so same-network connections go direct.
  There is no TURN server; see `ICE_SERVERS` if you have one.

## Capture

- **System audio**: `navigator.mediaDevices.getDisplayMedia({video: true, audio: …})`.
  Chromium insists on a video track, so main's `setDisplayMediaRequestHandler` hands
  back the primary screen plus `audio: 'loopback'` (or `'loopbackWithMute'` when "Mute
  this PC's own speakers" is ticked), and the renderer stops the video track at once.
  Windows-only, by Chromium's implementation. It captures whatever the **default** render
  device is at the moment capture starts. Echo cancellation, noise suppression and AGC
  are turned off and `contentHint = 'music'`.
- **Microphone**: `getUserMedia` with the chosen `deviceId`, processing left on,
  `contentHint = 'speech'`.
- Local streams are captured once and attached to every peer. Re-capture (needed when the
  mute option changes) uses `replaceTrack`, so no renegotiation.

## Playback

Each received track gets its own `<audio>` element (never inserted into the DOM) with
`srcObject`, routed with `setSinkId(outputId)`, and driven by the shared volume/mute.
Meters use a `MediaStreamAudioSourceNode` into an `AnalyserNode`; nothing is connected to
the AudioContext destination, so meters never double-play audio.

## Stats

Every second `getStats()` is read per peer: inbound/outbound `bytes*` for bitrate,
`jitterBufferDelay / jitterBufferEmittedCount` deltas for buffer delay, and the selected
candidate pair for RTT and path type (host→host = "same network", srflx = "over
internet", relay = "relayed").

## Storage

`%APPDATA%\soundbridge\` (or `SB_USER_DATA`), written atomically via temp file + rename:

- `settings.json`: the last-used form state, including `password`, device ids and labels
  (labels are the fallback when Chromium's per-origin device ids change), `quality`,
  `autoConnect`.
- `profiles.json`: an array of the same shape plus `name`.

Passwords are stored in plain text on purpose: they are wifi-style shared secrets, the
folder is per Windows user, and encrypting them with a key on the same disk would add
nothing.

## Test hooks (environment variables)

| Variable | Effect |
|---|---|
| `SB_USER_DATA` | settings folder for this instance |
| `SB_SEED_SETTINGS` | JSON written to `settings.json` before the window opens |
| `SB_TONE=1` | renderer plays a quiet 440 Hz tone so system-audio capture has input |
| `SB_SCREENSHOT` / `SB_SCREENSHOT_AFTER` | save `<name>-top.png` and `<name>-bottom.png` after N ms |
| `SB_QUIT_AFTER` | quit after N ms |
| `SB_WINDOW_X` | window x position (two instances side by side) |
| `SB_LOG_CONSOLE=1` | echo the app log and renderer console to stdout |
| `SB_HOSTNAME` | display-name override for screenshots |

`scripts/test-e2e.ps1` combines them into a host + joiner run on one machine.

## Packaging

`scripts/pack.js` copies the stock Electron runtime, removes `default_app.asar`, drops
this app into `resources/app`, copies runtime dependencies (`ws`), and zips the folder
with Windows' built-in `tar`. `electron.exe` is neither renamed nor re-stamped with an
icon: doing so breaks its Authenticode signature, and an unsigned binary is exactly what
Smart App Control and SmartScreen block on other people's machines.

## Threat model

Protected:
- Eavesdroppers on either network learn nothing about the password (PBKDF2 + GCM, no
  password on the wire) and cannot read, forge or replay signaling.
- Audio is DTLS-SRTP; the fingerprints travel inside the encrypted signaling, so a
  network attacker cannot substitute their own endpoint.
- Online guessing is slowed (1 s per failure, 8 pending handshakes max).

Not protected:
- Anyone with the password. Choose a real one when the host port is exposed to the
  internet.
- Denial of service against the host port (it is a plain TCP listener).
- Anything on the machines themselves: the password sits in `settings.json`, and the
  system-audio capture is only as private as the sender's desktop.
