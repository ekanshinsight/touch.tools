# Architecture

Three parts, one connection.

```
 phone / tablet browser
        |
        |  HTTP 8855   - the page, the CSS, the JS, the screen stream
        |  WS   8856   - actions, one message at a time
        v
   server.py  (Python, Windows)
        |
        |  pynput        -> real mouse and keyboard
        |  mss + Pillow  -> JPEG frames of the primary monitor
        v
   the desktop
```

## Server

- `http.server` with a threaded handler serves `web/` and a small API.
- `websockets` accepts the control channel.
- `pynput` injects real Windows input. Cursor movement uses relative deltas, which is why it feels smoother than absolute-position remote tools.
- `mss` grabs the primary monitor; Pillow resizes and JPEG-encodes; the frames are pushed as an MJPEG stream so a plain `<img>` tag can display them with no codec on the phone.
- The real cursor is composited into each frame, because `mss` captures the screen but not the pointer.

## Client

- One page, no framework, no build step.
- Pointer events feed a trackpad model: movement, taps by finger count, holds, a scroll dial, a gesture dial.
- Drawings are matched by three geometric recognisers (`recognizeCircle`, `recognizeV`, `recognizeNotepad`) after smoothing, resampling and path simplification.
- A match becomes an action object - `keys`, `text`, `click`, `scroll`, `launch` - sent over the socket.
- `buttons.json` describes the macro bank; the profile, layout and preferences persist in `localStorage`.

## Endpoints

| Path | Purpose |
|---|---|
| `/` | the controller |
| `/gesture-lab.html` | recorder and labeller |
| `/test-gesture.html` | recogniser diagnostics |
| `/api/info` | name, ports, addresses |
| `/api/screen` | MJPEG stream |
| `/api/screeninfo` | monitor size |
| `/api/gesture-log` | recorded gesture log |
| `/api/traces` | diagnostic trace sink |
| `/api/qr` | pairing QR |

## Safety properties

- Every held key and button is released on disconnect.
- Screen capture only runs while a viewer is connected.
- No filesystem access is exposed.
- LAN-bound by default; a PIN is optional.

## Where the model fits

The client already produces a normalised stroke. The bridge in `ai/` takes that stroke, asks a provider, and returns the same action object the rules recogniser returns. Nothing above the bridge changes when a model is added, and nothing breaks when it is removed.
