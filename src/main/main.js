'use strict';
const { app, screen, powerMonitor } = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const settings = require('./settings');
  const windows = require('./windows');
  const tray = require('./tray');
  const ipc = require('./ipc');
  const feedStore = require('./feed/feedStore');

  let isQuitting = false;
  let hideTimer = null;

  const actions = {
    quit() {
      isQuitting = true;
      app.quit();
    },
    applyShowDuck() {
      const overlay = windows.getOverlay();
      if (settings.get('showDuck')) {
        if (hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = null;
        }
        if (overlay) overlay.show();
        else windows.createOverlayWindow();
      } else if (overlay) {
        overlay.hide();
      }
      tray.rebuildMenu();
    },
    toggleDuck() {
      settings.applyPatch({ showDuck: !settings.get('showDuck') });
      actions.applyShowDuck();
      windows.broadcast('settings:changed', settings.sanitized());
    },
    hideForOneHour() {
      const overlay = windows.getOverlay();
      if (overlay) overlay.hide();
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        const win = windows.getOverlay();
        if (win && settings.get('showDuck')) {
          win.show();
          win.webContents.send('duck:greet');
        }
      }, 60 * 60 * 1000);
    },
  };

  app.on('second-instance', () => {
    // Relaunching the app means "show me the duck" — go through the state
    // machine so the setting, tray label, and hide-for-an-hour timer agree.
    settings.applyPatch({ showDuck: true });
    actions.applyShowDuck();
    windows.broadcast('settings:changed', settings.sanitized());
  });

  // Tray app: closing windows never quits; only the Quit menu items do.
  app.on('window-all-closed', () => {});
  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.dock.hide();

    if (settings.get('showDuck')) windows.createOverlayWindow();
    tray.createTray({
      onToggleDuck: actions.toggleDuck,
      onCheckNow: () => feedStore.refresh({ manual: true }),
      onQuit: actions.quit,
    });
    ipc.register(actions);

    feedStore.subscribe((snap) => windows.broadcast('feed:state-changed', snap));
    feedStore.init();

    powerMonitor.on('resume', () => feedStore.refresh());
    const rescue = () => windows.ensureOnScreen();
    screen.on('display-added', rescue);
    screen.on('display-removed', rescue);
    screen.on('display-metrics-changed', rescue);
  });
}
