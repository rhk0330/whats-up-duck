#!/usr/bin/env node
'use strict';
// Authoring CLI for the What's Up Duck encrypted message feed.
//
//   node tools/duck.js init
//   node tools/duck.js add "message text" [--mood happy] [--push]
//   node tools/duck.js list
//   node tools/duck.js remove <id>
//   node tools/duck.js rotate
//
// Password comes from the DUCK_PASSWORD env var, or a hidden interactive prompt.
// --file <path> overrides the feed location (used by tests).
// Exit codes: 0 ok, 1 usage/other, 2 wrong password, 3 malformed feed file.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const duckCrypto = require('./duck-crypto');

const DEFAULT_FEED = path.join(__dirname, '..', 'feed', 'messages.enc.json');

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  let optionsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (optionsDone) args._.push(a);
    else if (a === '--') optionsDone = true; // everything after is positional
    else if (a === '--push') args.flags.push = true;
    else if (a === '--mood') args.flags.mood = argv[++i];
    else if (a === '--file') args.flags.file = argv[++i];
    else if (a.startsWith('--')) fail(1, `unknown option ${a} (use "--" before message text starting with dashes)`);
    else args._.push(a);
  }
  return args;
}

function fail(code, message) {
  console.error(`duck: ${message}`);
  process.exit(code);
}

function promptHidden(question) {
  if (!process.stdin.isTTY) {
    fail(1, 'a password is required — set the DUCK_PASSWORD env var when not running in a terminal');
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const write = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => {
      // readline line-refreshes (backspace, arrows, resize) rewrite the whole
      // line including everything typed — never echo the buffer, only the
      // prompt plus asterisks.
      if (typeof s === 'string' && s.includes(question)) {
        write(question + '*'.repeat(rl.line.length));
      }
    };
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl.on('close', () => {
      // EOF (Ctrl+D / piped stdin ran dry) — never leave a hung promise.
      if (!answered) fail(1, 'password prompt aborted');
    });
  });
}

async function getPassword({ confirm = false, label = 'Feed password' } = {}) {
  if (process.env.DUCK_PASSWORD) return process.env.DUCK_PASSWORD;
  const pw = await promptHidden(`${label}: `);
  if (!pw) fail(1, 'empty password');
  if (confirm) {
    const again = await promptHidden(`${label} (again): `);
    if (pw !== again) fail(1, 'passwords did not match');
  }
  return pw;
}

function readEnvelope(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail(1, `cannot read ${file} — run "node tools/duck.js init" first?`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(3, `${file} is not valid JSON`);
  }
}

function decryptOrDie(password, envelope) {
  try {
    return duckCrypto.decryptFeed(password, envelope);
  } catch (err) {
    if (err.code === 'AUTH_FAILED') fail(2, 'decryption failed — wrong password (or corrupted feed).');
    if (err.code === 'MALFORMED_FILE' || err.code === 'UNSUPPORTED_VERSION') fail(3, err.message);
    throw err;
  }
}

function writeEnvelope(file, password, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const envelope = duckCrypto.encryptFeed(password, payload);
  fs.writeFileSync(file, JSON.stringify(envelope, null, 2) + '\n');
}

function gitPush(file) {
  // Resolve the repo from the feed file's actual location — a --file path may
  // live anywhere (or nowhere near a git repo, which should fail cleanly).
  let repo;
  try {
    repo = execFileSync('git', ['-C', path.dirname(file), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    fail(1, `--push: ${file} is not inside a git repository`);
  }
  const rel = path.relative(repo, file);
  execFileSync('git', ['add', rel], { cwd: repo, stdio: 'inherit' });
  execFileSync('git', ['commit', '-m', 'duck: update feed'], { cwd: repo, stdio: 'inherit' });
  execFileSync('git', ['push'], { cwd: repo, stdio: 'inherit' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const file = args.flags.file || DEFAULT_FEED;

  switch (cmd) {
    case 'init': {
      if (fs.existsSync(file)) fail(1, `${file} already exists — refusing to overwrite`);
      const pw = await getPassword({ confirm: true, label: 'New feed password' });
      writeEnvelope(file, pw, duckCrypto.emptyPayload());
      console.log(`Created empty encrypted feed at ${file}`);
      console.log('Remember: set the DUCK_PASSWORD repository secret so the "Add duck message" GitHub Action works.');
      break;
    }
    case 'add': {
      const text = args._[1];
      if (!text) fail(1, 'usage: duck.js add "message text" [--mood m] [--push]');
      const pw = await getPassword();
      const payload = decryptOrDie(pw, readEnvelope(file));
      const message = {
        id: duckCrypto.newMessageId(),
        text,
        date: new Date().toISOString(),
      };
      if (args.flags.mood) message.mood = args.flags.mood;
      payload.messages.push(message);
      writeEnvelope(file, pw, payload);
      console.log(`Added message ${message.id} (${payload.messages.length} total).`);
      if (args.flags.push) gitPush(file);
      else console.log('Now commit and push feed/messages.enc.json (or rerun with --push).');
      break;
    }
    case 'list': {
      const pw = await getPassword();
      const payload = decryptOrDie(pw, readEnvelope(file));
      if (payload.messages.length === 0) {
        console.log('(no messages)');
        break;
      }
      for (const m of payload.messages) {
        const mood = m.mood ? ` [${m.mood}]` : '';
        console.log(`${m.id}  ${m.date}${mood}  ${m.text}`);
      }
      break;
    }
    case 'remove': {
      const id = args._[1];
      if (!id) fail(1, 'usage: duck.js remove <id>');
      const pw = await getPassword();
      const payload = decryptOrDie(pw, readEnvelope(file));
      const before = payload.messages.length;
      payload.messages = payload.messages.filter((m) => m.id !== id);
      if (payload.messages.length === before) fail(1, `no message with id ${id}`);
      writeEnvelope(file, pw, payload);
      console.log(`Removed ${id} (${payload.messages.length} remaining).`);
      if (args.flags.push) gitPush(file);
      break;
    }
    case 'rotate': {
      const oldPw = process.env.DUCK_PASSWORD || (await promptHidden('Current feed password: '));
      const payload = decryptOrDie(oldPw, readEnvelope(file));
      const newPw = process.env.DUCK_NEW_PASSWORD || (await getPasswordFresh());
      if (!newPw) fail(1, 'empty new password');
      writeEnvelope(file, newPw, payload);
      if (args.flags.push) gitPush(file);
      console.log('Feed re-encrypted with the new password. Do not forget:');
      console.log('  1. Update the DUCK_PASSWORD repository secret on GitHub.');
      console.log('  2. Friends must re-enter the new password in the app settings.');
      console.log('  3. Old versions of the feed in git history stay decryptable with the OLD password forever.');
      break;
    }
    default:
      fail(1, 'usage: duck.js <init|add|list|remove|rotate> [args] [--file path] [--mood m] [--push]');
  }
}

async function getPasswordFresh() {
  const pw = await promptHidden('New feed password: ');
  if (!pw) fail(1, 'empty password');
  const again = await promptHidden('New feed password (again): ');
  if (pw !== again) fail(1, 'passwords did not match');
  return pw;
}

main().catch((err) => fail(1, err.message));
