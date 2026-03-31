// ==UserScript==
// @name         WikiGacha Gamepad Support
// @namespace    https://wikigacha.com/
// @version      1.2.0
// @description  Adds gamepad controller support to WikiGacha — navigate, open packs, and confirm dialogs with a controller.
// @author       bene
// @updateURL    https://raw.githubusercontent.com/bene987/WikiGacha-gamepad/main/wikigacha-gamepad.user.js
// @downloadURL  https://raw.githubusercontent.com/bene987/WikiGacha-gamepad/main/wikigacha-gamepad.user.js
// @match        https://wikigacha.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── Config ──────────────────────────────────────────────────────────────────
  const CFG = {
    deadzone: 0.30,       // analogue stick dead zone
    repeatDelay: 380,     // ms before auto-repeat starts while holding d-pad
    repeatRate: 140,      // ms between repeated inputs after initial delay
    hudId: 'gp-hud',
    alertId: 'gp-alert',
  };

  // Standard Gamepad API button indices
  const BTN = {
    A: 0,           // Confirm / click
    B: 1,           // Back / close
    X: 2,           // Open pack (shortcut)
    Y: 3,           // Toggle HUD
    LB: 4,
    RB: 5,
    LT: 6,
    RT: 7,
    SELECT: 8,
    START: 9,
    L3: 10,
    R3: 11,
    DPAD_UP: 12,
    DPAD_DOWN: 13,
    DPAD_LEFT: 14,
    DPAD_RIGHT: 15,
  };

  // ─── State ───────────────────────────────────────────────────────────────────
  let gamepadIndex = -1;
  let prevButtons = [];
  let focusedEl = null;
  let hudVisible = true;
  let lastNavDir = null;      // direction currently held
  let holdStart = 0;          // when current direction was first held
  let lastRepeat = 0;         // when last repeat fired
  let rafHandle = null;
  let dismissAlert = null;    // non-null while custom alert is open

  // ─── Selectors: elements considered "interactive" ───────────────────────────
  const INTERACTIVE_SELECTORS = [
    'button',
    'a[href]',
    'input[type="button"]',
    'input[type="submit"]',
    'input[type="checkbox"]',
    '[role="button"]',
    '[onclick]',
    '[tabindex]',
  ].join(',');

  // ─── Scene detection ─────────────────────────────────────────────────────────
  //  'gacha'   — main pack-opening screen (#gacha-pack-container present)
  //  'results' — after-pull card results (Previous/Next card buttons present)
  //  'generic' — everything else
  function detectScene() {
    if (document.getElementById('gacha-pack-container')) return 'gacha';
    if (document.querySelector('button[aria-label="Previous card"]')) return 'results';
    return 'generic';
  }

  // Find the < or > page-navigation button that flanks the "N/M" page counter span.
  function findPageNavButton(dir) {
    const spans = [...document.querySelectorAll('span')].filter(
      s => /^\d+\/\d+$/.test(s.textContent.trim()) && isVisible(s)
    );
    for (const span of spans) {
      const container = span.parentElement;
      if (!container) continue;
      const btns = [...container.querySelectorAll('button')].filter(isVisible);
      const btn = btns.find(b => b.textContent.trim() === (dir === 'prev' ? '<' : '>'));
      if (btn) return btn;
    }
    return null;
  }

  function findButtonByText(text) {
    return [...document.querySelectorAll('button')].find(
      b => b.textContent.trim() === text && isVisible(b)
    ) ?? null;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0'
    );
  }

  // Exclude elements that should never receive gamepad focus:
  // — inside aria-hidden subtrees (e.g. the offscreen card-clone prerender div)
  // — our own HUD overlay
  // — elements with pointer-events:none (decorative overlays)
  function isInert(el) {
    if (el.closest('[aria-hidden="true"]')) return true;
    if (el.closest('#' + CFG.hudId)) return true;
    if (window.getComputedStyle(el).pointerEvents === 'none') return true;
    return false;
  }

  function hasTapHandler(el) {
    if (el.onclick || el.getAttribute('onclick')) return true;
    return window.getComputedStyle(el).cursor === 'pointer';
  }

  function getInteractiveElements() {
    // While our alert is open, restrict navigation to its contents only
    const alertOverlay = document.getElementById(CFG.alertId);
    if (alertOverlay) {
      return [...alertOverlay.querySelectorAll('button')].filter(isVisible);
    }

    const seen = new Set();
    const result = [];

    document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
      if (!seen.has(el) && isVisible(el) && !isInert(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    // Also include tappable-looking elements not covered by the strict selectors
    // (excludes raw <img> to avoid noise; pack is handled via #gacha-pack-container)
    document.querySelectorAll('[class*="pack"],[class*="card"],[class*="btn"],[class*="button"]').forEach(el => {
      if (!seen.has(el) && isVisible(el) && !isInert(el) && hasTapHandler(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    return result;
  }

  function rectCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** Spatial navigation: find the closest element in a given direction */
  function findNearest(dir) {
    const elements = getInteractiveElements();
    if (elements.length === 0) return null;

    if (!focusedEl || !isVisible(focusedEl)) {
      return elements[0];
    }

    const cur = rectCenter(focusedEl);
    let best = null;
    let bestScore = Infinity;

    for (const el of elements) {
      if (el === focusedEl) continue;
      const c = rectCenter(el);
      const dx = c.x - cur.x;
      const dy = c.y - cur.y;

      // Only consider elements in roughly the right direction
      let valid = false;
      if (dir === 'up'    && dy < -5)  valid = true;
      if (dir === 'down'  && dy > 5)   valid = true;
      if (dir === 'left'  && dx < -5)  valid = true;
      if (dir === 'right' && dx > 5)   valid = true;

      if (!valid) continue;

      // Weighted distance: strongly penalise off-axis movement
      const primary   = dir === 'up' || dir === 'down' ? Math.abs(dy) : Math.abs(dx);
      const secondary = dir === 'up' || dir === 'down' ? Math.abs(dx) : Math.abs(dy);
      const score = primary + secondary * 3;

      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function moveFocus(dir) {
    const scene = detectScene();

    // Results screen: left/right directly navigate cards instead of spatial nav
    if (scene === 'results' && (dir === 'left' || dir === 'right')) {
      const label = dir === 'left' ? 'Previous card' : 'Next card';
      const btn = document.querySelector(`button[aria-label="${label}"]`);
      if (btn && isVisible(btn)) { setFocus(btn); clickElement(btn); return; }
    }

    // Fallback: generic spatial navigation
    const target = findNearest(dir);
    if (target) setFocus(target);
  }

  function setFocus(el) {
    if (focusedEl) removeFocusRing(focusedEl);
    focusedEl = el;
    addFocusRing(el);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function addFocusRing(el) {
    el.dataset.gpPrevOutline = el.style.outline || '';
    el.dataset.gpPrevOutlineOffset = el.style.outlineOffset || '';
    el.style.outline = '3px solid #f5c518';
    el.style.outlineOffset = '2px';
  }

  function removeFocusRing(el) {
    if (!el) return;
    el.style.outline = el.dataset.gpPrevOutline || '';
    el.style.outlineOffset = el.dataset.gpPrevOutlineOffset || '';
  }

  function clickElement(el) {
    if (!el || !isVisible(el)) return;
    el.click();
    // Simulate touch events for mobile-targeted listeners
    ['touchstart', 'touchend'].forEach(type => {
      const touch = new Touch({
        identifier: Date.now(),
        target: el,
        clientX: rectCenter(el).x,
        clientY: rectCenter(el).y,
      });
      el.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === 'touchstart' ? [touch] : [],
        changedTouches: [touch],
      }));
    });
  }

  /** Click the primary pack/open button on the current page */
  function clickPackButton() {
    // Use the known pack container ID first
    const packContainer = document.getElementById('gacha-pack-container');
    if (packContainer && isVisible(packContainer)) {
      setFocus(packContainer);
      clickElement(packContainer);
      return;
    }
    // Fallback: any visible image with a pointer cursor
    const img = [...document.querySelectorAll('img')].find(
      i => isVisible(i) && !isInert(i) && window.getComputedStyle(i).cursor === 'pointer'
    );
    if (img) { setFocus(img); clickElement(img); }
  }

  /** Click the topmost visible close / OK / back button */
  function clickCloseButton() {
    // Dismiss our custom alert first if one is open
    if (dismissAlert) { dismissAlert(); return; }

    const dismissText = /^(ok|close|confirm|yes|dismiss|×|✕|✖|cancel|back to packs)$/i;

    // Prefer modal/dialog containers, then fall back to any visible button
    const scopes = [
      '[class*="modal"]',
      '[class*="dialog"]',
      '[class*="popup"]',
      '[role="dialog"]',
      'body',
    ];

    for (const scope of scopes) {
      const container = document.querySelector(scope);
      if (!container) continue;
      const buttons = [...container.querySelectorAll('button')].filter(
        b => isVisible(b) && !isInert(b)
      );
      const dismissBtn = buttons.find(b => dismissText.test(b.textContent.trim()));
      if (dismissBtn) { clickElement(dismissBtn); return; }
      // For modal-like scopes also accept the first visible button as fallback
      if (scope !== 'body' && buttons.length > 0) { clickElement(buttons[0]); return; }
    }
  }

  // ─── Custom alert dialog ──────────────────────────────────────────────────────

  function gpAlert(message) {
    // Remove any lingering overlay
    document.getElementById(CFG.alertId)?.remove();
    dismissAlert = null;

    const overlay = document.createElement('div');
    overlay.id = CFG.alertId;
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483646',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.72)',
      backdropFilter: 'blur(3px)',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#1a1a1a',
      border: '1px solid rgba(245,197,24,0.45)',
      borderRadius: '12px',
      padding: '24px 28px',
      maxWidth: '340px',
      width: '90vw',
      boxShadow: '0 20px 60px rgba(0,0,0,0.85)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '18px',
      fontFamily: 'sans-serif',
    });

    const msg = document.createElement('p');
    msg.textContent = String(message ?? '');
    Object.assign(msg.style, {
      color: '#e5e5e5',
      fontSize: '14px',
      lineHeight: '1.6',
      textAlign: 'center',
      margin: '0',
      whiteSpace: 'pre-wrap',
    });

    const okBtn = document.createElement('button');
    okBtn.id = CFG.alertId + '-ok';
    okBtn.textContent = 'OK';
    Object.assign(okBtn.style, {
      background: '#f5c518',
      color: '#000',
      border: 'none',
      borderRadius: '20px',
      padding: '10px 44px',
      fontSize: '14px',
      fontWeight: 'bold',
      cursor: 'pointer',
      transition: 'background 0.15s',
    });
    okBtn.addEventListener('mouseenter', () => { okBtn.style.background = '#ffd84d'; });
    okBtn.addEventListener('mouseleave', () => { okBtn.style.background = '#f5c518'; });

    const hint = document.createElement('span');
    hint.textContent = 'A · B  to dismiss';
    Object.assign(hint.style, {
      color: '#444',
      fontSize: '10px',
      fontFamily: 'monospace',
    });

    function dismiss() {
      overlay.remove();
      dismissAlert = null;
      // Clear focus ref if it was pointing at the now-removed button
      if (focusedEl && !document.body.contains(focusedEl)) focusedEl = null;
    }

    dismissAlert = dismiss;
    okBtn.addEventListener('click', dismiss);
    // Backdrop click also dismisses
    overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });

    box.append(msg, okBtn, hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Auto-focus OK so pressing A immediately works
    setFocus(okBtn);
  }

  // ─── Gamepad polling ─────────────────────────────────────────────────────────

  function getGamepad() {
    if (gamepadIndex < 0) return null;
    return navigator.getGamepads()[gamepadIndex] || null;
  }

  function isPressed(gp, btnIndex) {
    const btn = gp.buttons[btnIndex];
    return btn ? btn.pressed || btn.value > 0.5 : false;
  }

  function wasJustPressed(gp, btnIndex) {
    return isPressed(gp, btnIndex) && !prevButtons[btnIndex];
  }

  function getStickDir(gp) {
    const ax = gp.axes[0] || 0;
    const ay = gp.axes[1] || 0;
    if (Math.abs(ax) < CFG.deadzone && Math.abs(ay) < CFG.deadzone) return null;
    if (Math.abs(ay) >= Math.abs(ax)) return ay < 0 ? 'up' : 'down';
    return ax < 0 ? 'left' : 'right';
  }

  function getDpadDir(gp) {
    if (isPressed(gp, BTN.DPAD_UP))    return 'up';
    if (isPressed(gp, BTN.DPAD_DOWN))  return 'down';
    if (isPressed(gp, BTN.DPAD_LEFT))  return 'left';
    if (isPressed(gp, BTN.DPAD_RIGHT)) return 'right';
    return null;
  }

  function poll(timestamp) {
    rafHandle = requestAnimationFrame(poll);

    const gp = getGamepad();
    if (!gp) return;

    // ── Button events (edge-triggered) ──────────────────────────────────────
    if (wasJustPressed(gp, BTN.A)) {
      if (focusedEl && isVisible(focusedEl)) {
        clickElement(focusedEl);
      } else {
        // Auto-focus first interactive element
        const els = getInteractiveElements();
        if (els.length) setFocus(els[0]);
      }
    }

    if (wasJustPressed(gp, BTN.B)) {
      clickCloseButton();
    }

    if (wasJustPressed(gp, BTN.X)) {
      clickPackButton();
    }

    if (wasJustPressed(gp, BTN.Y)) {
      toggleHud();
    }

    // ── LB / RB — page navigation on the results screen ─────────────────────
    if (wasJustPressed(gp, BTN.LB)) {
      const btn = detectScene() === 'results' ? findPageNavButton('prev') : null;
      if (btn) { setFocus(btn); clickElement(btn); }
    }

    if (wasJustPressed(gp, BTN.RB)) {
      const btn = detectScene() === 'results' ? findPageNavButton('next') : null;
      if (btn) { setFocus(btn); clickElement(btn); }
    }

    // ── Directional navigation (held with auto-repeat) ──────────────────────
    const dir = getDpadDir(gp) || getStickDir(gp);

    if (dir) {
      if (dir !== lastNavDir) {
        // New direction pressed
        lastNavDir = dir;
        holdStart = timestamp;
        lastRepeat = 0;
        moveFocus(dir);
      } else {
        // Held — check auto-repeat
        const held = timestamp - holdStart;
        if (held > CFG.repeatDelay) {
          if (lastRepeat === 0 || timestamp - lastRepeat > CFG.repeatRate) {
            lastRepeat = timestamp;
            moveFocus(dir);
          }
        }
      }
    } else {
      lastNavDir = null;
      lastRepeat = 0;
    }

    // Snapshot button states for edge detection next frame
    prevButtons = gp.buttons.map(b => b.pressed || b.value > 0.5);
  }

  // ─── Gamepad connect / disconnect ────────────────────────────────────────────

  window.addEventListener('gamepadconnected', e => {
    gamepadIndex = e.gamepad.index;
    prevButtons = [];
    console.log(`[WikiGacha Gamepad] Connected: ${e.gamepad.id}`);
    showToast(`Gamepad connected: ${e.gamepad.id.split('(')[0].trim()}`);
    if (!rafHandle) rafHandle = requestAnimationFrame(poll);
  });

  window.addEventListener('gamepaddisconnected', e => {
    if (e.gamepad.index === gamepadIndex) {
      gamepadIndex = -1;
      prevButtons = [];
      if (focusedEl) removeFocusRing(focusedEl);
      focusedEl = null;
      console.log('[WikiGacha Gamepad] Disconnected');
      if (rafHandle) { cancelAnimationFrame(rafHandle); rafHandle = null; }
    }
  });

  // ─── HUD ─────────────────────────────────────────────────────────────────────

  function buildHud() {
    const hud = document.createElement('div');
    hud.id = CFG.hudId;
    hud.innerHTML = `
      <div class="gp-title">🎮 Gamepad</div>
      <table>
        <tr><td class="gp-btn">A</td><td>Confirm / Click</td></tr>
        <tr><td class="gp-btn">B</td><td>Close / Back</td></tr>
        <tr><td class="gp-btn">X</td><td>Open pack</td></tr>
        <tr><td class="gp-btn">Y</td><td>Toggle HUD</td></tr>
        <tr><td class="gp-btn">LB·RB</td><td>Prev/Next page</td></tr>
        <tr><td class="gp-btn">↕↔</td><td>Navigate / Cards</td></tr>
      </table>
    `;
    Object.assign(hud.style, {
      position: 'fixed',
      bottom: '12px',
      right: '12px',
      zIndex: '2147483647',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      fontFamily: 'monospace',
      fontSize: '11px',
      padding: '8px 10px',
      borderRadius: '8px',
      lineHeight: '1.6',
      pointerEvents: 'none',
      userSelect: 'none',
      backdropFilter: 'blur(4px)',
      border: '1px solid rgba(255,255,255,0.15)',
    });

    const style = document.createElement('style');
    style.textContent = `
      #${CFG.hudId} .gp-title { font-weight: bold; margin-bottom: 4px; color: #f5c518; }
      #${CFG.hudId} table { border-collapse: collapse; }
      #${CFG.hudId} td { padding: 0 4px; }
      #${CFG.hudId} .gp-btn {
        background: #444; border-radius: 3px; padding: 0 5px;
        font-weight: bold; color: #f5c518; text-align: center; min-width: 18px;
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(hud);
    return hud;
  }

  function toggleHud() {
    hudVisible = !hudVisible;
    const hud = document.getElementById(CFG.hudId);
    if (hud) hud.style.display = hudVisible ? 'block' : 'none';
  }

  // ─── Toast notification ───────────────────────────────────────────────────────

  function showToast(message) {
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '2147483647',
      background: 'rgba(0,0,0,0.82)',
      color: '#fff',
      fontFamily: 'sans-serif',
      fontSize: '13px',
      padding: '8px 18px',
      borderRadius: '20px',
      pointerEvents: 'none',
      transition: 'opacity 0.4s',
      opacity: '1',
    });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, 2200);
    setTimeout(() => toast.remove(), 2700);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    buildHud();

    // Some browsers require polling even before gamepadconnected fires
    const checkExisting = navigator.getGamepads();
    for (const gp of checkExisting) {
      if (gp) {
        gamepadIndex = gp.index;
        prevButtons = [];
        console.log(`[WikiGacha Gamepad] Already connected: ${gp.id}`);
        rafHandle = requestAnimationFrame(poll);
        break;
      }
    }

    console.log('[WikiGacha Gamepad] Script loaded — connect a controller to play.');

    // Intercept native alert() when a gamepad is connected
    const _nativeAlert = window.alert.bind(window);
    window.alert = function (message) {
      if (gamepadIndex >= 0) { gpAlert(message); } else { _nativeAlert(message); }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
