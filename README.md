# WikiGacha Gamepad Support

A userscript that adds full gamepad controller support to [WikiGacha](https://wikigacha.com) — open packs, flip through cards, read Wikipedia articles, dismiss dialogs, and navigate the whole site without touching a keyboard or mouse.

## Features

- **Spatial navigation** — d-pad and left stick move focus between interactive elements on screen
- **Scene-aware controls** — dedicated card-flip on the results screen; direct pack-open shortcut on the gacha screen
- **Card focus & highlight** — navigate directly onto cards with a gold glow; all card actions are gamepad-accessible
- **Wikipedia article overlay** — open the full Wikipedia article for any focused card in a scrollable in-game overlay; links open in a new tab
- **Page navigation** — LB / RB page through card results (1/5, 2/5 …); LB / RB also scroll the article overlay when it is open
- **Gamepad-friendly alert dialog** — replaces the native browser `alert()` with a styled overlay that can be dismissed with A or B
- **On-screen HUD** — shows the button map; toggle it with Y
- **Auto-connect** — detects controllers already plugged in when the page loads; reconnects on replug
- **Touch-event passthrough** — fires `touchstart`/`touchend` in addition to `click` so mobile-targeted React handlers respond correctly

## Button Map

| Button | Action |
|--------|--------|
| **A** (Cross) | Confirm / click · open Wikipedia overlay for focused card |
| **B** (Circle) | Close overlay / dialog / stats panel / go back |
| **X** (Square) | Open pack (gacha screen only) |
| **Y** (Triangle) | Toggle HUD |
| **LT** (L2) | Open Wikipedia overlay for focused or front card |
| **LB / RB** | Prev/next results page · scroll article overlay |
| **D-pad / Left stick** | Spatial navigation (results screen: flip cards) |

### Card-specific behaviour
When a card is focused:
- **A** — opens the Wikipedia article overlay for that card
- **A** on the **`i`** button — opens the card's stats panel
- **A** on the **☆/★** button — adds/removes the card from favourites
- **B** — closes the stats panel if open

## Installation

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) are both supported.
2. Click **[Install script](https://raw.githubusercontent.com/bene987/WikiGacha-gamepad/main/wikigacha-gamepad.user.js)** — your manager will prompt you to confirm.
3. Open [wikigacha.com](https://wikigacha.com) and plug in a controller.

### Manual install

Download [`wikigacha-gamepad.user.js`](wikigacha-gamepad.user.js) and drag it onto the Tampermonkey / Violentmonkey dashboard.

## Compatibility

| Controller | Tested |
|------------|--------|
| Xbox Series / One (USB & Bluetooth) | ✅ |
| PlayStation 4 / 5 (USB & Bluetooth) | untested |
| Nintendo Switch Pro Controller (USB) | untested |
| Generic XInput / DirectInput | untested |

Any controller supported by the [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) should work. Requires Chrome, Edge, Firefox, or Safari 16.4+.

## Development

The script is a single self-contained IIFE with no build step or dependencies.

```
wikigacha-gamepad.user.js
```

To test locally, load the `.user.js` file directly in Tampermonkey's editor or use the file:// install method.

## Changelog

### 1.3.4
- **Card focus** — cards are now focusable with the d-pad/stick; focused cards receive a gold outline and glow
- **Wikipedia article overlay** — press **A** on a focused card or **LT** at any time to open a gamepad-friendly overlay showing the Wikipedia article summary; **LB/RB** scroll the text; **B** closes it
- **LB/RB** now dual-purpose: scroll the Wikipedia overlay when open, page through results when closed
- HUD updated to reflect new controls
- Navigation locked to overlay buttons while the overlay is open

### 1.2.0
- Replace native `alert()` with a gamepad-friendly custom overlay (A / B to dismiss, navigation locked to dialog while open)

### 1.1.0
- Scene detection (`gacha`, `results`, `generic`) for smarter behaviour per page
- `isInert()` filter excludes aria-hidden offscreen clones, pointer-events:none overlays, and the HUD itself from the focus pool
- Results screen: left/right d-pad flips cards directly; LB/RB pages through result sets
- `clickPackButton` targets `#gacha-pack-container` by ID
- `clickCloseButton` recognises "Back to Packs" and filters inert elements

### 1.0.0
- Initial release: spatial navigation, pack open shortcut, toast notifications, HUD

## License

MIT
