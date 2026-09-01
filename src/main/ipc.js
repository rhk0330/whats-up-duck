'use strict';
// Every ipcMain registration lives here — single source of truth for the
// channel list. `actions` is provided by main.js (app-level behaviors).

const { ipcMain, Menu } = require('electron');
const settings = require('./settings');
const windows = require('./windows');
const drag = require('./drag');
const feedStore = require('./feed/feedStore');
const tray = require('./tray');

function register(actions) {
  // ---- overlay interactivity / gestures ----
  ipcMain.on('overlay:set-interactive', (_e, on) => windows.setInteractive(!!on));
  ipcMain.on('overlay:hit-rect', (_e, rect) => windows.setHitRect(rect));
  ipcMain.on('drag:start', () => drag.start());
  ipcMain.handle('drag:end', () => drag.end());
  ipcMain.handle('overlay:get-geometry', () => windows.getGeometry());

  ipcMain.on('duck:context-menu', () => {
    const overlay = windows.getOverlay();
    if (!overlay) return;
    windows.gestureBegin();
    const menu = Menu.buildFromTemplate([
      { label: 'Check for new messages now', click: () => feedStore.refresh({ manual: true }) },
      { label: 'Settings…', click: () => windows.createSettingsWindow() },
      { label: 'Hide for 1 hour', click: () => actions.hideForOneHour() },
      { type: 'separator' },
      { label: 'Quit', click: () => actions.quit() },
    ]);
    menu.popup({ window: overlay, callback: () => windows.gestureEnd() });
  });

  // ---- feed ----
  ipcMain.handle('feed:next-message', () => feedStore.nextMessage());
  ipcMain.handle('feed:get-state', () => feedStore.snapshot());
  ipcMain.handle('feed:refresh-now', () => feedStore.refresh({ manual: true }));
  ipcMain.handle('feed:test', (_e, opts) =>
    feedStore.testConnection({
      password: typeof opts?.password === 'string' ? opts.password : undefined,
      feedUrl: typeof opts?.feedUrl === 'string' ? opts.feedUrl : undefined,
    }),
  );

  // ---- settings ----
  ipcMain.handle('settings:get', () => settings.sanitized());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const changed = settings.applyPatch(patch);
    if (changed.includes('duckSize')) windows.applyDuckSize();
    if (changed.includes('pollIntervalMinutes')) feedStore.schedulePolling();
    if (changed.includes('showDuck')) actions.applyShowDuck();
    if (changed.includes('launchAtLogin')) tray.rebuildMenu();
    if (changed.includes('password')) {
      feedStore.invalidate();
      settings.set('lastEtag', ''); // force a real re-fetch with the new password
      settings.set('lastGoodSalt', '');
      if (settings.hasPassword()) await feedStore.refresh({ manual: true });
    } else if (changed.includes('feedUrl')) {
      settings.set('lastGoodSalt', '');
      await feedStore.refresh({ manual: true });
    }
    const snap = settings.sanitized();
    windows.broadcast('settings:changed', snap);
    return snap;
  });

  ipcMain.on('settings:open', () => windows.createSettingsWindow());
  ipcMain.on('app:quit', () => actions.quit());
}

module.exports = { register };
