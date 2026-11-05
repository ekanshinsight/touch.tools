# Project Submission Brief

**Project:** a browser-based touch controller that turns any phone or tablet on the same Wi-Fi into a working mouse, keyboard, macro pad and live screen viewer for a Windows PC.

**Author:** Ekansh
**Licence:** All rights reserved - see `Copyright.md`
**Status:** working prototype in daily personal use; submitted as a startup ideation and teaser, not a finished product
**Date:** 2026-11-05

---

## 1. One paragraph

Open one web address on a phone or tablet and that device becomes a controller for the PC. No app store, no installer, no account, no cloud. The PC runs a single Python server; the phone runs a page in its normal browser. Dragging a finger moves the cursor, tapping clicks, two fingers scroll, a modifier row makes shortcuts, the on-screen keyboard types straight into the PC, and an optional strip at the top of the screen shows the PC's actual display with the real cursor baked in. Drawn shapes fire actions - a circle triggers Ctrl+I, a V fires Ctrl+Alt+S - and a custom button bank holds the editing shortcuts that matter most. Everything stays on the local network.

---

## 2. The problem it answers

The people this is built for are editors, designers and developers who work at a desk all day. Two things get in the way:

1. **The desk is the only place work can happen.** A timeline scrub, a render check, a quick keyboard shortcut - all of it requires being physically at the machine. Stepping away means stopping.
2. **The existing remote tools ask too much before they give anything.** Remote desktop suites want an installer on both sides, an account, and often a cloud relay. Screenshare-first tools are built around viewing, not around input. Game streaming tools work brilliantly but assume a gaming PC, GPU encoding and a client app.

The gap is not "control a computer remotely". It is "control a computer from two metres away, in thirty seconds, with nothing to install".

---

## 3. What the prototype actually does today

Everything below is running code in the current build, not a plan. The evidence column points at the file that proves it.

| Capability | Detail | Evidence |
|---|---|---|
| Zero-install client | The phone opens one URL. No app, no account, no pairing dance. An optional PIN exists and is off by default. | `server.py` serves the UI; `README.md` Quick start |
| Real mouse injection | Cursor movement, left / right / middle click, click-and-hold, drag | `pynput` mouse controller in `server.py` |
| Real keyboard injection | Modifiers, full key matrix, live typing from the phone's own keyboard | `pynput` keyboard controller in `server.py` |
| WebSocket control channel | Actions are dispatched over a persistent socket, not polling | port 8856, `runAction` in `web/app.js` |
| Taps as clicks | One-finger tap, two-finger tap, three-finger tap | `web/app.js` |
| Hold column | L / M / R plus Space / Enter / Backspace as half-height buttons flanking the pad | `README.md` layout section |
| Scroll, three ways | Two-finger slide, a scroll dial, and hands-free autoscroll | `web/app.js` |
| Pan mode | Double-tap middle button holds it down so dragging pans a zoomed preview | `web/app.js` |
| Precision mode | Instant slow-down for fine adjustment | `web/app.js` |
| Gesture mode | Draw a shape on the pad; it fires on lift without moving the cursor, so nothing in the target app gets hovered or triggered | `web/app.js` recognizers |
| Three built-in gestures | Circle, V, and a notepad launch, each remappable | `DEFAULT_GESTURES` in `web/app.js` |
| Custom macro bank | A JSON-driven bank of labelled buttons: key combos, typed text, clicks, scrolls | `web/buttons.json`, editable in-app |
| Profiles | Save, name, export and import whole setups as JSON | `README.md` Customize section |
| Live screen strip | The PC screen streams into a 16:9 strip at the top, with the real cursor drawn into every frame | `/api/screen`, `mss` + Pillow MJPEG |
| Adaptive stream quality | Low / Med / High, with automatic quality and resolution drop when the link falls behind | `README.md` screen streaming section |
| Safety behaviour | Every held key and button is released if the phone disconnects | `server.py` release-all |
| Privacy default | LAN-bound, capture only while the viewer is open, no file access | `README.md` security notes |
| Gesture recording lab | Records and labels strokes, exports versioned JSON | `web/gesture-lab.html` |

---

## 4. The gesture layer - and the honest state of the AI part

This is the part of the concept that needs precise wording, because it is where a concept usually overreaches.

**What exists.** A gesture recording lab captures up to ten simultaneous fingers. Every point is stored normalised to the canvas as `[x, y, time]`, alongside per-stroke metadata: finger count, duration, per-finger down/up times, stagger between fingers, hold times, travel distance, and canvas size and orientation. Strokes are labelled by the user and exported as a versioned JSON file. The live trackpad runs three deterministic geometric recognisers and dispatches the match to an action.

**What does not exist yet.** There is no trained gesture model and no per-stroke inference. The recognition is rule-based geometry: resample, smooth, simplify, match against fixed thresholds - now including any shape taught in the Train panel, which is condensed to a handful of local templates.

**What the model is actually used for, today.** One scoped call, inside Train step 3: a plain-language sentence goes to the configured endpoint and comes back as one action the PC can run (the ~22-action menu needs no key and no network). That path is shipped, wrapper and all; a **Save & test** button proves the key before use. What is not shipped is a model that classifies raw strokes - that stays the next milestone, and the recorder already produces exactly the dataset it would need.

