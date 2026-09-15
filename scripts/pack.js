'use strict';
// Builds a portable folder you can copy to another Windows PC:
//   dist/SoundBridge/            <- Electron runtime, electron.exe left untouched (still code-signed)
//   dist/SoundBridge/resources/app/   <- this app
//   dist/SoundBridge-win-x64.zip
// No rebranding of the exe on purpose: a re-signed/modified exe is what Smart App Control blocks.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const target = path.join(dist, 'SoundBridge');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const pkg = require(path.join(root, 'package.json'));

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  console.error('node_modules/electron/dist/electron.exe not found. Run `npm install` first.');
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(electronDist, target, { recursive: true });
fs.rmSync(path.join(target, 'resources', 'default_app.asar'), { force: true });

const appDir = path.join(target, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
for (const item of ['main.js', 'preload.js', 'lib', 'renderer', 'assets', 'README.md', 'LICENSE']) {
  fs.cpSync(path.join(root, item), path.join(appDir, item), { recursive: true });
}
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, private: true,
}, null, 2));
// Runtime dependencies only (ws has none of its own).
for (const dep of Object.keys(pkg.dependencies || {})) {
  fs.cpSync(path.join(root, 'node_modules', dep), path.join(appDir, 'node_modules', dep), { recursive: true });
}

fs.writeFileSync(path.join(target, 'SoundBridge.cmd'), '@echo off\r\nstart "" "%~dp0electron.exe"\r\n');
fs.writeFileSync(path.join(target, 'README-first.txt'),
  `SoundBridge ${pkg.version}\r\n\r\nDouble-click SoundBridge.cmd (or electron.exe) to start.\r\n` +
  `Windows Firewall will ask once when you Host; allow it on private networks.\r\n` +
  `Settings and profiles are saved in %APPDATA%\\${pkg.name}\\.\r\n`);

const zip = path.join(dist, `SoundBridge-win-x64-${pkg.version}.zip`);
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') {
  // Windows 10+ ships bsdtar, which writes zips much faster than Compress-Archive.
  try {
    execFileSync('tar.exe', ['-a', '-c', '-f', zip, '-C', dist, 'SoundBridge'], { stdio: 'inherit' });
  } catch {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path '${target}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`], { stdio: 'inherit' });
  }
  console.log(`zip:    ${zip} (${(fs.statSync(zip).size / 1048576).toFixed(1)} MB)`);
}
console.log(`folder: ${target}`);
