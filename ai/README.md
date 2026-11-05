# The gesture bridge

This folder holds the contract between the controller and a language model. Nothing here calls a provider yet - it is the shape the next milestone implements.

## Why a contract at all

The trackpad, the macro bank and the server must not care which model answers. If the model is swappable, a user can bring their own key, and the project survives one provider changing its pricing or shutting down.

## The contract

**Request**

```json
{
  "points": [[0.51, 0.22, 0], [0.55, 0.24, 16], [0.61, 0.31, 33]],
  "fingers": 1,
  "durationMs": 420,
  "canvas": { "w": 900, "h": 1200, "portrait": true }
}
```

`points` are normalised to the canvas, in the range 0 to 1, with the third value in milliseconds since the stroke began. This is exactly what `gesture-lab.html` already stores, so a recorded dataset needs no conversion.

**Response**

```json
{
  "gesture": "circle",
  "action": { "keys": ["ctrl", "i"] },
  "confidence": 0.91
}
```

`action` uses the same object the client already sends over the socket: `keys`, `text`, `click`, `scroll` or `launch`. Nothing downstream needs to change.

## Rules

1. The model never executes anything. It returns a decision; the server executes it.
2. A confidence below the user's threshold falls back to the rule-based recogniser.
3. If the provider fails, times out or returns malformed JSON, the controller keeps working - the model is an upgrade, never a dependency.
4. The key comes from `.env`. The bridge never writes it anywhere else and never logs it.

## Why this shape and not an image

Sending a screenshot to a vision model would be slower and more expensive per gesture, and it would leak the user's screen. Normalised vectors are a few hundred bytes, carry the timing that separates a tap from a hold, and reveal nothing about what is on the display.