**Why that is still the interesting part.** The recorder already produces exactly the dataset a model would need - normalised vectors with timing, not raw pixels. The reason it matters is that rule-based recognisers cannot scale past a handful of shapes without becoming a pile of thresholds, while a model can learn arbitrary personal gestures from twenty or thirty examples each.

**The integration contract.** The gesture bridge is deliberately a separate, replaceable piece. It receives one labelled or unlabelled stroke as compact JSON and returns one macro decision. Any provider can sit behind it as long as it can follow that contract:

```
in:   { "points": [[x, y, t], ...], "fingers": n, "durationMs": d,
        "canvas": { "w": w, "h": h, "portrait": bool } }
out:  { "gesture": "name", "action": { "keys": ["ctrl","i"] },
        "confidence": 0.0-1.0 }
```

Because the contract is fixed, the same gesture engine can run against a local rule set today and against a hosted model tomorrow, without touching the trackpad, the macro bank or the server.

---

## 5. The provider layer

The connector is built to speak more than one dialect, so the project is not tied to a single vendor:

| Provider path | Wire style | State in this submission |
|---|---|---|
| Meta Model API | messages endpoint with a bearer key | Named as the supported path; currently blocked by an account billing hold, so the built-in shape matcher is the demo path |
| messages-style endpoint | `x-api-key` plus version header | Supported by the connector design, no key in this build |
| chat-style endpoint | `Authorization: Bearer` | Supported by the connector design, no key in this build |

Keys are never stored in the repository. The published code reads a base URL, a model name and a key from environment variables, and ships an example file with the values blank.

**Why this matters commercially.** The gesture layer is the valuable part; the model is a swappable component. A user with their own key plugs in their provider. That is the difference between a product and a demo that dies when one account lapses.

---

## 6. What I deliberately do not claim

Honesty is part of the submission, so these are stated plainly:

- **No latency number is claimed.** The stream is described qualitatively and the README's own 30-80 ms figure is an estimate from use, not a benchmark. No input-latency claim is made at all.
- **No market statistic is quoted.** The problem statement is described, not decorated with percentages I cannot source.
- **"AI gestures" is not claimed as shipped.** What ships is the sentence-to-action step inside Train and the recorder that produces a model-ready dataset; a model that classifies raw strokes is the next milestone.
- **The build is Windows-only.** The server injects input through Windows APIs. A macOS or Linux port is not started.
- **No file transfer, no internet access.** Both are on the roadmap and neither is built.

---

## 7. How it compares - honestly

| Tool | What it does | Where this project stands |
|---|---|---|
| **Weylus** | Browser-based phone/tablet touchpad, keyboard, stylus and screen view for a PC over LAN | Closest neighbour and more mature. The real differentiators here are the macro bank, the gesture-to-action layer, and the editor-oriented layout - not the basic trackpad, which Weylus already does well |
| **Deskreen** | Turns a phone or tablet browser into a second screen for a PC | Different job: Deskreen extends the display and does not control the PC. This project controls it |
| **KDE Connect** | Full phone-PC suite: notifications, file share, media, touchpad remote | Broader, but it needs an app on both sides and a pairing flow. This one is a single URL and a QR code |
| **Sunshine + Moonlight** | Low-latency GPU game streaming from PC to a client app | Far better at streaming. This project is deliberately lighter: no GPU, no client app, simple control as the primary job |
| **scrcpy / ws-scrcpy** | Controls an Android phone from a PC over ADB | Opposite direction - PC to phone, not phone to PC |
| **Barrier / Input Leap** | Shares one keyboard and mouse across several computers | Different problem: computer-to-computer, not phone-as-controller |

**The honest position:** the basic trackpad-plus-preview idea is not novel - Weylus got there first and is more complete. The novel piece is the layer above it: gesture and macro composition, tuned for the way an editor actually works, with a dataset pipeline that lets a user teach the machine their own shapes.

---

## 8. Roadmap, in the order it would be built

1. **Gesture bridge against a live provider.** Take the recorded dataset, call the model through the contract above, return a macro. This is the milestone that turns the concept into the demo.
2. **Per-user gesture training.** Twenty samples per shape, stored locally, so a new user teaches the system without touching code.
3. **File and clipboard transfer** between phone and PC over the same socket.
4. **Internet access with real authentication** - needed before anything leaves the LAN, and deliberately last.
5. **Packaging** as an installable web app, then a desktop wrapper for the PC side.

---

## 9. Why it deserves a place

Most remote-control tools are built for seeing a computer from far away. This one is built for the two metres between a chair and a desk - the distance where a real person actually reaches for their phone instead of standing up. It runs with nothing installed, keeps everything on the local network, and treats gestures and macros as first-class input rather than an afterthought.

The prototype is real enough to touch, small enough to read, and honest about what is finished.

---

*Full feature inventory: `04-FEATURE-INVENTORY.md`. Spoken video script: `02-VIDEO-SCRIPT.md`. Repository plan and key-safety: `05-REPO-PLAN.md`.*
