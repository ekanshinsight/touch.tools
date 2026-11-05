# Roadmap

Ordered by what unlocks the next thing, not by what is easiest.

## 1. Gesture bridge against a live provider

Take a recorded stroke, call a provider through the contract in `ai/README.md`, return a macro. This is the milestone that turns the concept into a demo. The adapter shell already exists.

**Done when:** a shape drawn on the pad, that no rule recogniser knows, fires a macro because the model mapped it.

## 2. Per-user gesture training

Twenty to thirty samples per shape, stored locally, so a new user teaches the system without touching code or a dataset file.

**Done when:** a user records five of their own shapes in the lab and uses them on the pad without editing anything.

## 3. File and clipboard transfer

Over the socket that already exists. Clipboard first - it is the smaller surface and the one people miss.

## 4. Internet access with real authentication

Deliberately last. The moment the port is reachable from outside the LAN, every safety property in this project has to be re-proven.

## 5. Packaging

Installable web app first; a PC-side wrapper (tray icon, autostart, no console) after that.

---

## Known gaps that are not on this list yet

- macOS and Linux input injection.
- Multi-controller support (two phones, one PC).
- A latency benchmark harness.
