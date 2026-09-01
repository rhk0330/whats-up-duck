'use strict';
// Overlay + settings window management, the click-through state machine, and
// all bounds math. The overlay is ONE fixed-size transparent window sized to
// fit the duck (centered) plus a speech bubble on any side ("big canvas") —
// it is never resized at runtime except when the duck-size setting changes.

const path = require('node:path');
const { BrowserWindow, screen } = require('electron');
const settings = require('./settings');

const BUBBLE_MAX_W = 260;
const BUBBLE_MAX_H = 180;
const TAIL = 12;
const GAP = 16;
const EDGE_MARGIN = 24; // default duck distance from work-area corner
const WATCHDOG_PAD = 6; // px of slack around the hit rect

const DEBUG_OVERLAY = process.argv.includes('--debug-overlay');

let overlayWin = null;
let settingsWin = null;

let interactive = false;
let gestureCount = 0; // >0 while dragging or a native menu is open
let watchdogTimer = null;
let hitRect = null; // window-local {x,y,w,h} of duck+bubble, reported by renderer

function overlaySizeFor(duckSize) {
  return {
    width: duckSize + 2 * (BUBBLE_MAX_W + GAP),
    height: duckSize + 2 * (BUBBLE_MAX_H + TAIL + GAP),
  };
}

function defaultBounds(duckSize) {
  const { width, height } = overlaySizeFor(duckSize);
  const wa = screen.getPrimaryDisplay().workArea;
  // Duck (window center) sits at the bottom-right of the work area.
  const duckCenterX = wa.x + wa.width - EDGE_MARGIN - duckSize / 2;
  const duckCenterY = wa.y + wa.height - EDGE_MARGIN - duckSize / 2;
  return {
    x: Math.round(duckCenterX - width / 2),
    y: Math.round(duckCenterY - height / 2),
    width,
    height,
  };
}

function duckRectFor(bounds, duckSize) {
  return {
    x: bounds.x + Math.round((bounds.width - duckSize) / 2),
    y: bounds.y + Math.round((bounds.height - duckSize) / 2),
    width: duckSize,
    height: duckSize,
  };
}

function rectIntersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// The WINDOW may hang off-screen; only the DUCK rect must stay on a display.
function positionIsUsable(bounds, duckSize) {
  const duck = duckRectFor(bounds, duckSize);
  return screen.getAllDisplays().some((d) => rectIntersects(duck, d.workArea));
}

function createOverlayWindow() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  const duckSize = settings.get('duckSize');
  const { width, height } = overlaySizeFor(duckSize);

  let bounds = defaultBounds(duckSize);
  const saved = settings.get('position');
  if (saved && positionIsUsable({ ...saved, width, height }, duckSize)) {
    bounds = { x: saved.x, y: saved.y, width, height };
  }

  overlayWin = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false, // resizable + transparent is buggy on Windows
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // never steal focus from the user's apps
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep the duck animating while unfocused
    },
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));

  // ready-to-show is unreliable for transparent windows, so also reveal on
  // did-finish-load — whichever fires first.
  const reveal = () => {
    if (!overlayWin || overlayWin.isDestroyed() || overlayWin.isVisible()) return;
    overlayWin.showInactive();
    if (!DEBUG_OVERLAY) overlayWin.setIgnoreMouseEvents(true, { forward: true });
  };
  overlayWin.once('ready-to-show', reveal);
  overlayWin.webContents.once('did-finish-load', reveal);
  overlayWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`overlay failed to load: ${code} ${desc} ${url}`);
  });
  if (process.env.DUCK_DIAG) {
    setTimeout(() => {
      const w = getOverlay();
      console.log(
        '[diag]',
        JSON.stringify({
          visible: w && w.isVisible(),
          bounds: w && w.getBounds(),
          url: w && w.webContents.getURL(),
        }),
      );
    }, 4000);
  }

  overlayWin.on('closed', () => {
    overlayWin = null;
    stopWatchdog();
  });
  return overlayWin;
}

function getOverlay() {
  return overlayWin && !overlayWin.isDestroyed() ? overlayWin : null;
}

// ---- click-through state machine -----------------------------------------

