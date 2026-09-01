'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const duckCrypto = require('../tools/duck-crypto');

const PW = 'correct horse battery duck';

function samplePayload() {
  return {
    payloadVersion: 1,
    messages: [
      { id: 'm_a', text: 'hello', date: '2026-09-01T00:00:00.000Z' },
      { id: 'm_b', text: 'quack', date: '2026-09-02T00:00:00.000Z', mood: 'excited' },
    ],
  };
}

test('round-trip encrypt/decrypt', () => {
  const env = duckCrypto.encryptFeed(PW, samplePayload());
  const out = duckCrypto.decryptFeed(PW, env);
  assert.deepStrictEqual(out, samplePayload());
});

test('fresh salt and iv on every encryption', () => {
  const a = duckCrypto.encryptFeed(PW, samplePayload());
  const b = duckCrypto.encryptFeed(PW, samplePayload());
  assert.notStrictEqual(a.salt, b.salt);
  assert.notStrictEqual(a.iv, b.iv);
});

test('wrong password -> AUTH_FAILED', () => {
  const env = duckCrypto.encryptFeed(PW, samplePayload());
  assert.throws(() => duckCrypto.decryptFeed('nope', env), (e) => e.code === 'AUTH_FAILED');
});

test('tampered ciphertext -> AUTH_FAILED', () => {
  const env = duckCrypto.encryptFeed(PW, samplePayload());
  const ct = Buffer.from(env.ciphertext, 'base64');
  ct[0] ^= 0xff;
  env.ciphertext = ct.toString('base64');
  assert.throws(() => duckCrypto.decryptFeed(PW, env), (e) => e.code === 'AUTH_FAILED');
});

test('malformed envelope -> MALFORMED_FILE (before any KDF work)', () => {
  for (const env of [
    null,
    {},
    { format: 'other', version: 1 },
    { ...duckCrypto.encryptFeed(PW, samplePayload()), salt: 'AAAA' }, // wrong salt length
    { ...duckCrypto.encryptFeed(PW, samplePayload()), iv: '***not base64***' },
  ]) {
    assert.throws(() => duckCrypto.validateEnvelope(env), (e) => e.code === 'MALFORMED_FILE');
  }
});

test('oversized kdf params rejected pre-KDF', () => {
  const env = duckCrypto.encryptFeed(PW, samplePayload());
  env.kdfParams = { N: 2 ** 22, r: 8, p: 1 };
  assert.throws(() => duckCrypto.validateEnvelope(env), (e) => e.code === 'MALFORMED_FILE');
  env.kdfParams = { N: 2 ** 17, r: 64, p: 1 };
  assert.throws(() => duckCrypto.validateEnvelope(env), (e) => e.code === 'MALFORMED_FILE');
});

test('future version -> UNSUPPORTED_VERSION', () => {
  const env = duckCrypto.encryptFeed(PW, samplePayload());
  env.version = 99;
  assert.throws(() => duckCrypto.validateEnvelope(env), (e) => e.code === 'UNSUPPORTED_VERSION');
});

test('unicode passwords are NFC-normalized', () => {
  const composed = 'café';        // e-acute as one code point
  const decomposed = 'café';     // e + combining acute accent
  const env = duckCrypto.encryptFeed(composed, samplePayload());
  const out = duckCrypto.decryptFeed(decomposed, env);
  assert.deepStrictEqual(out, samplePayload());
});

test('unknown payload fields survive a re-encrypt cycle', () => {
  const payload = samplePayload();
  payload.pinnedId = 'm_a';
  payload.messages[0].futureField = { nested: true };
  const out = duckCrypto.decryptFeed(PW, duckCrypto.encryptFeed(PW, payload));
  assert.deepStrictEqual(out, payload);
});

test('CLI init/add/list/remove round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-test-'));
  const file = path.join(dir, 'messages.enc.json');
  const cli = path.join(__dirname, '..', 'tools', 'duck.js');
  const run = (args) =>
    execFileSync(process.execPath, [cli, ...args, '--file', file], {
      env: { ...process.env, DUCK_PASSWORD: PW },
      encoding: 'utf8',
    });

  run(['init']);
  run(['add', 'first message']);
  run(['add', 'second message', '--mood', 'happy']);
  let listing = run(['list']);
  assert.match(listing, /first message/);
  assert.match(listing, /\[happy\]\s+second message/);

  const id = listing.trim().split('\n')[0].split(/\s+/)[0];
  run(['remove', id]);
  listing = run(['list']);
  assert.doesNotMatch(listing, /first message/);
  assert.match(listing, /second message/);

  // wrong password exits 2
  assert.throws(
    () =>
      execFileSync(process.execPath, [cli, 'list', '--file', file], {
        env: { ...process.env, DUCK_PASSWORD: 'wrong' },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (e) => e.status === 2,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
