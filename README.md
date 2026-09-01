# What's Up Duck 🦆

A cute duck that floats on your desktop and delivers secret messages from a friend.

- The duck sits on top of your screen but **never blocks your clicks** — only the duck itself is clickable.
- **Click the duck** to read the next message in a speech bubble. **Drag it** anywhere. **Right-click** for options.
- Messages are pulled from this repository's encrypted feed. Only people with the secret password can read them.

## Installing (for friends)

Download the latest installer from the [Releases page](https://github.com/rhk0330/whats-up-duck/releases):

- **Windows:** `WhatsUpDuck-Setup-x.y.z.exe` — one click, no options.
- **macOS:** `WhatsUpDuck-x.y.z-universal.dmg` — drag the app to Applications.

Then: right-click the duck → **Settings…** → enter the secret password you were given → **Save**. That's it.

### "Windows protected your PC" / "app is damaged"

The app isn't code-signed (that costs real money), so both OSes are suspicious of it:

- **Windows SmartScreen:** click **More info → Run anyway**. If your browser flags the download, choose **Keep**.
- **macOS:** if you see *"WhatsUpDuck is damaged and can't be opened"* or *"unidentified developer"*, try right-click → **Open** → **Open**. If that doesn't work, run this once in Terminal:

  ```
  xattr -dr com.apple.quarantine /Applications/WhatsUpDuck.app
  ```

  Or: System Settings → Privacy & Security → **Open Anyway**.

## Sending messages (for the owner)

The feed is `feed/messages.enc.json` — AES-256-GCM encrypted with a password-derived key (scrypt). Two ways to add a message:

### From any browser or phone

GitHub → **Actions** → **Add duck message** → **Run workflow** → type the message. Requires the `DUCK_PASSWORD` repository secret to be set (Settings → Secrets and variables → Actions).

### From a computer

```
node tools/duck.js add "hello from me" --push
node tools/duck.js list
node tools/duck.js remove <id>
node tools/duck.js rotate     # change the password
```

The password comes from the `DUCK_PASSWORD` env var or an interactive prompt.

Friends' apps check for new messages every 15 minutes by default (configurable). Note the GitHub raw CDN caches for ~5 minutes, so delivery isn't instant.

## Security notes (honest version)

- **Protected:** repo visitors can't read messages; the feed can't be tampered with undetected (GCM auth); the password is stored on friends' machines via the OS keychain (DPAPI/Keychain).
- **Not protected:** anyone with the password can read everything (it's a shared secret — that's the design); old feed versions in git history remain decryptable with the password that encrypted them, even after `rotate`; GitHub can see the `DUCK_PASSWORD` Actions secret.
- Pick a decent password. scrypt makes brute force expensive, but it can't save `duck123`.

## Development

```
npm install
npm test          # crypto + CLI tests
npm start         # run the app
npm run start:debug   # overlay click-through disabled, for DevTools work
npm run icons     # regenerate build/*.png
```

Releases: bump the version and push a tag — GitHub Actions builds and attaches both installers.

```
npm version patch && git push --follow-tags
```
