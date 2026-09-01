'use strict';
// Manual drag: the renderer reports mousedown/mouseup; main polls the real
// cursor position and moves the window with setBounds (never setPosition —
// frameless windows resize/drift under non-100% DPI scaling with it).
// drag:end returns { wasDrag } so the renderer can distinguish click vs drag
// with a 5 px movement threshold.

const { screen } = require('electron');
const windows = require('./windows');

const DRAG_THRESHOLD_PX = 5;
const TICK_MS = 16;
// Failsafe: if drag:end never arrives (mouse capture lost to a UAC prompt or
// session lock — the overlay is focusable:false so a renderer blur event can
// never fire), end the drag once the cursor has been still for this long.
const STUCK_IDLE_MS = 10_000;

let interval = null;
let startCursor = null;
let startBounds = null;
let maxDelta = 0;
let lastCursor = null;
let idleSinceTicks = 0;

function start() {
  const win = windows.getOverlay();
  if (!win || interval) return;
  windows.gestureBegin();
  startCursor = screen.getCursorScreenPoint();
  startBounds = win.getBounds();
  maxDelta = 0;
  lastCursor = startCursor;
  idleSinceTicks = 0;
  interval = setInterval(() => {
    const w = windows.getOverlay();
    if (!w) return end();
    const c = screen.getCursorScreenPoint();
    if (c.x === lastCursor.x && c.y === lastCursor.y) {
      idleSinceTicks += 1;
      if (idleSinceTicks * TICK_MS >= STUCK_IDLE_MS) return end();
    } else {
      idleSinceTicks = 0;
      lastCursor = c;
    }
    const dx = c.x - startCursor.x;
    const dy = c.y - startCursor.y;
    maxDelta = Math.max(maxDelta, Math.abs(dx), Math.abs(dy));
    // Don't move the window for sub-threshold hand jitter during a plain
    // click — a "click" must leave the duck exactly where it was.
    if (maxDelta > DRAG_THRESHOLD_PX) {
      w.setBounds({
        x: Math.round(startBounds.x + dx),
        y: Math.round(startBounds.y + dy),
        width: startBounds.width,
        height: startBounds.height,
      });
    }
  }, TICK_MS);
}

function end() {
  if (!interval) return { wasDrag: false };
  clearInterval(interval);
  interval = null;
  windows.gestureEnd();
  const wasDrag = maxDelta > DRAG_THRESHOLD_PX;
  if (wasDrag) windows.clampAndPersistPosition();
  return { wasDrag };
}

function isDragging() {
  return interval !== null;
}

module.exports = { start, end, isDragging };
