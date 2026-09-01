'use strict';
const Store = require('electron-store');
const { safeStorage, app } = require('electron');

const DEFAULT_FEED_URL =
  'https://raw.githubusercontent.com/rhk0330/whats-up-duck/main/feed/messages.enc.json';

const DEFAULTS = {
  animationSpeed: 1.0, // 0.5–2 multiplier
  duckSize: 140, // px, 75–200
  pollIntervalMinutes: 15, // 0 = manual only
  feedUrl: DEFAULT_FEED_URL,
  password: { storage: 'none', value: '' },
  bubbleDismissSeconds: 20, // 0 = never
  position: null, // {x,y} overlay window top-left
  launchAtLogin: false,
  showDuck: true,
  seenIds: [],
  cycleCursor: 0,
  lastEtag: '',
  lastGoodSalt: '',
  firstRunComplete: false,
};

const store = new Store({ defaults: DEFAULTS });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function get(key) {
  return store.get(key);
}

function set(key, value) {
  store.set(key, value);
}

function hasPassword() {
  const p = store.get('password');
  return !!(p && p.storage !== 'none' && p.value);
}

function setPassword(plain) {
  if (!plain) {
    store.set('password', { storage: 'none', value: '' });
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('password', {
      storage: 'safeStorage',
      value: safeStorage.encryptString(plain).toString('base64'),
    });
  } else {
    // Protection-at-rest unavailable (rare); documented fallback.
    store.set('password', { storage: 'plaintext', value: plain });
  }
}

function getPassword() {
  const p = store.get('password');
  if (!p || !p.value || p.storage === 'none') return null;
  if (p.storage === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(p.value, 'base64'));
    } catch {
      // OS key changed (profile migration etc.) — the blob is unrecoverable.
      // Clear it so hasPassword() agrees and the UI asks for the password again.
      store.set('password', { storage: 'none', value: '' });
      return null;
    }
  }
  return p.value;
}

// Everything the renderers are allowed to see (never the password value).
function sanitized() {
  const s = { ...store.store };
  delete s.password;
  s.hasPassword = hasPassword();
  // Report the real OS login-item state, not the stored flag — the user can
  // disable startup via Task Manager / System Settings behind our back.
  try {
    s.launchAtLogin = app.getLoginItemSettings().openAtLogin;
  } catch {
    // keep stored value
  }
  return s;
}

// Apply a settings patch from the settings window. Returns list of changed keys.
function applyPatch(patch) {
  const changed = [];
  if (typeof patch !== 'object' || patch === null) return changed;

  if (typeof patch.password === 'string') {
    setPassword(patch.password);
    changed.push('password');
  }
  if (typeof patch.animationSpeed === 'number' && Number.isFinite(patch.animationSpeed)) {
    store.set('animationSpeed', clamp(patch.animationSpeed, 0.25, 3));
    changed.push('animationSpeed');
  }
  if (typeof patch.duckSize === 'number' && Number.isFinite(patch.duckSize)) {
    store.set('duckSize', Math.round(clamp(patch.duckSize, 75, 200)));
    changed.push('duckSize');
  }
  if (typeof patch.pollIntervalMinutes === 'number' && Number.isFinite(patch.pollIntervalMinutes)) {
    const v = Math.round(patch.pollIntervalMinutes);
    store.set('pollIntervalMinutes', v === 0 ? 0 : clamp(v, 5, 1440));
    changed.push('pollIntervalMinutes');
  }
  if (typeof patch.feedUrl === 'string' && patch.feedUrl.trim() && patch.feedUrl.trim() !== store.get('feedUrl')) {
    // Only a REAL change may reach here — the changed list wipes etag and
    // rotation state downstream.
    store.set('feedUrl', patch.feedUrl.trim());
    store.set('lastEtag', '');
    changed.push('feedUrl');
  }
  if (typeof patch.bubbleDismissSeconds === 'number' && Number.isFinite(patch.bubbleDismissSeconds)) {
    store.set('bubbleDismissSeconds', Math.round(clamp(patch.bubbleDismissSeconds, 0, 120)));
    changed.push('bubbleDismissSeconds');
  }
  if (typeof patch.launchAtLogin === 'boolean') {
    store.set('launchAtLogin', patch.launchAtLogin);
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
    changed.push('launchAtLogin');
  }
  if (typeof patch.showDuck === 'boolean') {
    store.set('showDuck', patch.showDuck);
    changed.push('showDuck');
  }
  if (typeof patch.firstRunComplete === 'boolean') {
    store.set('firstRunComplete', patch.firstRunComplete);
    changed.push('firstRunComplete');
  }
  return changed;
}

module.exports = { DEFAULTS, get, set, hasPassword, setPassword, getPassword, sanitized, applyPatch };
