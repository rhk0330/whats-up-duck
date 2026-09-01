'use strict';
(() => {
  const api = window.duck;
  if (!api) return; // plain-browser preview

  const $ = (id) => document.getElementById(id);
  const password = $('password');
  const togglePassword = $('toggle-password');
  const testBtn = $('test-connection');
  const testStatus = $('test-status');
  const feedStatus = $('feed-status');
  const feedUrl = $('feed-url');
  const pollInterval = $('poll-interval');
  const autoDismiss = $('auto-dismiss');
  const checkNow = $('check-now');
  const duckSize = $('duck-size');
  const duckSizeValue = $('duck-size-value');
  const animationSpeed = $('animation-speed');
  const animationSpeedValue = $('animation-speed-value');
  const launchAtLogin = $('launch-at-login');
  const saveBtn = $('save');
  const cancelBtn = $('cancel');

  let current = null;
  let passwordTouched = false;

  function markDirty() {
    saveBtn.classList.add('dirty');
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = cls || '';
  }

  const STATUS_TEXT = {
    NO_PASSWORD: 'No password set — enter the secret password above.',
    READY: 'Connected.',
    FETCHING: 'Checking…',
    OFFLINE: "Can't reach the feed (offline?).",
    AUTH_FAILED: "That password didn't work.",
    PASSWORD_ROTATED: 'The password looks like it changed — re-enter it.',
    FEED_ERROR: 'The feed file looks broken.',
  };

  function renderFeedState(fsnap) {
    const bits = [STATUS_TEXT[fsnap.status] || fsnap.status];
    if (fsnap.lastCheckedAt) {
      bits.push(`Last checked ${new Date(fsnap.lastCheckedAt).toLocaleTimeString()}.`);
    }
    if (fsnap.messageCount) {
      bits.push(`${fsnap.messageCount} messages · ${fsnap.unseenCount} unseen.`);
    }
    feedStatus.textContent = bits.join(' ');
  }

  function load(s) {
    current = s;
    password.value = '';
    password.placeholder = s.hasPassword ? '•••••••• (saved)' : 'Enter the password you were given';
    passwordTouched = false;
    feedUrl.value = s.feedUrl;
    pollInterval.value = String(s.pollIntervalMinutes);
    autoDismiss.value = String(s.bubbleDismissSeconds);
    duckSize.value = String(s.duckSize);
    duckSizeValue.textContent = `${s.duckSize}px`;
    animationSpeed.value = String(s.animationSpeed);
    animationSpeedValue.textContent = `${s.animationSpeed}x`;
    launchAtLogin.checked = s.launchAtLogin;
    saveBtn.classList.remove('dirty');
  }

  // ---- events ----

  password.addEventListener('input', () => {
    passwordTouched = true;
    markDirty();
  });
  feedUrl.addEventListener('input', markDirty);
  pollInterval.addEventListener('change', markDirty);
  autoDismiss.addEventListener('input', markDirty);
  launchAtLogin.addEventListener('change', markDirty);

  togglePassword.addEventListener('click', () => {
    password.type = password.type === 'password' ? 'text' : 'password';
  });

  // sliders live-apply (pure-visual, safe)
  duckSize.addEventListener('input', () => {
    duckSizeValue.textContent = `${duckSize.value}px`;
  });
  duckSize.addEventListener('change', () => {
    api.setSettings({ duckSize: Number(duckSize.value) });
  });
  animationSpeed.addEventListener('input', () => {
    animationSpeedValue.textContent = `${animationSpeed.value}x`;
    api.setSettings({ animationSpeed: Number(animationSpeed.value) });
  });

  testBtn.addEventListener('click', async () => {
    setStatus(testStatus, 'Checking…', '');
    testBtn.disabled = true;
    try {
      const res = await api.testConnection({
        password: passwordTouched && password.value ? password.value : undefined,
        feedUrl: feedUrl.value !== current.feedUrl ? feedUrl.value : undefined,
      });
      if (res.ok) {
        setStatus(testStatus, `✓ Connected — ${res.messageCount} messages, decrypt OK`, 'ok');
      } else if (res.errorCode === 'AUTH_FAILED') {
        setStatus(testStatus, '✗ Wrong password (couldn’t decrypt)', 'error');
      } else if (res.errorCode === 'OFFLINE') {
        setStatus(testStatus, '⚠ ' + res.errorMessage, 'warn');
      } else {
        setStatus(testStatus, '✗ ' + res.errorMessage, 'error');
      }
    } finally {
      testBtn.disabled = false;
    }
  });

  checkNow.addEventListener('click', async () => {
    renderFeedState(await api.refreshNow());
  });

  saveBtn.addEventListener('click', async () => {
    const patch = {
      pollIntervalMinutes: Number(pollInterval.value),
      launchAtLogin: launchAtLogin.checked,
      feedUrl: feedUrl.value.trim(),
    };
    // Empty/invalid number field must not silently become 0 ("never dismiss").
    if (autoDismiss.value !== '' && autoDismiss.checkValidity()) {
      patch.bubbleDismissSeconds = Number(autoDismiss.value);
    }
    // Touched-but-empty is an explicit "clear the saved password".
    if (passwordTouched) patch.password = password.value;
    saveBtn.disabled = true;
    try {
      load(await api.setSettings(patch));
      renderFeedState(await api.getFeedState());
    } finally {
      saveBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', () => window.close());

  api.onFeedState(renderFeedState);
  api.onSettingsChanged((s) => {
    // keep sliders in sync if changed elsewhere; don't clobber text edits
    duckSize.value = String(s.duckSize);
    duckSizeValue.textContent = `${s.duckSize}px`;
    animationSpeed.value = String(s.animationSpeed);
    animationSpeedValue.textContent = `${s.animationSpeed}x`;
    current = { ...current, ...s };
  });

  // ---- boot ----
  (async () => {
    load(await api.getSettings());
    renderFeedState(await api.getFeedState());
  })();
})();
