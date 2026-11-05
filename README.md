# Touch Tools

Turn any phone or tablet on your Wi-Fi into a mouse, keyboard, macro pad and screen viewer for a Windows PC. No app to install, no account, no cloud.

Open one address in the phone's browser. That's the setup.

![status](https://img.shields.io/badge/status-prototype-orange)

---

## What it does

| | |
|---|---|
| **Trackpad** | Drag to move, one tap left click, two fingers right click, three fingers middle click |
| **Typing** | The phone's own keyboard types straight into the PC |
| **Shortcuts** | CTRL / SHIFT / ALT / WIN as toggles, then a key |
| **Macro bank** | A JSON-driven panel of labelled buttons: key combos, text, clicks, scrolls |
| **Profiles** | Save, name, export and import whole layouts |
| **Gestures** | Draw a shape on the pad; it fires an action without moving the cursor |
| **Screen strip** | Optional live view of the PC screen with the real cursor drawn in |
| **Gesture lab** | Record and label your own strokes, export them as a dataset |

Everything stays on your local network.

---

## Requirements

- Windows PC (the input injection is Windows-specific)
- Python 3.9 or newer
- A phone or tablet on the same Wi-Fi as the PC

---

## Run it

> **New here? Follow [`SETUP.md`](SETUP.md) - a ten-minute step-by-step guide written for someone who has never opened a terminal.**

```bash
git clone <this repo>
cd touch-tools
pip install -r requirements.txt
copy config.example.json config.json
python server.py
```

The console prints the address to open on your phone, plus a QR code you can scan.

**The address is different on every computer** - it is your PC's own network address. Read it from the banner each time you start; do not copy it from anyone else's setup.

If Windows Firewall asks about Python, allow it on the private network.

---

## Configure

`config.json` (create it from the example):

```json
{
  "host": "0.0.0.0",
  "http_port": 8855,
  "ws_port": 8856,
  "pin": "",
  "launch": { "notepad": "notepad.exe" }
}
```

- `pin` - set a number if other people share your Wi-Fi. Leave empty to connect without a prompt.
- `launch` - name to program path, used by the launch buttons.

Your own buttons live in `web/buttons.json`:

```json
{ "label": "Save", "action": { "keys": ["ctrl", "s"] } }
{ "label": "Say hi", "action": { "text": "hello" } }
{ "label": "Scroll down", "action": { "scroll": [0, -1] } }
```

---

## Pages

| Page | Purpose |
|---|---|
| `/` | The controller |
| `/gesture-lab.html` | Record and label gestures, export JSON |
| `/test-gesture.html` | Diagnostics: shows why a drawn shape did or did not match |

---

## The AI piece - what is real and what is not

**Real, in the app today:** step 3 of the Train panel. The key setup sits right under the describe box - choose **Meta Model API**, **OpenCode Go**, or an endpoint you own, paste a key once, and type what the gesture should do - "open the calculator". One scoped call turns that sentence into one action the PC can run, and **Save & test** proves the key works before you rely on it. With no key at all, the ~22 ready-made actions still work completely offline.

**Real:** the gesture lab captures up to ten fingers as normalised `[x, y, time]` points with per-finger timing, stagger, hold and travel, and exports a versioned JSON dataset. That is the input a gesture model needs.

**Not real yet:** the shape itself is still not a model. Recognition is geometry - three hand-written shapes plus any shapes you teach it in Train, matched locally on the device, in milliseconds, with no network.

**Designed, not shipped:** the server-side bridge in `ai/` - one fixed contract in, one macro decision out, so a model can classify raw strokes later without touching the trackpad or the server.

```
in:   { "points": [[x, y, t], ...], "fingers": n, "durationMs": d,
        "canvas": { "w": w, "h": h, "portrait": bool } }
out:  { "gesture": "name", "action": { "keys": ["ctrl","i"] },
        "confidence": 0.0-1.0 }
```

Providers the in-app bridge speaks: the Meta Model API, plus a messages-style or chat-style endpoint you own. A key typed into the panel is stored only in that device's browser - see `.env.example` for the server-side shape. **No key is ever committed to this repository.**

---

## What is coming

This build is the honest first version. The next ones add the parts that make it genuinely different.

**Free and low-cost model tiers.** The gesture bridge is provider-agnostic on purpose. Upcoming versions will ship ready-made adapters for free-tier and low-cost models, so a user can turn on AI gesture mapping without a paid plan - the Muse family through the Meta Model API, and any endpoint you already pay for. Switching is one line in `.env`; no code changes.

**A hosted web version.** Today you run it yourself. A hosted version is planned, where the client is just a page and the PC side pairs with a short code - still local-first, still no account for the basic controller.

**Teaching gestures from the app.** Right now the lab records a dataset and a person has to wire it up. The next version lets you record thirty samples of your own shape on the phone and use it immediately, with no file handling and no editing.

**More of the ideas already started but not yet shipped:**

- Clipboard and file transfer over the same socket
- In-app provider chooser, with a cost estimate per gesture before you enable it
- Multi-device control - one PC, several phones, separate profiles
- macOS and Linux input backends
- A packaged desktop build for the PC side, so there is no terminal at all

The design rule that will not change: **the model is always optional.** If a provider is down, out of credit, or removed, the controller keeps working on its built-in recognition.

---

## Honest limitations

- Windows only.
- Three built-in gestures plus any shape you teach it in Train, matched geometrically - it does not learn from behaviour.
- The model is used for one thing: turning a plain-language sentence into an action. It does not classify strokes.
- No latency benchmark exists. Do not treat any latency figure as measured.
- No file or clipboard transfer.
- No internet access - LAN only, by design, until authentication is solid.
- **Weylus** already does browser-based touchpad, keyboard and screen view well. If you want that and nothing else, use Weylus. What is different here is the macro bank and the gesture layer built for editing workflows.

---

## Privacy

- Binds to your local network.
- Screen capture runs only while the viewer is open.
- No file access - it only injects input.
- Every held key and button is released if the phone disconnects.

---

## Licence

All rights reserved. See `Copyright.md`.

Publishing it yourself? `docs/GITHUB-UPLOAD.md` has the click-by-click steps.
