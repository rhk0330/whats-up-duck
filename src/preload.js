'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Named functions only — no generic ipcRenderer passthrough.
contextBridge.exposeInMainWorld('duck', {
  // overlay interactivity / gestures
  setInteractive: (on) => ipcRenderer.send('overlay:set-interactive', on),
  setHitRect: (rect) => ipcRenderer.send('overlay:hit-rect', rect),
  dragStart: () => ipcRenderer.send('drag:start'),
  dragEnd: () => ipcRenderer.invoke('drag:end'),
  showContextMenu: () => ipcRenderer.send('duck:context-menu'),
  getGeometry: () => ipcRenderer.invoke('overlay:get-geometry'),

  // feed
  nextMessage: () => ipcRenderer.invoke('feed:next-message'),
  getFeedState: () => ipcRenderer.invoke('feed:get-state'),
  refreshNow: () => ipcRenderer.invoke('feed:refresh-now'),
  testConnection: (opts) => ipcRenderer.invoke('feed:test', opts),

  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  openSettings: () => ipcRenderer.send('settings:open'),
  quit: () => ipcRenderer.send('app:quit'),

  // events (main -> renderer)
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onFeedState: (cb) => ipcRenderer.on('feed:state-changed', (_e, s) => cb(s)),
  onGreet: (cb) => ipcRenderer.on('duck:greet', () => cb()),
  onTogglePause: (cb) => ipcRenderer.on('duck:toggle-pause', () => cb()),
});
