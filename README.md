# WikiGacha Gamepad Support

A userscript that adds full gamepad controller support to [WikiGacha](https://wikigacha.com) — open packs, flip through cards, dismiss dialogs, and navigate the whole site without touching a keyboard or mouse.

## Features

- **Spatial navigation** — d-pad and left stick move focus between interactive elements on screen
- **Scene-aware controls** — dedicated card-flip on the results screen; direct pack-open shortcut on the gacha screen
- **Page navigation** — LB / RB page through the card results (1/5, 2/5 …)
- **Gamepad-friendly alert dialog** — replaces the native browser `alert()` with a styled overlay that can be dismissed with A or B
- **On-screen HUD** — shows the button map; toggle it with Y
- **Auto-connect** — detects controllers already plugged in when the page loads; reconnects on replug
- **Touch-event passthrough** — fires `touchstart`/`touchend` in addition to `click` so mobile-targeted React handlers respond correctly

## Button Map

| Button | Action |
|--------|--------|
| **A** (Cross) | Confirm / click focused element |
| **B** (Circle) | Close dialog / go back |
| **X** (Square) | Open pack (shortcut) |
| **Y** (Triangle) | Toggle HUD |
| **LB / RB** | Previous / next results page |
| **D-pad / Left stick** | Spatial navigation (results screen: flip cards) |

## Installation

1. Install a userscript manager — [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) are both supported.
2. Click **[Install script](https://raw.githubusercontent.com/kksoftwareag/WikiGacha-gamepad/main/wikigacha-gamepad.user.js)** — your manager will prompt you to confirm.
3. Open [wikigacha.com](https://wikigacha.com) and plug in a controller.

### Manual install

Download [`wikigacha-gamepad.user.js`](wikigacha-gamepad.user.js) and drag it onto the Tampermonkey / Violentmonkey dashboard.

## Compatibility

| Controller | Tested |
|------------|--------|
| Xbox Series / One (USB & Bluetooth) | ✅ |
| PlayStation 4 / 5 (USB & Bluetooth) | ✅ |
| Nintendo Switch Pro Controller (USB) | ✅ |
| Generic XInput / DirectInput | should work |

Requires a browser with the [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) — Chrome, Edge, Firefox, and Safari 16.4+ all qualify.

## Development

The script is a single self-contained IIFE with no build step or dependencies.

```
wikigacha-gamepad.user.js
```

To test locally, load the `.user.js` file directly in Tampermonkey's editor or use the file:// install method.

## Changelog

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
