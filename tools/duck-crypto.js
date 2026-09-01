'use strict';
// Shared crypto for the What's Up Duck feed. Used by BOTH the authoring CLI
// (tools/duck.js) and the Electron main process — parameters must never drift.

const crypto = require('node:crypto');

const FORMAT = 'whats-up-duck-feed';
const VERSION = 1;
const AAD = Buffer.from(`${FORMAT}:v${VERSION}`, 'utf8');

const KDF_PARAMS = { N: 131072, r: 8, p: 1 }; // scrypt, ~128 MB per derivation
// Node's default scrypt maxmem is 32 MiB; these params need 128*N*r ≈ 134 MB.
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

class DuckCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DuckCryptoError';
    this.code = code; // MALFORMED_FILE | AUTH_FAILED | UNSUPPORTED_VERSION
  }
}

function malformed(message) {
  return new DuckCryptoError('MALFORMED_FILE', message);
}

function b64(buf) {
  return buf.toString('base64');
}

function decodeB64(value, expectedLen, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw malformed(`field "${field}" is not valid base64`);
  }
  const buf = Buffer.from(value, 'base64');
  if (expectedLen !== null && buf.length !== expectedLen) {
    throw malformed(`field "${field}" has length ${buf.length}, expected ${expectedLen}`);
  }
  if (expectedLen === null && buf.length === 0) {
    throw malformed(`field "${field}" is empty`);
  }
  return buf;
}

function validateKdfParams(params) {
  if (typeof params !== 'object' || params === null) throw malformed('missing kdfParams');
  const { N, r, p } = params;
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 21 || (N & (N - 1)) !== 0) {
    throw malformed('kdfParams.N out of bounds');
  }
  if (!Number.isInteger(r) || r < 1 || r > 16) throw malformed('kdfParams.r out of bounds');
  if (!Number.isInteger(p) || p < 1 || p > 4) throw malformed('kdfParams.p out of bounds');
  if (128 * N * r > SCRYPT_MAXMEM) throw malformed('kdfParams exceed memory bound');
  return { N, r, p };
}

// Throws DuckCryptoError on any structural problem; returns decoded buffers.
function validateEnvelope(env) {
  if (typeof env !== 'object' || env === null) throw malformed('envelope is not an object');
  if (env.format !== FORMAT) throw malformed('unrecognized format marker');
  if (!Number.isInteger(env.version)) throw malformed('missing version');
  if (env.version > VERSION) {
    throw new DuckCryptoError('UNSUPPORTED_VERSION', `feed version ${env.version} is newer than this app understands`);
  }
  if (env.version < 1) throw malformed('bad version');
  if (env.kdf !== 'scrypt') throw malformed(`unsupported kdf "${env.kdf}"`);
  const kdfParams = validateKdfParams(env.kdfParams);
  return {
    kdfParams,
    salt: decodeB64(env.salt, SALT_LEN, 'salt'),
    iv: decodeB64(env.iv, IV_LEN, 'iv'),
    tag: decodeB64(env.tag, TAG_LEN, 'tag'),
    ciphertext: decodeB64(env.ciphertext, null, 'ciphertext'),
  };
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new DuckCryptoError('AUTH_FAILED', 'empty password');
  }
}

function deriveKey(password, salt, params = KDF_PARAMS) {
  checkPassword(password);
  return crypto.scryptSync(password.normalize('NFC'), salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

// Async variant for the Electron main process — scrypt at these params takes
// hundreds of ms and must not block the event loop there.
function deriveKeyAsync(password, salt, params = KDF_PARAMS) {
  checkPassword(password);
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFC'),
      salt,
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

function validatePayload(payload) {
  if (typeof payload !== 'object' || payload === null) throw malformed('payload is not an object');
  if (!Number.isInteger(payload.payloadVersion) || payload.payloadVersion < 1) {
    throw malformed('payload missing payloadVersion');
  }
  if (!Array.isArray(payload.messages)) throw malformed('payload.messages is not an array');
  for (const m of payload.messages) {
    if (typeof m !== 'object' || m === null) throw malformed('message is not an object');
    if (typeof m.id !== 'string' || m.id.length === 0) throw malformed('message missing id');
    if (typeof m.text !== 'string') throw malformed('message missing text');
    if (typeof m.date !== 'string') throw malformed('message missing date');
  }
  return payload;
}

// key: 32-byte Buffer already derived from the envelope's salt/kdfParams.
function decryptWithKey(key, env) {
  const { iv, tag, ciphertext } = validateEnvelope(env);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DuckCryptoError('AUTH_FAILED', 'decryption failed — wrong password or tampered feed');
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw malformed('decrypted payload is not JSON');
  }
  return validatePayload(payload);
}

function decryptFeed(password, env) {
  const { salt, kdfParams } = validateEnvelope(env);
  const key = deriveKey(password, salt, kdfParams);
  return decryptWithKey(key, env);
}

async function decryptFeedAsync(password, env) {
  const { salt, kdfParams } = validateEnvelope(env);
  const key = await deriveKeyAsync(password, salt, kdfParams);
  return decryptWithKey(key, env);
}

function encryptFeed(password, payload) {
  validatePayload(payload);
  const salt = crypto.randomBytes(SALT_LEN); // fresh salt + iv on EVERY write
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    format: FORMAT,
    version: VERSION,
    kdf: 'scrypt',
    kdfParams: { ...KDF_PARAMS },
    salt: b64(salt),
    iv: b64(iv),
    tag: b64(cipher.getAuthTag()),
    ciphertext: b64(ciphertext),
  };
}

function newMessageId() {
  return 'm_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function emptyPayload() {
  return { payloadVersion: 1, messages: [] };
}

module.exports = {
  FORMAT,
  VERSION,
  KDF_PARAMS,
  DuckCryptoError,
  validateEnvelope,
  deriveKey,
  deriveKeyAsync,
  decryptWithKey,
  decryptFeed,
  decryptFeedAsync,
  encryptFeed,
  newMessageId,
  emptyPayload,
};
