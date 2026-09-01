'use strict';
const fs = require('node:fs');
const { net } = require('electron');
const { DuckCryptoError } = require('../../../tools/duck-crypto');

const FETCH_TIMEOUT_MS = 10_000;

function parseEnvelopeText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new DuckCryptoError('MALFORMED_FILE', 'feed file is not valid JSON');
  }
}

// Returns { status: 'notModified' } | { status: 'ok', envelope, etag }
// Throws on network errors (plain Error) or malformed JSON (DuckCryptoError).
async function fetchEnvelope(feedUrl, lastEtag, { bustCache = false } = {}) {
  // Local paths / file:// URLs supported for development.
  if (/^file:/i.test(feedUrl)) {
    const { fileURLToPath } = require('node:url');
    return { status: 'ok', envelope: parseEnvelopeText(fs.readFileSync(fileURLToPath(feedUrl), 'utf8')), etag: '' };
  }
  if (/^[A-Za-z]:[\\/]/.test(feedUrl) || feedUrl.startsWith('./') || feedUrl.startsWith('/')) {
    return { status: 'ok', envelope: parseEnvelopeText(fs.readFileSync(feedUrl, 'utf8')), etag: '' };
  }

  let url = feedUrl;
  if (bustCache) {
    // raw.githubusercontent.com sits behind a ~5 min CDN cache; a unique query
    // string skips it for the manual "Check now" path.
    url += (url.includes('?') ? '&' : '?') + 't=' + Date.now();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {};
    if (lastEtag && !bustCache) headers['If-None-Match'] = lastEtag;
    const res = await net.fetch(url, { headers, cache: 'no-store', signal: controller.signal });
    if (res.status === 304) return { status: 'notModified' };
    if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`);
    const text = await res.text();
    return { status: 'ok', envelope: parseEnvelopeText(text), etag: res.headers.get('etag') || '' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchEnvelope };
