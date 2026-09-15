# Changelog

All notable changes to SoundBridge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0] - 2026-09-16

First release.

### Added
- Host / Join modes with a password-protected WebSocket signaling channel
  (PBKDF2 + AES-256-GCM, mutual authentication, replay protection).
- System-audio capture on Windows (WASAPI loopback via Chromium), with an option to mute
  the sender's own speakers while sharing.
- Microphone sharing from any input device.
- WebRTC transport: Opus stereo, selectable quality 64 to 510 kb/s, 10 ms packets,
  in-band FEC, DTLS-SRTP, STUN, automatic ICE restart.
- Playback to any output device with volume and mute; per-stream labels
  (system audio / microphone).
- Live per-peer stats: bitrate, RTT, jitter-buffer delay, link path.
- Profiles that remember role, address, password, devices and quality;
  "Start automatically when SoundBridge opens".
- Automatic reconnection on the joiner with backoff.
- Portable packaging (`npm run pack`) that keeps the stock signed `electron.exe`.
- Signaling test suite and a one-machine end-to-end test with screenshots.

[Unreleased]: https://github.com/aakashchamola/soundbridge/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aakashchamola/soundbridge/releases/tag/v0.1.0
