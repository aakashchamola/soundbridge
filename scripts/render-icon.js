'use strict';
// Renders assets/icon.svg to assets/icon.png (512x512, transparent) using Electron's
// own offscreen renderer, so no image tooling needs to be installed.
//   npx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, '..', 'assets', 'icon.svg');
const pngPath = path.join(__dirname, '..', 'assets', 'icon.png');
const SIZE = 512;

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: SIZE, height: SIZE, frame: false, transparent: true,
    webPreferences: { offscreen: true },
  });
  const svg = fs.readFileSync(svgPath, 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  fs.writeFileSync(pngPath, image.toPNG());
  const { width, height } = image.getSize();
  console.log(`wrote ${pngPath} (${width}x${height})`);
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
