'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
};

contextBridge.exposeInMainWorld('sb', {
  getInfo: () => ipcRenderer.invoke('info:get'),
  start: (opts) => ipcRenderer.invoke('net:start', opts),
  stop: () => ipcRenderer.invoke('net:stop'),
  sendSignal: (peerId, msg) => ipcRenderer.send('net:send', { peerId, msg }),
  setCaptureMute: (mute) => ipcRenderer.send('capture:mode', !!mute),
  storeGet: (name) => ipcRenderer.invoke('store:get', name),
  storeSet: (name, value) => ipcRenderer.invoke('store:set', { name, value }),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  onState: listen('net:state'),
  onPeer: listen('net:peer'),
  onSignal: listen('net:signal'),
  onLog: listen('log'),
});
