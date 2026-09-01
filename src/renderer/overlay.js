'use strict';
// Overlay renderer: duck state machine, hit-testing for click-through,
// click-vs-drag gesture, speech bubble with edge-flip placement.

(() => {
  // Allow opening overlay.html in a plain browser for visual tweaking.
  const api = window.duck || {
    setInteractive() {}, setHitRect() {}, dragStart() {},
    dragEnd: async () => ({ wasDrag: false }),
    showContextMenu() {},
    getGeometry: async () => ({ winBounds: null, workArea: null, duckSize: 140 }),
    nextMessage: async () => ({
      message: { id: 'demo', text: 'Quack! (browser preview)', date: new Date().toISOString() },
      remainingUnseen: 2,
    }),
    getFeedState: async () => ({ status: 'READY', unseenCount: 3, messageCount: 5, hasPassword: true }),
    refreshNow: async () => {},
    getSettings: async () => ({ animationSpeed: 1, duckSize: 140, bubbleDismissSeconds: 20, firstRunComplete: true, hasPassword: true }),
    setSettings: async () => {},
    openSettings() {},
    onSettingsChanged() {}, onFeedState() {}, onGreet() {},
  };

  const root = document.documentElement;
  const svg = document.getElementById('duck'); // the GIF avatar element
  const wrap = document.getElementById('duck-wrap');
  const bubble = document.getElementById('bubble');
  const bubbleText = document.getElementById('bubble-text');
  const bubbleDate = document.getElementById('bubble-date');
  const bubbleHint = document.getElementById('bubble-hint');
  const bubblePrev = document.getElementById('bubble-prev');
  const bubbleSettingsBtn = document.getElementById('bubble-settings-btn');
  const badge = document.getElementById('badge');
  const badgeCount = document.getElementById('badge-count');

  const TAIL = 12;
  const EDGE_PAD = 8;
  const SLEEP_AFTER_MS = 5 * 60 * 1000;

  let settings = { animationSpeed: 1, duckSize: 140, bubbleDismissSeconds: 20, firstRunComplete: true, hasPassword: false };
  let feedState = { status: 'NO_PASSWORD', unseenCount: 0, messageCount: 0, hasPassword: false };

  // gesture state
  let pointerDown = false;
  let dragging = false;
  let downPos = null;
  let lastMove = null;

  // duck state flags
  let talking = false;
  let greeting = false;
  let sleeping = false;
  let talkTimer = null;
  let sleepTimer = null;

  // bubble session
  let shown = []; // messages displayed since the bubble opened
  let shownIdx = -1;
  let remainingUnseen = 0;
  let dismissTimer = null;
  let onboardingMode = false;

  // ---------- duck state machine ----------

  function setDuckState() {
    const cls = dragging
      ? 'is-dragging'
      : talking
        ? 'is-talking'
        : greeting
          ? 'is-greeting'
          : sleeping
            ? 'is-sleeping'
            : feedState.unseenCount > 0 && bubble.hidden
              ? 'is-excited'
              : 'is-idle';
    for (const c of ['is-dragging', 'is-talking', 'is-greeting', 'is-sleeping', 'is-excited', 'is-idle']) {
      svg.classList.toggle(c, c === cls);
    }
  }

  function wake() {
    if (sleeping) {
      sleeping = false;
      setDuckState();
    }
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      if (feedState.unseenCount === 0 && bubble.hidden && !dragging) {
        sleeping = true;
        setDuckState();
      }
    }, SLEEP_AFTER_MS);
  }

  function playGreeting() {
    // The GIF avatar is always dancing — greeting is just a brief state.
    greeting = true;
    setDuckState();
    setTimeout(() => {
      greeting = false;
      setDuckState();
    }, 2200);
  }

  function startTalking() {
    talking = true;
    setDuckState();
    if (talkTimer) clearTimeout(talkTimer);
    talkTimer = setTimeout(() => {
      talking = false;
      setDuckState();
    }, 1800);
  }

  // ---------- badge ----------

  function updateBadge() {
    if (!feedState.hasPassword) {
      badge.hidden = false;
      badge.classList.add('attention-needed');
      badgeCount.textContent = '!';
    } else if (feedState.unseenCount > 0) {
      badge.hidden = false;
      badge.classList.remove('attention-needed');
      badgeCount.textContent = String(Math.min(feedState.unseenCount, 99));
    } else {
      badge.hidden = true;
    }
    setDuckState();
  }

  // ---------- hit-testing for click-through ----------

  let overInteractive = false;

  function interactiveRects() {
    const rects = [wrap.getBoundingClientRect()];
    if (!bubble.hidden) rects.push(bubble.getBoundingClientRect());
    return rects;
  }

  function pointInRects(x, y, rects) {
    return rects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }

  function reportHitRect() {
    const rects = interactiveRects();
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    api.setHitRect({ x: left, y: top, w: right - left, h: bottom - top });
  }

  document.addEventListener('mousemove', (e) => {
    if (pointerDown) {
      lastMove = { x: e.screenX, y: e.screenY, t: performance.now() };
      if (!dragging && downPos && (Math.abs(e.screenX - downPos.x) > 4 || Math.abs(e.screenY - downPos.y) > 4)) {
        dragging = true;
        hideBubble();
        setDuckState();
      }
      if (dragging && downPos) {
        // tilt from horizontal velocity
        const dt = Math.max(1, performance.now() - (downPos.t || 0));
        const vx = ((e.screenX - downPos.x) / dt) * 40;
        root.style.setProperty('--tilt', String(Math.max(-10, Math.min(10, vx))));
      }
      return;
    }
    const over = pointInRects(e.clientX, e.clientY, interactiveRects());
    if (over !== overInteractive) {
      overInteractive = over;
      api.setInteractive(over);
      if (over) reportHitRect();
    }
    svg.classList.toggle('is-perked', over);
    if (over) wake();
  });

  // ---------- click vs drag gesture ----------

  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pointerDown = true;
    downPos = { x: e.screenX, y: e.screenY, t: performance.now() };
    api.dragStart();
  });

  window.addEventListener('mouseup', async (e) => {
    if (!pointerDown || e.button !== 0) return;
    pointerDown = false;
    const { wasDrag } = await api.dragEnd();
    root.style.setProperty('--tilt', '0');
    if (dragging || wasDrag) {
      dragging = false;
      setDuckState();
      reportHitRect();
      return;
    }
    dragging = false;
    wake();
    await handleDuckClick();
  });

  window.addEventListener('blur', async () => {
    if (pointerDown) {
      pointerDown = false;
      dragging = false;
      await api.dragEnd();
      root.style.setProperty('--tilt', '0');
      setDuckState();
    }
  });

  wrap.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    // A right-click while the left button is held would otherwise swallow the
    // left mouseup (the native menu grabs input), leaving the drag interval
    // running forever — end the gesture first.
    if (pointerDown) {
      pointerDown = false;
      dragging = false;
      await api.dragEnd();
      root.style.setProperty('--tilt', '0');
      setDuckState();
    }
    api.showContextMenu();
  });

  // ---------- message flow ----------

  async function handleDuckClick() {
    if (onboardingMode) {
      // clicking the duck re-opens the onboarding bubble
      showOnboarding();
      return;
    }
    const nothingLeft =
      feedState.unseenCount === 0 && remainingUnseen === 0 && shownIdx >= shown.length - 1;
    if (!bubble.hidden && nothingLeft) {
      hideBubble();
      setDuckState();
      return;
    }
    await advance();
  }

  async function advance() {
    const res = await api.nextMessage();
    if (!res) {
      showSystemBubble(
        feedState.hasPassword
          ? 'No messages yet — check back later. Quack!'
          : 'Enter the secret password in Settings to get messages.',
      );
      return;
    }
    remainingUnseen = res.remainingUnseen;
    shown.push(res.message);
    shownIdx = shown.length - 1;
    renderMessage();
    await placeBubble();
    startTalking();
    armDismissTimer();
    updateBadge();
  }

  function renderMessage() {
    const m = shown[shownIdx];
    onboardingMode = false;
    bubbleSettingsBtn.hidden = true;
    bubbleText.textContent = m.text;
    bubbleDate.textContent = formatDate(m.date);
    bubblePrev.hidden = shownIdx <= 0;
    bubbleHint.textContent =
      shownIdx < shown.length - 1
        ? `${shownIdx + 1}/${shown.length}`
        : remainingUnseen > 0
          ? `${remainingUnseen} more…`
          : '';
    bubble.hidden = false;
  }

  function showSystemBubble(text, { withSettingsButton = false } = {}) {
    bubbleText.textContent = text;
    bubbleDate.textContent = '';
    bubbleHint.textContent = '';
    bubblePrev.hidden = true;
    bubbleSettingsBtn.hidden = !withSettingsButton;
    bubble.hidden = false;
    placeBubble();
    startTalking();
    if (!withSettingsButton) armDismissTimer();
  }

  function showOnboarding() {
    onboardingMode = true;
    showSystemBubble(
      "Hi! I'm Ducky. 🦆\nRight-click me for options, and drag me anywhere.\nEnter the secret password in Settings to get messages.",
      { withSettingsButton: true },
    );
  }

  function hideBubble() {
    if (bubble.hidden) return;
    bubble.hidden = true;
    shown = [];
    shownIdx = -1;
    if (dismissTimer) clearTimeout(dismissTimer);
    if (talkTimer) clearTimeout(talkTimer);
    talking = false;
    reportHitRect();
  }

  let hoveringBubble = false;

  function armDismissTimer() {
    if (dismissTimer) clearTimeout(dismissTimer);
    // While the cursor is inside the bubble the timer stays paused —
    // mouseleave re-arms it (covers click-to-advance while hovering).
    if (hoveringBubble) return;
    const secs = settings.bubbleDismissSeconds;
    if (!secs) return;
    dismissTimer = setTimeout(() => {
      hideBubble();
      setDuckState();
    }, secs * 1000);
  }

  bubble.addEventListener('mouseenter', () => {
    hoveringBubble = true;
    if (dismissTimer) clearTimeout(dismissTimer);
  });
  bubble.addEventListener('mouseleave', () => {
    hoveringBubble = false;
    if (!bubble.hidden && !onboardingMode) armDismissTimer();
  });

  bubble.addEventListener('click', async (e) => {
    if (e.target === bubblePrev || e.target === bubbleSettingsBtn) return;
    if (onboardingMode) return;
    if (shownIdx < shown.length - 1) {
      shownIdx += 1;
      renderMessage();
      await placeBubble();
      armDismissTimer();
    } else if (remainingUnseen > 0) {
      await advance();
    } else {
      hideBubble();
      setDuckState();
    }
  });

  bubblePrev.addEventListener('click', async () => {
    if (shownIdx > 0) {
      shownIdx -= 1;
      renderMessage();
      await placeBubble();
      armDismissTimer();
    }
  });

  bubbleSettingsBtn.addEventListener('click', () => api.openSettings());

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      return '';
    }
  }

  // ---------- bubble placement with edge-flip ----------

  async function placeBubble() {
    if (bubble.hidden) return;
    // Hide while measuring/awaiting geometry so no frame paints the bubble at
    // the window's top-left corner.
    bubble.style.visibility = 'hidden';
    bubble.style.left = '0px';
    bubble.style.top = '0px';
    const bw = bubble.offsetWidth;
    const bh = bubble.offsetHeight;

    const duckRect = wrap.getBoundingClientRect();
    const duckCx = duckRect.left + duckRect.width / 2;
    const duckCy = duckRect.top + duckRect.height / 2;

    const geo = await api.getGeometry();
    // Work-area limits in window-local coordinates (fallback: window itself).
    let minX = 0;
    let minY = 0;
    let maxX = window.innerWidth;
    let maxY = window.innerHeight;
    if (geo.winBounds && geo.workArea) {
      minX = Math.max(0, geo.workArea.x - geo.winBounds.x);
      minY = Math.max(0, geo.workArea.y - geo.winBounds.y);
      maxX = Math.min(window.innerWidth, geo.workArea.x + geo.workArea.width - geo.winBounds.x);
      maxY = Math.min(window.innerHeight, geo.workArea.y + geo.workArea.height - geo.winBounds.y);
    }

    const spaceAbove = duckRect.top - minY;
    const spaceBelow = maxY - duckRect.bottom;
    const spaceRight = maxX - duckRect.right;
    const spaceLeft = duckRect.left - minX;

    let side = 'above';
    if (spaceAbove >= bh + TAIL + EDGE_PAD) side = 'above';
    else if (spaceRight >= bw + TAIL + EDGE_PAD) side = 'right';
    else if (spaceLeft >= bw + TAIL + EDGE_PAD) side = 'left';
    else side = 'below';

    let left;
    let top;
    if (side === 'above' || side === 'below') {
      top = side === 'above' ? duckRect.top - TAIL - bh : duckRect.bottom + TAIL;
      left = clamp(duckCx - bw / 2, minX + EDGE_PAD, maxX - bw - EDGE_PAD);
      const tailX = clamp(duckCx - left, 18, bw - 18);
      bubble.style.setProperty('--tail-x', `${tailX}px`);
    } else {
      left = side === 'right' ? duckRect.right + TAIL : duckRect.left - TAIL - bw;
      top = clamp(duckCy - bh / 2, minY + EDGE_PAD, maxY - bh - EDGE_PAD);
      const tailY = clamp(duckCy - top, 18, bh - 18);
      bubble.style.setProperty('--tail-y', `${tailY}px`);
    }

    bubble.className = `bubble--${side}`;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    bubble.style.visibility = '';
    reportHitRect();
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  // ---------- settings / feed wiring ----------

  function applyVisual(s) {
    settings = { ...settings, ...s };
    root.style.setProperty('--speed', String(settings.animationSpeed || 1));
    root.style.setProperty('--duck-size', `${settings.duckSize || 140}px`);
  }

  let celebrated = false;

  api.onSettingsChanged((s) => {
    applyVisual(s);
    if (!bubble.hidden) placeBubble();
  });

  api.onFeedState((fsnap) => {
    feedState = fsnap;
    updateBadge();
    // New mail wakes a sleeping duck so the excited cue can actually play.
    if (fsnap.unseenCount > 0) wake();
    // The feed works — onboarding is over, however we got here.
    if (fsnap.status === 'READY' && fsnap.hasPassword && (onboardingMode || !settings.firstRunComplete)) {
      onboardingMode = false;
      if (!settings.firstRunComplete) {
        api.setSettings({ firstRunComplete: true });
        settings.firstRunComplete = true;
      }
      if (!celebrated) {
        celebrated = true;
        showSystemBubble("All set! I'll bring you messages as they arrive. 🎉");
      } else if (!bubble.hidden && bubbleSettingsBtn.hidden === false) {
        hideBubble();
        setDuckState();
      }
    }
  });

  api.onGreet(() => playGreeting());

  // ---------- boot ----------

  (async () => {
    applyVisual(await api.getSettings());
    feedState = await api.getFeedState();
    updateBadge();
    playGreeting();
    wake();
    if (!settings.firstRunComplete || !feedState.hasPassword) {
      showOnboarding();
    }
  })();
})();
