// ==UserScript==
// @name         WikiGacha Gamepad Support
// @namespace    https://wikigacha.com/
// @version      1.4.1
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
    wikiId: 'gp-wiki',
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
  let dismissWiki = null;     // non-null while wiki overlay is open
  let wikiScrollEl = null;    // scrollable content area of the wiki overlay

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

  // ─── Card helpers ────────────────────────────────────────────────────────────

  // Walk up from any element inside a card to find the card root div.
  function getCardContainer(el) {
    let node = el?.parentElement;
    while (node && node !== document.body) {
      if (node.classList?.contains('cursor-pointer') &&
          node.querySelector?.('button[data-no-stack-swipe="1"]')) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function isCardContainer(el) {
    if (!el || el.tagName === 'BUTTON') return false;
    // Cards always contain at least one data-no-stack-swipe button (☆ / i).
    // This works for both text-only cards (which have h2) and image cards (which don't).
    return el.classList?.contains('cursor-pointer') &&
           !!el.querySelector?.('button[data-no-stack-swipe="1"]');
  }

  function getCardTitle(cardEl) {
    // Text-only cards render the title as an h2 in the art area.
    // Image cards omit the h2; the title lives in the header bar as a .truncate span.
    const h2 = cardEl?.querySelector('h2');
    if (h2) return h2.textContent.trim();
    const span = cardEl?.querySelector('span.truncate');
    return span ? span.textContent.trim() : null;
  }

  // Return the favorite (☆) button inside a card.
  function getCardFavButton(cardEl) {
    return cardEl?.querySelector('button[data-no-stack-swipe="1"][aria-label*="favorites"]') ?? null;
  }

  // Return the info (i) button inside a card.
  function getCardInfoButton(cardEl) {
    return [...(cardEl?.querySelectorAll('button[data-no-stack-swipe="1"]') ?? [])]
      .find(b => b.textContent.trim() === 'i') ?? null;
  }

  // Return the card that's currently in front (not stacked / pointer-events:none).
  function getFrontCard() {
    for (const iBtn of document.querySelectorAll('button[data-no-stack-swipe="1"]')) {
      const card = getCardContainer(iBtn);
      if (card && isVisible(card) && !isInert(card)) return card;
    }
    return null;
  }

  // Detect the Wikipedia language from the page URL (?lang=EN etc.).
  function getWikiLang() {
    const params = new URLSearchParams(window.location.search);
    const l = (params.get('lang') || '').toUpperCase();
    const map = { EN: 'en', ES: 'es', FR: 'fr', JA: 'ja', ZH_HANS: 'zh', ZH_HANT: 'zh' };
    return map[l] || (document.documentElement.lang?.slice(0, 2)) || 'en';
  }

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
    // While our wiki overlay is open, restrict navigation to its buttons only
    const wikiOverlayEl = document.getElementById(CFG.wikiId);
    if (wikiOverlayEl) {
      return [...wikiOverlayEl.querySelectorAll('button')].filter(isVisible);
    }

    // While our alert is open, restrict navigation to its contents only
    const alertOverlay = document.getElementById(CFG.alertId);
    if (alertOverlay) {
      return [...alertOverlay.querySelectorAll('button')].filter(isVisible);
    }

    const seen = new Set();
    const result = [];

    document.querySelectorAll(INTERACTIVE_SELECTORS).forEach(el => {
      // data-no-stack-swipe="1" is only used on card-internal buttons (☆ / i).
      // They are mapped to RT / Y — always exclude from d-pad navigation.
      if (el.dataset.noStackSwipe === '1') return;
      if (!seen.has(el) && isVisible(el) && !isInert(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    // Also include tappable-looking elements not covered by the strict selectors
    // (excludes raw <img> to avoid noise; pack is handled via #gacha-pack-container)
    document.querySelectorAll('[class*="pack"],[class*="card"],[class*="btn"],[class*="button"]').forEach(el => {
      if (el.dataset.noStackSwipe === '1') return;
      if (!seen.has(el) && isVisible(el) && !isInert(el) && hasTapHandler(el)) {
        seen.add(el);
        result.push(el);
      }
    });

    // Include card containers as focusable items (works for both stack and grid views).
    // Avoid getComputedStyle pointer-events check here — it can misfire on cards that
    // still carry stale stack-view inline styles. Use direct class checks instead:
    //   • aria-hidden ancestor → offscreen prerender clone area
    //   • pointer-events-none on the element itself → explicitly disabled card
    //   • pointer-events-none on the direct parent → stacked non-front card (stack view)
    document.querySelectorAll('div.cursor-pointer').forEach(el => {
      if (!isCardContainer(el)) return;
      if (el.closest('[aria-hidden="true"]')) return;
      if (el.classList.contains('pointer-events-none')) return;
      if (el.parentElement?.classList.contains('pointer-events-none')) return;
      if (!seen.has(el) && isVisible(el)) {
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
    // Sweep ALL elements that still carry our ring marker — handles stale rings
    // left behind when React re-renders and replaces the previously focused node.
    document.querySelectorAll('[data-gp-prev-outline]').forEach(removeFocusRing);
    if (focusedEl) removeFocusRing(focusedEl);
    focusedEl = el;
    addFocusRing(el);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function addFocusRing(el) {
    el.dataset.gpPrevOutline = el.style.outline || '';
    el.dataset.gpPrevOutlineOffset = el.style.outlineOffset || '';
    el.dataset.gpPrevBoxShadow = el.style.boxShadow || '';
    el.style.outline = '3px solid #f5c518';
    el.style.outlineOffset = '2px';
    if (isCardContainer(el)) {
      // Extra glow for card focus so it stands out against the dark background
      const base = el.dataset.gpPrevBoxShadow;
      el.style.boxShadow = '0 0 0 3px #f5c518, 0 0 28px rgba(245,197,24,0.55)' +
        (base ? ', ' + base : '');
    }
  }

  // Matches the ring colour in any format the browser may stringify it to
  const RING_OUTLINE_RE = /3px solid (rgb\(245,\s*197,\s*24\)|#f5c518)/i;

  function removeFocusRing(el) {
    if (!el) return;
    const prev = el.dataset.gpPrevOutline || '';
    // Guard against the circular case where our own ring was saved as "previous"
    el.style.outline = RING_OUTLINE_RE.test(prev) ? '' : prev;
    el.style.outlineOffset = el.dataset.gpPrevOutlineOffset || '';
    el.style.boxShadow = el.dataset.gpPrevBoxShadow || '';
    delete el.dataset.gpPrevOutline;
    delete el.dataset.gpPrevOutlineOffset;
    delete el.dataset.gpPrevBoxShadow;
  }

  function clickElement(el) {
    if (!el || !isVisible(el)) return;
    el.click();
    // Buttons with data-no-stack-swipe="1" are card-internal controls that opted out of
    // swipe/touch handling. Only calling .click() prevents touch events from bubbling
    // up to the card container's swipe handler, which would cause double-actions and
    // card animation flicker.
    if (el.dataset.noStackSwipe === '1') return;
    // Simulate touch events for mobile-targeted listeners.
    // Guard against Safari, which has no global Touch constructor.
    if (typeof Touch === 'undefined') return;
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
    // Only act on the gacha (pack selection) screen — on the results/grid screen
    // there is no pack to open and the image fallback would click card contents,
    // triggering the game's card handlers multiple times.
    if (detectScene() !== 'gacha') return;
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
    // Dismiss wiki overlay first if open
    if (dismissWiki) { dismissWiki(); return; }
    // Dismiss our custom alert first if one is open
    if (dismissAlert) { dismissAlert(); return; }

    // Close a card's stats/info panel if one is open (data-card-info-open="1")
    const openCard = document.querySelector('[data-card-info-open="1"]');
    if (openCard && isVisible(openCard)) { clickElement(openCard); return; }

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

  // ─── Wikipedia article overlay ────────────────────────────────────────────────

  function openWikiOverlay(title) {
    document.getElementById(CFG.wikiId)?.remove();
    dismissWiki = null;
    wikiScrollEl = null;

    const lang = getWikiLang();
    // Use the Action API (?action=parse) — it has open CORS headers unlike mobile-sections.
    // prop=text gives the full rendered HTML; prop=images gives the lead image title.
    const apiBase = `https://${lang}.wikipedia.org/w/api.php`;
    const apiUrl = `${apiBase}?action=parse&page=${encodeURIComponent(title)}&prop=text%7Cimages&disableeditsection=1&format=json&origin=*`;

    const overlay = document.createElement('div');
    overlay.id = CFG.wikiId;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483645',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'rgba(0,0,0,0.88)',
      backdropFilter: 'blur(6px)',
    });

    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#111',
      border: '1px solid rgba(245,197,24,0.4)',
      borderRadius: '14px',
      width: 'min(600px, 92vw)',
      maxHeight: '82vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: 'sans-serif',
      boxShadow: '0 24px 80px rgba(0,0,0,0.9)',
    });

    // ── Header ──────────────────────────────────────────────────────────────
    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '14px 18px 10px',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexShrink: '0',
      gap: '8px',
    });
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    Object.assign(titleEl.style, {
      color: '#f5c518',
      fontWeight: 'bold',
      fontSize: '15px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      flexShrink: '1',
    });
    const closeHint = document.createElement('span');
    closeHint.textContent = 'B · close';
    Object.assign(closeHint.style, {
      color: '#555',
      fontSize: '10px',
      fontFamily: 'monospace',
      flexShrink: '0',
    });
    header.append(titleEl, closeHint);

    // ── Scroll area ─────────────────────────────────────────────────────────
    const scroll = document.createElement('div');
    Object.assign(scroll.style, {
      overflowY: 'auto',
      padding: '16px 18px',
      flexGrow: '1',
      scrollbarWidth: 'thin',
      scrollbarColor: '#333 #111',
    });
    wikiScrollEl = scroll;

    const loading = document.createElement('p');
    loading.textContent = 'Loading…';
    Object.assign(loading.style, { color: '#888', textAlign: 'center', padding: '20px 0', margin: '0' });
    scroll.appendChild(loading);

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      padding: '10px 18px 14px',
      borderTop: '1px solid rgba(255,255,255,0.1)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: '10px',
      flexShrink: '0',
    });

    const openBtn = document.createElement('button');
    openBtn.id = CFG.wikiId + '-open';
    openBtn.textContent = 'Open in Wikipedia ↗';
    Object.assign(openBtn.style, {
      background: '#1c1c1c',
      color: '#666',
      border: '1px solid #333',
      borderRadius: '20px',
      padding: '8px 16px',
      fontSize: '12px',
      cursor: 'pointer',
      transition: 'color 0.15s, border-color 0.15s',
    });
    openBtn.addEventListener('mouseenter', () => { openBtn.style.color = '#fff'; openBtn.style.borderColor = '#888'; });
    openBtn.addEventListener('mouseleave', () => { openBtn.style.color = openBtn.dataset.loaded ? '#ddd' : '#666'; openBtn.style.borderColor = openBtn.dataset.loaded ? '#666' : '#333'; });

    const scrollHint = document.createElement('span');
    scrollHint.textContent = 'LB·RB  scroll';
    Object.assign(scrollHint.style, { color: '#444', fontSize: '10px', fontFamily: 'monospace', flexShrink: '0' });

    const closeBtn = document.createElement('button');
    closeBtn.id = CFG.wikiId + '-close';
    closeBtn.textContent = 'Close';
    Object.assign(closeBtn.style, {
      background: '#f5c518',
      color: '#000',
      border: 'none',
      borderRadius: '20px',
      padding: '8px 24px',
      fontSize: '12px',
      fontWeight: 'bold',
      cursor: 'pointer',
      transition: 'background 0.15s',
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = '#ffd84d'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = '#f5c518'; });

    footer.append(openBtn, scrollHint, closeBtn);

    // ── Dismiss logic ────────────────────────────────────────────────────────
    function dismiss() {
      overlay.remove();
      dismissWiki = null;
      wikiScrollEl = null;
      if (focusedEl && !document.body.contains(focusedEl)) focusedEl = null;
    }
    dismissWiki = dismiss;
    closeBtn.addEventListener('click', dismiss);
    overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(); });

    box.append(header, scroll, footer);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Auto-focus close button so pressing A immediately dismisses
    setFocus(closeBtn);

    // ── Fetch full Wikipedia article (Action API, CORS-safe) ─────────────────
    fetch(apiUrl)
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(data => {
        if (!document.body.contains(overlay)) return;
        if (data.error) throw new Error(data.error.info);
        scroll.innerHTML = '';

        const parse = data.parse;
        const articleUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(parse.title || title)}`;

        // Lead image: first image from the article that looks like a real photo
        const leadImg = (parse.images || []).find(
          n => /\.(jpe?g|png|gif|webp|svg)$/i.test(n) &&
               !/flag|coa|coat|arms|logo|icon|symbol|signature|map|blank/i.test(n)
        );
        if (leadImg) {
          const img = document.createElement('img');
          img.alt = leadImg;
          img.src = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(leadImg)}?width=320`;
          Object.assign(img.style, {
            float: 'right',
            marginLeft: '14px',
            marginBottom: '8px',
            maxWidth: '160px',
            maxHeight: '160px',
            objectFit: 'cover',
            borderRadius: '8px',
            border: '1px solid rgba(255,255,255,0.1)',
          });
          scroll.appendChild(img);
        }

        // Scoped styles for rendered Wikipedia HTML
        if (!document.getElementById('gp-wiki-style')) {
          const styleEl = document.createElement('style');
          styleEl.id = 'gp-wiki-style';
          styleEl.textContent = `
            .gp-wiki-content { color: #ddd; font-size: 13px; line-height: 1.75; }
            .gp-wiki-content p { margin: 0 0 10px; }
            .gp-wiki-content b { color: #fff; }
            .gp-wiki-content a { color: #79b8f3; text-decoration: underline; }
            .gp-wiki-content ul, .gp-wiki-content ol { margin: 0 0 10px; padding-left: 20px; }
            .gp-wiki-content li { margin-bottom: 3px; }
            .gp-wiki-content sup, .gp-wiki-content sub { font-size: 10px; }
            .gp-wiki-content h2, .gp-wiki-content h3 {
              color: #f5c518; font-size: 13px; font-weight: bold;
              margin: 18px 0 6px; padding-bottom: 4px;
              border-bottom: 1px solid rgba(245,197,24,0.2);
            }
            .gp-wiki-content table, .gp-wiki-content figure,
            .gp-wiki-content .thumb, .gp-wiki-content .infobox,
            .gp-wiki-content .infobox-subbox, .gp-wiki-content .navbox,
            .gp-wiki-content .mw-editsection, .gp-wiki-content .reflist,
            .gp-wiki-content .mbox, .gp-wiki-content .hatnote,
            .gp-wiki-content .sistersitebox, .gp-wiki-content .metadata,
            .gp-wiki-content .noprint { display: none; }
          `;
          document.head.appendChild(styleEl);
        }

        const content = document.createElement('div');
        content.className = 'gp-wiki-content';
        content.innerHTML = parse.text['*'];

        // Fix relative links → absolute, new tab
        for (const a of content.querySelectorAll('a')) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          const href = a.getAttribute('href');
          if (href && href.startsWith('/')) {
            a.href = `https://${lang}.wikipedia.org${href}`;
          }
        }

        // Strip noisy elements
        for (const el of content.querySelectorAll(
          '.mw-editsection, .reflist, .navbox, .mbox, .hatnote,' +
          '.sistersitebox, .metadata, .noprint, [role="note"],' +
          'table, figure, .thumb, .infobox, .infobox-subbox'
        )) { el.remove(); }

        scroll.appendChild(content);

        openBtn.dataset.loaded = '1';
        openBtn.style.color = '#ddd';
        openBtn.style.borderColor = '#666';
        openBtn.addEventListener('click', () => { window.open(articleUrl, '_blank', 'noopener,noreferrer'); dismiss(); });
      })
      .catch(() => {
        if (!document.body.contains(overlay)) return;
        scroll.innerHTML = '';
        const err = document.createElement('p');
        err.textContent = 'Could not load article.';
        Object.assign(err.style, { color: '#888', textAlign: 'center', padding: '20px 0', margin: '0', fontSize: '13px' });
        scroll.appendChild(err);
        const articleUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`;
        openBtn.dataset.loaded = '1';
        openBtn.style.color = '#ddd';
        openBtn.style.borderColor = '#666';
        openBtn.addEventListener('click', () => { window.open(articleUrl, '_blank', 'noopener,noreferrer'); dismiss(); });
      });
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
        // Resolve whether the focused element IS a card or is a child of one.
        // getCardContainer walks up from parentElement, so use focusedEl directly
        // when it is already the card container.
        const cardEl = isCardContainer(focusedEl)
          ? focusedEl
          : getCardContainer(focusedEl);
        if (cardEl) {
          // Any data-no-stack-swipe button inside a card (i-info, favorites, etc.)
          // should always trigger its own native click action.
          if (focusedEl !== cardEl && focusedEl.dataset.noStackSwipe === '1') {
            clickElement(focusedEl);
          // If the card's stats/info panel is open, click the card to close it.
          } else if (cardEl.dataset.cardInfoOpen === '1') {
            clickElement(cardEl);
          } else {
            // Card container or any other non-special card child → wiki overlay
            const t = getCardTitle(cardEl);
            if (t) { openWikiOverlay(t); }
          }
        } else {
          // Last-resort fallback: if the element contains a card title it's likely
          // a card container that slipped past isCardContainer detection — open the
          // wiki modal instead of blindly firing a click that could open Wikipedia
          // in a new tab via the game's own card handler.
          const t = getCardTitle(focusedEl);
          if (t) { openWikiOverlay(t); } else { clickElement(focusedEl); }
        }
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

    // ── Y — card info panel for focused or front card ────────────────────────
    if (wasJustPressed(gp, BTN.Y)) {
      let cardEl = null;
      if (focusedEl) {
        cardEl = isCardContainer(focusedEl) ? focusedEl : getCardContainer(focusedEl);
      }
      if (!cardEl) cardEl = getFrontCard();
      if (cardEl) {
        const infoBtn = getCardInfoButton(cardEl);
        if (infoBtn) clickElement(infoBtn);
      }
    }

    // ── RT — favorite / unfavorite focused or front card ────────────────────
    if (wasJustPressed(gp, BTN.RT)) {
      let cardEl = null;
      if (focusedEl) {
        cardEl = isCardContainer(focusedEl) ? focusedEl : getCardContainer(focusedEl);
      }
      if (!cardEl) cardEl = getFrontCard();
      if (cardEl) {
        const favBtn = getCardFavButton(cardEl);
        if (favBtn) clickElement(favBtn);
      }
    }

    // ── SELECT — toggle HUD ──────────────────────────────────────────────────
    if (wasJustPressed(gp, BTN.SELECT)) {
      toggleHud();
    }

    // ── LT — open Wikipedia overlay for focused or front card ───────────────
    if (wasJustPressed(gp, BTN.LT)) {
      let cardEl = null;
      if (focusedEl) {
        cardEl = isCardContainer(focusedEl) ? focusedEl : getCardContainer(focusedEl);
      }
      if (!cardEl) cardEl = getFrontCard();
      if (cardEl) {
        const t = getCardTitle(cardEl);
        if (t) openWikiOverlay(t);
      }
    }

    // ── LB / RB — scroll wiki overlay OR page navigation on results screen ──
    if (wasJustPressed(gp, BTN.LB)) {
      if (wikiScrollEl) {
        wikiScrollEl.scrollBy({ top: -160, behavior: 'smooth' });
      } else {
        const btn = detectScene() === 'results' ? findPageNavButton('prev') : null;
        if (btn) { setFocus(btn); clickElement(btn); }
      }
    }

    if (wasJustPressed(gp, BTN.RB)) {
      if (wikiScrollEl) {
        wikiScrollEl.scrollBy({ top: 160, behavior: 'smooth' });
      } else {
        const btn = detectScene() === 'results' ? findPageNavButton('next') : null;
        if (btn) { setFocus(btn); clickElement(btn); }
      }
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
        <tr><td class="gp-btn">A</td><td>Confirm / Wiki</td></tr>
        <tr><td class="gp-btn">B</td><td>Close / Back</td></tr>
        <tr><td class="gp-btn">X</td><td>Open pack</td></tr>
        <tr><td class="gp-btn">Y</td><td>Card info</td></tr>
        <tr><td class="gp-btn">RT</td><td>Favorite card</td></tr>
        <tr><td class="gp-btn">LT</td><td>Wiki article</td></tr>
        <tr><td class="gp-btn">LB·RB</td><td>Page · Scroll</td></tr>
        <tr><td class="gp-btn">SELECT</td><td>Toggle HUD</td></tr>
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