function setInteractive(on) {
  const win = getOverlay();
  if (!win || DEBUG_OVERLAY) return;
  if (on === interactive) return;
  interactive = on;
  if (on) {
    win.setIgnoreMouseEvents(false);
    startWatchdog();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    stopWatchdog();
  }
}

function setHitRect(rect) {
  hitRect = rect && typeof rect.x === 'number' ? rect : null;
}

// Authoritative fallback for missed mouseleave events: while interactive,
// poll the real cursor; if it is outside the reported hit rect, force
// pass-through so the invisible window never blocks clicks.
function startWatchdog() {
  stopWatchdog();
  watchdogTimer = setInterval(() => {
    const win = getOverlay();
    if (!win || gestureCount > 0) return;
    const b = win.getBounds();
    const c = screen.getCursorScreenPoint();
    const lx = c.x - b.x;
    const ly = c.y - b.y;
    const r = hitRect;
    const inside =
      r &&
      lx >= r.x - WATCHDOG_PAD &&
      lx <= r.x + r.w + WATCHDOG_PAD &&
      ly >= r.y - WATCHDOG_PAD &&
      ly <= r.y + r.h + WATCHDOG_PAD;
    if (!inside) setInteractive(false);
  }, 100);
}

function stopWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

function gestureBegin() {
  gestureCount += 1;
}

function gestureEnd() {
  gestureCount = Math.max(0, gestureCount - 1);
}

// ---- bounds maintenance ----------------------------------------------------

// After a drag: keep the DUCK (not the whole window) inside the nearest
// display's work area, then persist.
function clampAndPersistPosition() {
  const win = getOverlay();
  if (!win) return;
  const duckSize = settings.get('duckSize');
  const b = win.getBounds();
  const duck = duckRectFor(b, duckSize);
  const display = screen.getDisplayMatching(duck);
  const wa = display.workArea;
  const clampedDuckX = Math.min(Math.max(duck.x, wa.x), wa.x + wa.width - duck.width);
  const clampedDuckY = Math.min(Math.max(duck.y, wa.y), wa.y + wa.height - duck.height);
  const next = {
    x: b.x + (clampedDuckX - duck.x),
    y: b.y + (clampedDuckY - duck.y),
    width: b.width,
    height: b.height,
  };
  if (next.x !== b.x || next.y !== b.y) win.setBounds(next);
  settings.set('position', { x: next.x, y: next.y });
}

// Duck-size setting changed: resize the window keeping the duck's screen
// center fixed. The one legitimate runtime resize.
function applyDuckSize() {
  const win = getOverlay();
  if (!win) return;
  const duckSize = settings.get('duckSize');
  const b = win.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const { width, height } = overlaySizeFor(duckSize);
  win.setBounds({
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
    width,
    height,
  });
  clampAndPersistPosition();
}

// Display added/removed/changed: rescue an off-screen duck.
function ensureOnScreen() {
  const win = getOverlay();
  if (!win) return;
  const duckSize = settings.get('duckSize');
  if (!positionIsUsable(win.getBounds(), duckSize)) {
    const b = defaultBounds(duckSize);
    win.setBounds(b);
    settings.set('position', { x: b.x, y: b.y });
  }
}

function getGeometry() {
  const win = getOverlay();
  const duckSize = settings.get('duckSize');
  if (!win) return { winBounds: null, workArea: null, duckSize };
  const winBounds = win.getBounds();
  const duck = duckRectFor(winBounds, duckSize);
  const workArea = screen.getDisplayMatching(duck).workArea;
  return { winBounds, workArea, duckSize };
}

// ---- settings window -------------------------------------------------------

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 660,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "What's Up Duck — Settings",
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  return settingsWin;
}

function getSettingsWindow() {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
}

function broadcast(channel, payload) {
  for (const win of [getOverlay(), getSettingsWindow()]) {
    if (win) win.webContents.send(channel, payload);
  }
}

module.exports = {
  DEBUG_OVERLAY,
  BUBBLE_MAX_W,
  BUBBLE_MAX_H,
  TAIL,
  GAP,
  createOverlayWindow,
  getOverlay,
  setInteractive,
  setHitRect,
  gestureBegin,
  gestureEnd,
  clampAndPersistPosition,
  applyDuckSize,
  ensureOnScreen,
  getGeometry,
  createSettingsWindow,
  getSettingsWindow,
  broadcast,
};
