// ==UserScript==
// @name         WikiGacha Gamepad Support
// @namespace    https://wikigacha.com/
// @version      1.0.0
// @description  Adds gamepad controller support to WikiGacha — navigate, open packs, and confirm dialogs with a controller.
// @author       bene
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

  // Extra site-specific tappable areas (WikiGacha uses tap-to-open image areas)
  const TAPPABLE_SELECTORS = [
    'img',
    '[class*="pack"]',
    '[class*="card"]',
    '[class*="open"]',
    '[class*="tap"]',
    '[class*="pull"]',
    '[class*="btn"]',
    '[class*="button"]',
  ].join(',');

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

  function getInteractiveElements() {
    const seen = new Set();
    const result = [];

    document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
      if (!seen.has(el) && isVisible(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    // Also include tappable-looking elements that aren't covered above
    document.querySelectorAll(TAPPABLE_SELECTORS).forEach(el => {
      if (!seen.has(el) && isVisible(el) && hasTapHandler(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    return result;
  }

  function hasTapHandler(el) {
    // Check for event listeners added via Vue/React data attributes or onclick
    if (el.onclick || el.getAttribute('onclick')) return true;
    // Heuristic: elements with cursor:pointer are meant to be clicked
    return window.getComputedStyle(el).cursor === 'pointer';
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
    // Priority order: explicit open-button classes, then any visible image with pointer cursor
    const candidates = [
      document.querySelector('[class*="pack"][class*="open"]'),
      document.querySelector('[class*="tap"]'),
      document.querySelector('[class*="pack"] img'),
      ...(function () {
        const imgs = [...document.querySelectorAll('img')];
        return imgs.filter(img =>
          isVisible(img) && window.getComputedStyle(img).cursor === 'pointer'
        );
      }()),
    ].filter(Boolean);

    const target = candidates.find(isVisible);
    if (target) {
      setFocus(target);
      clickElement(target);
    }
  }

  /** Click the topmost visible close / OK button in an open dialog */
  function clickCloseButton() {
    const selectors = [
      '[class*="modal"] button',
      '[class*="dialog"] button',
      '[class*="popup"] button',
      '[role="dialog"] button',
      'button',
    ];

    // Prefer buttons containing common dismiss text
    const dismissText = /^(ok|close|confirm|yes|dismiss|×|✕|✖|cancel)$/i;

    for (const sel of selectors) {
      const buttons = [...document.querySelectorAll(sel)].filter(isVisible);
      const dismissBtn = buttons.find(b => dismissText.test(b.textContent.trim()));
      if (dismissBtn) {
        clickElement(dismissBtn);
        return;
      }
      // Fallback: first visible button in a dialog-like container
      if (buttons.length > 0 && sel.includes('modal', 'dialog', 'popup')) {
        clickElement(buttons[0]);
        return;
      }
    }
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
        <tr><td class="gp-btn">B</td><td>Close dialog</td></tr>
        <tr><td class="gp-btn">X</td><td>Open pack</td></tr>
        <tr><td class="gp-btn">Y</td><td>Toggle HUD</td></tr>
        <tr><td class="gp-btn">↕↔</td><td>Navigate</td></tr>
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
