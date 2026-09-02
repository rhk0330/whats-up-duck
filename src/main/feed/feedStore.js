'use strict';
// Owns the decrypted message list, seen-state, poll timer, and feed status
// state machine. Decryption happens ONLY here (main process); renderers get
// individual messages over IPC.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const duckCrypto = require('../../../tools/duck-crypto');
const settings = require('../settings');
const { fetchEnvelope } = require('./fetcher');

// status: NO_PASSWORD | READY | FETCHING | OFFLINE | AUTH_FAILED |
//         PASSWORD_ROTATED | FEED_ERROR
let status = 'NO_PASSWORD';
let messages = [];
let lastCheckedAt = null;
let consecutiveAuthFailures = 0;
let keyCache = null; // { saltB64, key } — skip scrypt when the salt is unchanged
let pollTimer = null;
const listeners = new Set();

function cachePath() {
  return path.join(app.getPath('userData'), 'feed-cache.json');
}

function snapshot() {
  return {
    status,
    unseenCount: unseenList().length,
    messageCount: messages.length,
    lastCheckedAt,
    hasPassword: settings.hasPassword(),
  };
}

function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  const snap = snapshot();
  for (const cb of listeners) cb(snap);
}

function unseenList() {
  const seen = new Set(settings.get('seenIds'));
  return messages.filter((m) => !seen.has(m.id));
}

async function decryptEnvelope(envelope, password) {
  const v = duckCrypto.validateEnvelope(envelope);
  let key;
  if (keyCache && keyCache.saltB64 === envelope.salt) {
    key = keyCache.key;
  } else {
    key = await duckCrypto.deriveKeyAsync(password, v.salt, v.kdfParams);
  }
  const payload = duckCrypto.decryptWithKey(key, envelope);
  keyCache = { saltB64: envelope.salt, key };
  return payload;
}

function applyPayload(payload, envelope, etag) {
  messages = payload.messages;
  cursor = 0; // fresh content: next click starts from the newest message

  // Prune seenIds to ids that still exist — removed messages self-clean.
  const feedIds = new Set(messages.map((m) => m.id));
  const seenIds = settings.get('seenIds').filter((id) => feedIds.has(id));
  settings.set('seenIds', seenIds);

  if (etag) settings.set('lastEtag', etag);
  settings.set('lastGoodSalt', envelope.salt);
  consecutiveAuthFailures = 0;
  status = 'READY';

  try {
    fs.writeFileSync(
      cachePath(),
      JSON.stringify({ fetchedAt: new Date().toISOString(), envelope }),
    );
  } catch {
    // Cache is best-effort; polling still works without it.
  }
}

// Load the last successfully-fetched envelope from disk (offline support).
// Only ciphertext is ever at rest.
async function loadFromCache() {
  const password = settings.getPassword();
  if (!password) {
    status = 'NO_PASSWORD';
    return;
  }
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    const payload = await decryptEnvelope(cached.envelope, password);
    messages = payload.messages;
    status = 'READY';
  } catch {
    // No cache / stale password — the first refresh will sort it out.
  }
}

async function refresh({ manual = false } = {}) {
  const password = settings.getPassword();
  if (!password) {
    status = 'NO_PASSWORD';
    emit();
    return snapshot();
  }

  status = 'FETCHING';
  emit();

  let result;
  try {
    // Only send If-None-Match when we actually hold decrypted messages —
    // otherwise a 304 would leave the app "READY" with an empty list forever
    // (e.g. persisted etag + lost/undecryptable cache file).
    const etag = messages.length > 0 ? settings.get('lastEtag') : '';
    result = await fetchEnvelope(settings.get('feedUrl'), etag, {
      bustCache: manual,
    });
  } catch (err) {
    status = err.code === 'MALFORMED_FILE' ? 'FEED_ERROR' : 'OFFLINE';
    lastCheckedAt = new Date().toISOString();
    emit();
    return snapshot();
  }

  lastCheckedAt = new Date().toISOString();

  if (result.status === 'notModified') {
    status = 'READY';
    emit();
    return snapshot();
  }

  try {
    const payload = await decryptEnvelope(result.envelope, password);
    applyPayload(payload, result.envelope, result.etag);
  } catch (err) {
    if (err.code === 'AUTH_FAILED') {
      const lastGoodSalt = settings.get('lastGoodSalt');
      if (!lastGoodSalt) {
        status = 'AUTH_FAILED'; // never worked — wrong password at setup
      } else if (result.envelope.salt !== lastGoodSalt) {
        status = 'PASSWORD_ROTATED'; // file re-encrypted since it last worked
      } else {
        // Same file that used to decrypt now fails — transient weirdness.
        consecutiveAuthFailures += 1;
        if (consecutiveAuthFailures >= 3) status = 'FEED_ERROR';
        else status = messages.length ? 'READY' : 'FEED_ERROR';
      }
    } else {
      status = 'FEED_ERROR';
    }
  }
  emit();
  return snapshot();
}

// ONE list, one message shown at a time: clicks walk it newest-first and wrap
// around. New arrivals reset the cursor so they show first. Showing a message
// marks it seen.
let cursor = 0;

function nextMessage() {
  if (messages.length === 0) return null;
  const ordered = [...messages].reverse(); // newest first
  if (cursor >= ordered.length) cursor = 0;
  const m = ordered[cursor];
  cursor = (cursor + 1) % ordered.length;
  const seen = settings.get('seenIds');
  if (!seen.includes(m.id)) {
    settings.set('seenIds', [...seen, m.id]);
    emit();
  }
  return { message: m };
}

// Try a candidate password (and optionally URL) WITHOUT persisting anything.
async function testConnection({ password, feedUrl } = {}) {
  const pw = password || settings.getPassword();
  if (!pw) return { ok: false, errorCode: 'NO_PASSWORD', errorMessage: 'No password entered.' };
  let result;
  try {
    result = await fetchEnvelope(feedUrl || settings.get('feedUrl'), '', { bustCache: true });
  } catch (err) {
    if (err.code === 'MALFORMED_FILE') {
      return { ok: false, errorCode: 'FEED_ERROR', errorMessage: 'Feed file is malformed.' };
    }
    return { ok: false, errorCode: 'OFFLINE', errorMessage: `Can't reach the feed (${err.message}).` };
  }
  try {
    const payload = await duckCrypto.decryptFeedAsync(pw, result.envelope);
    return { ok: true, messageCount: payload.messages.length };
  } catch (err) {
    if (err.code === 'AUTH_FAILED') {
      return { ok: false, errorCode: 'AUTH_FAILED', errorMessage: 'Wrong password (could not decrypt).' };
    }
    return { ok: false, errorCode: err.code || 'FEED_ERROR', errorMessage: err.message };
  }
}

function schedulePolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  const mins = settings.get('pollIntervalMinutes');
  if (!mins) return; // manual only
  pollTimer = setTimeout(async () => {
    try {
      await refresh();
    } finally {
      schedulePolling();
    }
  }, mins * 60_000);
}

// Called on password change/clear so stale plaintext doesn't linger.
function invalidate() {
  keyCache = null;
  consecutiveAuthFailures = 0;
  if (!settings.hasPassword()) {
    messages = [];
    status = 'NO_PASSWORD';
    emit();
  }
}

async function init() {
  await loadFromCache();
  emit();
  await refresh();
  schedulePolling();
}

module.exports = { init, refresh, nextMessage, testConnection, snapshot, subscribe, schedulePolling, invalidate };
