# Troubleshooting

Start with the **Log** panel at the bottom of the window and the **Peers** card; nearly
every problem shows up in one of them.

## The window never appears (from a terminal)

You launched from a VS Code or other Electron-hosted terminal, which sets
`ELECTRON_RUN_AS_NODE=1`. That makes `electron.exe` behave like plain Node and the app
dies with `Cannot read properties of undefined (reading 'commandLine')`.

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE
npm start
```

## Joiner says "could not join (code 1006)" or "ECONNREFUSED", forever

The host is not reachable on that address and port.

1. On the host, is the status "Hosting on port …"? If not, click Start there first.
2. Same network? Compare the first three numbers of both IPs (e.g. `192.168.1.x`).
   Guest Wi-Fi networks and "AP isolation" block devices from seeing each other.
3. Windows Firewall on the host: when you clicked Start, Windows asked once whether to
   allow `electron.exe`. If you clicked Cancel, open *Windows Security → Firewall →
   Allow an app*, and allow Electron on **Private** networks. Also check that the host's
   network is set to *Private*, not *Public* (Settings → Network → your adapter).
4. From another network: the host's router must forward **TCP** port 47800 (or whatever
   you set) to the host PC, and you must enter the host's **public** address.
5. Try a different port if something else uses 47800 (the host log will say "already in
   use").

## "Wrong password"

The passwords differ, including case and spaces. Click *show* on both sides and compare.
The host log also records every rejected attempt with the caller's IP.

## Connected, but I hear nothing on the receiving PC

- Peers card: does it say *Receiving: system audio* with a bitrate? If it says
  *nothing*, the sender has not ticked **System audio** (or a microphone).
- Is the **Receiving** meter moving? If yes, audio arrives and the problem is local:
  check the *Output device* dropdown (click *refresh* if your headphones were plugged in
  after launch), the volume slider, and *Mute everything I receive*.
- Windows *Volume mixer* may have Electron turned down or muted. Search "volume mixer".
- Some headsets expose two outputs (e.g. "Headphones" and "Headset Earphone"); try the
  other one.

## Connected, but the sender's "Sending" meter stays flat

- Nothing is playing on the sender right now, or it is playing on a device that is not
  the Windows **default** output. Capture follows the default device at the moment you
  ticked System audio. Change the default device, then untick and re-tick System audio.
- Exclusive-mode apps (some games and ASIO/WASAPI-exclusive players) bypass the mixer
  and cannot be captured. Turn off "Allow applications to take exclusive control" in the
  device's *Properties → Advanced*.
- "Mute this PC's own speakers" mutes the sender's playback but still captures it. If
  you hear nothing locally but the meter moves, that is by design.

## Crackling, dropouts, or the buffer keeps growing

The Peers card shows *buffer NN ms*. Around 30 to 60 ms is normal on a quiet LAN; growing
past 150 ms means jitter.

- Prefer a cable or 5 GHz Wi-Fi on **both** machines. 2.4 GHz with other devices around
  is the usual culprit.
- Lower **Quality** on the sender (it applies live).
- Close things that saturate the sender's CPU; capture and encoding run on it.
- Bluetooth headphones add their own 100 to 200 ms on top; that is not SoundBridge.

## Media stuck at "connecting" or goes "failed" even though the peer joined

The signaling worked (TCP) but the audio path (UDP) cannot be established.

- On a LAN: a firewall is blocking UDP for Electron, or the two machines are on
  different VLANs. Allow Electron for Private networks on both sides.
- Across the internet: one side is behind symmetric or carrier-grade NAT, which STUN
  cannot punch through. You need a TURN relay: add
  `{ urls: 'turn:your.server:3478', username, credential }` to `ICE_SERVERS` in
  `renderer/app.js`. Coturn is free; it needs a server with a public IP.
- The log shows repeated "restarting ICE": the network changed (Wi-Fi roam, VPN
  toggled). It usually recovers within a few seconds.

## I hear an echo or a feedback loop

Both sides are sharing system audio to each other, so each hears the other's playback
of itself. Share system audio from one side only, or tick "Mute everything I receive"
on the side that only sends.

## "port … is already in use on this PC"

Another program (or a second SoundBridge) listens on that port. Pick another port on
both sides.

## `npm install` fails on Electron with "Cannot find native binding"

You are on Node 20 or 21 and the lockfile asked for Electron 40+, whose installer needs
Node 22.12. SoundBridge pins Electron 39 for that reason; run `npm install` again after
`git checkout package.json package-lock.json`, or upgrade Node.

## Everything worked yesterday and today nothing does

Device ids can change after a Windows update or a driver reinstall. SoundBridge falls
back to matching devices by name, but if your headphones were renamed, pick them again in
*Output device* and re-save the profile.

## Collecting a useful bug report

Run both sides with logging to a file, reproduce, and attach both logs:

```powershell
$env:SB_LOG_CONSOLE = '1'
npm start *> soundbridge.log
```

Include the Peers card numbers (bitrate, RTT, buffer, path) and whether the two machines
are on the same network.
