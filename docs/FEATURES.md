# Feature inventory - what is built, what is not

Status key: **built** (working in the current build) - **built, untested** (exists, never exercised end to end) - **partial** - **planned** (designed, no code) - **not started**.

---

## 1. Connection and delivery

| Feature | Detail | Status | Evidence |
|---|---|---|---|
| One-URL access | The phone opens an address; no install, no account | built | `server.py` serves the UI |
| QR pairing | The console prints a QR code pointing at the LAN address | built | `qrcode` import in `server.py`, `/api/qr` |
| Optional PIN | Numeric PIN in `config.json`, off by default | built | `config.json` |
| Address discovery | `/api/info` returns name, ports and all local addresses | built | live response confirmed 2026-11-05 |
| PWA shell | Add-to-home-screen, service worker | built | `manifest.json`, `sw.js` |
| Internet access | Reach the PC from outside the LAN | not started | `README.md` roadmap - needs auth first |

## 2. Pointer control

| Feature | Detail | Status |
|---|---|---|
| Cursor movement | Drag on the pad | built |
| Left / right / middle click | 1 / 2 / 3 finger tap | built |
| Click and hold | Dedicated L / R hold buttons in the 44 px flanking column | built |
| Drag toggle | DG button, or press and hold still | built |
| Scroll | Two-finger slide, scroll dial, or hands-free autoscroll | built |
| Autoscroll | Tap M, then move to set direction; it keeps scrolling | built |
| Pan mode | Double-tap M holds the middle button so dragging pans a zoomed preview | built |
| Sensitivity | 0-150 slider, default 150, saved on the device | built |
| Precision mode | Halve the cursor speed instantly | built |
| Orientation-aware layout | Hold column flips sides between portrait and landscape | built |

## 3. Keyboard and shortcuts

| Feature | Detail | Status |
|---|---|---|
| Live typing | The device's own keyboard types straight into the PC | built |
| Compose mode | Type first, send on confirm | built |
| Modifiers | CTRL, SHIFT, ALT, WIN as toggles | built |
| Key matrix | ESC, TAB, arrows, DEL, space, enter, backspace, page keys, F1-F12 | built |
| Repeat on hold | Arrows, DEL, space and volume keys repeat like a real keyboard | built |
| Volume keys | Step the PC system volume, hold to repeat | built |
| Button bank | JSON-driven labelled buttons: key combos, text, click, scroll | built |
| In-app button editing | Add, edit, delete from the device | built |
| Restore safety net | Predefined sections are re-added automatically if deleted | built |
| Profiles | Save, rename, switch, export, import as JSON | built |
| Release-all | Every held key is released on disconnect | built |

## 4. Screen viewing

| Feature | Detail | Status |
|---|---|---|
| Live screen strip | 16:9 MJPEG strip at the top, portrait only | built |
| Cursor composited | The real cursor is drawn into each frame | built |
| Quality tiers | Low 854 px / q50 / 20 fps; Med 1280 / q70 / 24; High 1920 / q80 / 30 | built |
| Adaptive bitrate | Drops quality then width when frames arrive late | built |
| Capture only while watching | No work at all when the strip is hidden | built |
| Fullscreen | Hides browser chrome | built |
| Viewer-side input | Controlling from inside the streamed image | not started |

## 5. Gestures

| Feature | Detail | Status |
|---|---|---|
| Gesture mode | Draw without moving the cursor | built |
| Circle | Fires Ctrl+I by default, remappable | built |
| V | Fires Ctrl+Alt+S by default, remappable | built |
| Notepad | Launches an app | built |
| Taps and hold | 1 / 2 / 3 tap and press-and-hold actions | built |
| Gesture recording lab | Record, label, export | built |
| Multi-finger capture | Up to 10 fingers with stagger and hold timing | built |
| Normalised dataset export | Versioned JSON with canvas metadata | built |
| Model-based recognition | A provider answering through a fixed contract | planned |
| Per-user training | Learn new shapes from 20-30 samples | planned |

## 6. Privacy and safety

| Feature | Detail | Status |
|---|---|---|
| LAN-only by default | Binds to the local network | built |
| Opt-in capture | Screen work only while the viewer is open | built |
| No file access | Input injection only | built |
| Release on disconnect | No stuck keys | built |
| PIN | Optional, off | built |
| Auth for remote access | Needed before any internet exposure | not started |

## 7. AI and provider layer

| Feature | Detail | Status |
|---|---|---|
| Describe-to-action | Train step 3: one sentence in, one PC action out | built |
| Meta Model API adapter | Bearer key, messages endpoint | built (same call path as below); the account used for demos is currently billing-blocked |
| Messages-style endpoint adapter | `x-api-key` plus version header | built |
| Chat-style endpoint adapter | Bearer token | built |
| Bring-your-own-key | In-app setup, stored only in that device's browser; blank example file for the server | built |
| Ready-made action menu | ~22 actions, no key needed | built |
| Rule-based fallback | Works with no key at all | built (this is the current recogniser) |

## 8. Known limitations, stated plainly

- Windows only. The input injection layer is Windows-specific.
- Three gestures. Rule-based recognition cannot grow past a handful without a model.
- The recogniser sees raw pixels while the lab stores normalised points, so a gesture recorded in the lab does not automatically work on the live pad - that bridge is part of the model milestone.
- No measurement harness. The project has a layout harness and a trace log, not a latency benchmark.
- No file or clipboard transfer.
- No multi-user support: one controller drives one PC.

---

## What this inventory is for

If someone asks "is X real", this table answers it without sales language. Anything marked planned or not started should be described as a roadmap item in any public material.
