'use strict';
const path = require('node:path');
const { app, Tray, Menu, nativeImage } = require('electron');
const settings = require('./settings');
const windows = require('./windows');

let tray = null;
let handlers = null; // { onToggleDuck, onCheckNow, onQuit }

function trayIcon() {
  const base = path.join(app.getAppPath(), 'build');
  if (process.platform === 'darwin') {
    const img = nativeImage.createFromPath(path.join(base, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(path.join(base, 'tray.png'));
}

function rebuildMenu() {
  if (!tray) return;
  const showDuck = settings.get('showDuck');
  const menu = Menu.buildFromTemplate([
    {
      label: showDuck ? 'Hide duck' : 'Show duck',
      click: () => handlers.onToggleDuck(),
    },
    { label: 'Check for new messages now', click: () => handlers.onCheckNow() },
    { label: 'Settings…', click: () => windows.createSettingsWindow() },
    {
      label: 'Start at login',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => settings.applyPatch({ launchAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Quit', click: () => handlers.onQuit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray(h) {
  handlers = h;
  tray = new Tray(trayIcon());
  tray.setToolTip("What's Up Duck");
  rebuildMenu();
  if (process.platform !== 'darwin') {
    tray.on('click', () => handlers.onToggleDuck());
  }
  return tray;
}

module.exports = { createTray, rebuildMenu };
