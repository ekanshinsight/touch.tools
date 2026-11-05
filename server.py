#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Touch Tools server

Runs on the PC. Serves the tablet web UI over HTTP and accepts a WebSocket
control channel. Drives the real mouse & keyboard with pynput (native Win32
SendInput -> smooth RELATIVE cursor movement, avoiding the slow
GetCursorPos/SetCursorPos path that makes KDE Connect feel jittery).

  start.bat            one-click launch
  config.json          host / http_port / ws_port / pin
  web/buttons.json     editable button banks shown on the tablet's left panel

Protocol (client -> server, JSON):
  {"type":"hello","pin":"..."}        first message; server replies "welcome"
  {"type":"move","dx":float,"dy":float}   relative mouse move
  {"type":"click","button":"left|right|middle","action":"down|up"}
  {"type":"scroll","dx":float,"dy":float} wheel (dy>0 = scroll up)
  {"type":"key","key":"ctrl","action":"down|up"}   special key
  {"type":"char","char":"a"}           type one character (combines w/ held mods)
  {"type":"text","text":"hello"}       type a whole string
  {"type":"combo","keys":["ctrl","k"]} hold keys in order, release in reverse
  {"type":"release_all"}               safety: release every key & button
  {"type":"launch","name":"app"}       start an app/command configured in config.json
  {"type":"ping","t":...}              latency probe

Server -> client, JSON:
  {"type":"launch_result","name":...,"ok":bool,"error":str}  result of a launch
"""

import asyncio
import sys
# WinError-64 resilience (2026-08-30): Windows ProactorEventLoop accept dies with
# OSError(64) "The specified network name is no longer available" when a client
# resets mid-accept. Once that accept task dies, the WS port keeps LISTENING but no
# handshake ever completes (the app hangs at "Connecting..." forever) while HTTP
# keeps serving. The Selector loop retries transient accept errors instead of dying.
# Safe here: the server only uses TCP/WS sockets — no Proactor-only features
# (pipes / subprocess transports).
if sys.platform == "win32" and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
    try:
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    except Exception:
        pass
import ctypes
import ctypes.wintypes
import io
import json
import socket
import subprocess
import sys
import threading
import time
import uuid
import urllib.parse
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets

from pynput.keyboard import Controller as KbdController, Key
from pynput.mouse import Button, Controller as MouseController

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"          # the browser client
BKP2_WEB_DIR = ROOT / "web"     # legacy alias, kept so old bookmarks still resolve
CONFIG_PATH = ROOT / "config.json"
TRACES_LOG = ROOT / "_traces.jsonl"   # live gesture-tuning data (test-gesture.html)

DEFAULT_CONFIG = {
    "host": "0.0.0.0", "http_port": 8855, "ws_port": 8856, "pin": "",
    # name -> command to run when the tablet sends {"type":"launch","name":...}
    # e.g. "tabletfriend": r"C:\Program Files\TabletFriend\TabletFriend.exe"
    "launch": {},
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))
        except Exception as exc:
            print(f"[warn] config.json unreadable ({exc}); using defaults")
    return cfg


CONFIG = load_config()

# Windows consoles default to cp1252; force UTF-8 so the banner/QR don't crash.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

mouse = MouseController()
kbd = KbdController()

_CLIENTS = 0          # authenticated tablets currently connected
_SOCKETS = set()      # authenticated websocket objects (for server->client pushes)
_move_accum = [0.0, 0.0]  # carry fractional pixels so no delta is ever lost
# R13.14: CURSOR GLIDE — moves are applied by a 250Hz stepper that drains the
# pending delta in small capped steps instead of one instant mouse.move per
# message. The tablet's 5× sensitivity produces LARGE per-message deltas that
# teleported the cursor (the "jumping/skipping" feel); gliding interpolates them
# so the cursor flows, and it absorbs network/browser frame batching too. Fine
# sub-pixel moves are unaffected (the stepper carries the fractional remainder).
_glide = [0.0, 0.0]        # integer pixels still to be glided
_glide_carry = [0.0, 0.0]  # fractional step remainder — no pixel is ever lost
_GLIDE_STEP = 48.0          # R13.17: 12px/4ms made fast moves TRAIL behind the
                            # finger (skid after you stop, corners smeared into
                            # diagonals). 48px/4ms = 12000px/s — even the fastest
                            # flick drains in ~1 tick, so the cursor tracks the
                            # finger live while small deltas still get eased.
_GLIDE_TICK = 0.004        # 250 Hz stepper
_glide_event = asyncio.Event()  # R14: wake stepper only when there's backlog
_glide_seq = 0  # R13.41: monotonically bumped on every queue — lets the stepper
                # tell a STALE wake (already drained) from a FRESH one (new moves
                # arrived mid-drain), so clear() can never eat a live signal.

# Windows timers default to ~15.6ms granularity, which would make a 4ms
# asyncio.sleep wake late (defeating the stepper). Raise to 1ms — the standard
# trick latency-sensitive apps use. Process-scoped, harmless.
try:
    ctypes.windll.winmm.timeBeginPeriod(1)
except Exception:
    pass


held_mouse = set()  # mouse buttons currently held (so the cursor-nudge never fires mid-drag)


# ------------------------------------------------- right-click trace (R13.37)
# INSTRUMENT-FIRST diagnostics for the ~30-40s phantom right-click (2026-09-03).
# LOG-ONLY: appends timestamped lines to bkp2-rightclick.log, never raises,
# never blocks, changes no behavior. Remove when the source is identified.
RC_TRACE_LOG = ROOT / "logs" / "rightclick.log"


def rc_trace(tag, detail=""):
    """Append one timestamped trace line. Never raises."""
    try:
        ts = time.strftime("%H:%M:%S") + ".%03d" % int((time.time() % 1) * 1000)
        RC_TRACE_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(RC_TRACE_LOG, "a", encoding="utf-8") as f:
            f.write("[%s] %s%s\n" % (ts, tag, (" " + str(detail)) if detail else ""))
    except Exception:
        pass


# ----------------------------------------------- R24: gesture recorder -------
# AUTOMATIC server-side gesture recording — the round-24 main deliverable.
# Every touch gesture the tablet reports is logged here, with NO action needed
# from the user (no ?flag, no special page — the tablet's gesture beacon calls
# record_gesture() on every pad gesture as part of its normal send path).
# The log opens with a plain-language legend so a non-developer — and the next
# session — can read it directly.
#
# File:  reports/gesture-log.txt   (served at /api/gesture-log)
# Cap:   last GLOG_MAX_LINES lines kept (rotation = drop oldest, never fail).
#        At this cap a multi-hour session holds ~tens of minutes of dense
#        gesturing; idle scrolling costs ~1 line per gesture, not per move.
GLOG_PATH = ROOT / "reports" / "gesture-log.txt"
GLOG_MAX_LINES = 3000

_GLOG_LEGEND = """\
GESTURE LOG — what each line means (plain words):
  time .......... when it happened (PC clock, hour:minute:second)
  fingers ....... how many fingers were on the pad (1 / 2 / 3 / 4)
  gesture ....... what the pad decided it was:
                    tap = quick touch-and-lift (a click or key)
                    scroll = fingers sliding together (moves the page / wheel)
                    pinch = two fingers spreading apart or squeezing together (zoom)
                    swipe-up / swipe-down / swipe-left / swipe-right = three
                      fingers flicked together (Task View / show desktop /
                      switch apps — the Windows laptop defaults)
                    draw-O / draw-V / draw-letter-n = one-finger drawn shape
                    hold / drag / unknown = anything else
  separation .... for a pinch: how far apart the two fingers are, in screen dots
                  (spread = bigger number, squeeze = smaller number);
                  for a tap or swipe: what kind of touch it was
  zoom signal ... for a pinch: did the pad ask the PC to zoom? none / zoom-IN / zoom-OUT
  sent to PC ... exactly what reached the PC (right-click, wheel scroll, or
                  hold-Ctrl + wheel-notch = the zoom instruction apps understand)
  reached page? . always YES here — this page IS the server log, so anything
                  written here arrived. If zoom shows "none", the pad swallowed
                  it and the PC never got a chance.
--------------------------------------------------------------------------------
"""

_glog_lock = threading.Lock()


def _glog_ensure_legend():
    """Write the legend header if the file is new/empty. Never raises."""
    try:
        if not GLOG_PATH.exists() or GLOG_PATH.stat().st_size == 0:
            GLOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with open(GLOG_PATH, "w", encoding="utf-8") as f:
                f.write(_GLOG_LEGEND)
    except Exception:
        pass


def record_gesture(fingers, gesture, separation="", zoom_signal="none",
                   sent_to_pc="", reached_page="YES"):
    """Log one pad gesture. Bounded (last GLOG_MAX_LINES kept). Never raises."""
    try:
        _glog_ensure_legend()
        ts = time.strftime("%H:%M:%S")
        line = ("time=%s | fingers=%s | gesture=%s | separation=%s | "
                "zoom signal=%s | sent to PC=%s | reached page?=%s\n"
                % (ts, fingers, gesture, separation or "-",
                   zoom_signal, sent_to_pc or "-", reached_page))
        with _glog_lock:
            with open(GLOG_PATH, "a", encoding="utf-8") as f:
                f.write(line)
            try:
                with open(GLOG_PATH, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                if len(lines) > GLOG_MAX_LINES + len(_GLOG_LEGEND.splitlines()):
                    keep = lines[-GLOG_MAX_LINES:]
                    with open(GLOG_PATH, "w", encoding="utf-8") as f:
                        f.write(_GLOG_LEGEND)
                        f.writelines(keep)
            except Exception:
                pass  # rotation is best-effort; the append above already landed
    except Exception:
        pass


class _CURSORINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint32), ("flags", ctypes.c_uint32),
                ("hCursor", ctypes.c_void_p),
                ("ptX", ctypes.c_long), ("ptY", ctypes.c_long)]


def _cursor_is_hidden():
    """True only when Windows is currently NOT drawing a pointer. GetCursorInfo
    sets CURSOR_SHOWING (0x1) in .flags while the pointer is on screen."""
    try:
        ci = _CURSORINFO()
        ci.cbSize = ctypes.sizeof(_CURSORINFO)
        if not ctypes.windll.user32.GetCursorInfo(ctypes.byref(ci)):
            return False
        return not (ci.flags & 0x00000001)          # CURSOR_SHOWING
    except Exception:
        return False


def _force_cursor_visible():
    """Windows hides the pointer when idle / in fullscreen apps / while typing,
    which is why the tablet's cursor seemed to vanish until a physical-mouse
    wiggle. ShowCursor(TRUE) only ever *increases* the cursor's display count —
    Windows actually un-hides the pointer in response to a REAL mouse event, so
    we also inject a 1px relative move (and straight back).

    FIX: only do any of this when the pointer is ACTUALLY hidden. It used to
    fire unconditionally every 2 seconds, and that 1px wiggle is visible — the
    "mouse flickers" report. An already-visible pointer now costs nothing."""
    try:
        if not _cursor_is_hidden():
            return
        u = ctypes.windll.user32
        for _ in range(4):
            u.ShowCursor(1)
        if not held_mouse:
            mouse.move(1, 1)
            mouse.move(-1, -1)
    except Exception:
        pass


async def cursor_keepalive():
    while True:
        await asyncio.sleep(2)
        # R13: skip the reveal while the screen stream is live — the tablet
        # draws its own cursor overlay from cursor_broadcaster().
        if _CLIENTS > 0 and _screen_viewers <= 0:
            _force_cursor_visible()



# ------------------------------------------------------------------ keys ----
SPECIAL_KEYS = {
    "enter": Key.enter, "return": Key.enter,
    "tab": Key.tab, "esc": Key.esc, "escape": Key.esc,
    "space": Key.space, "backspace": Key.backspace, "delete": Key.delete,
    "up": Key.up, "down": Key.down, "left": Key.left, "right": Key.right,
    "ctrl": Key.ctrl, "alt": Key.alt, "shift": Key.shift,
    "win": Key.cmd, "cmd": Key.cmd, "meta": Key.cmd,
    "home": Key.home, "end": Key.end,
    "pageup": Key.page_up, "pagedown": Key.page_down,
    "prtsc": Key.print_screen, "print_screen": Key.print_screen,
    "capslock": Key.caps_lock, "caps": Key.caps_lock,
    "insert": Key.insert, "ins": Key.insert,
    # R13.6: system volume — the arrow cluster's Vol+ / Vol- hold-to-repeat keys
    "volume_up": Key.media_volume_up, "vol_up": Key.media_volume_up,
    "volume_down": Key.media_volume_down, "vol_down": Key.media_volume_down,
}
for _i in range(1, 13):
    SPECIAL_KEYS[f"f{_i}"] = getattr(Key, f"f{_i}")

ALIASES = {"control": "ctrl", "option": "alt", "windows": "win", "cmd": "win"}
MOUSE_BUTTONS = {"left": Button.left, "right": Button.right, "middle": Button.middle}

held_keys = set()
held_mods = set()


def resolve_key(name):
    name = ALIASES.get(name, name)
    if name in SPECIAL_KEYS:
        return SPECIAL_KEYS[name]
    if isinstance(name, str) and len(name) == 1:
        return name
    return None


def press_key(key):
    kbd.press(key)


def release_key(key):
    try:
        kbd.release(key)
    except Exception:
        pass


def _key_from(name):
    key = resolve_key(name)
    if key is None:
        raise ValueError(f"unknown key: {name}")
    return key


# ------------------------------------------------------------ input fns ----
def do_move(dx, dy):
    # accumulate fractional deltas — pynput only moves whole pixels, so without
    # this a slow/fine touch (sub-pixel per frame) never moved the cursor at all
    if not dx and not dy:
        return
    _move_accum[0] += dx
    _move_accum[1] += dy
    ix = int(_move_accum[0])
    iy = int(_move_accum[1])
    _move_accum[0] -= ix
    _move_accum[1] -= iy
    if ix or iy:
        # R13.17: a hard turn (drawing a corner) reverses an axis — the stale
        # backlog still points the OLD way, so without this the cursor smears the
        # corner into a diagonal. Drop the opposite-direction backlog instantly so
        # it turns on the spot. Tiny finger jitter flips it too — which is fine:
        # it just means the cursor holds still instead of drifting.
        if ix and _glide[0] and (ix < 0) != (_glide[0] < 0):
            _glide[0] = 0
            _glide_carry[0] = 0.0
        if iy and _glide[1] and (iy < 0) != (_glide[1] < 0):
            _glide[1] = 0
            _glide_carry[1] = 0.0
        # queue into the glide buffer instead of moving instantly — the 250Hz
        # stepper applies it in smooth steps (small deltas eased, big ones drain
        # within ~1 tick at the faster R13.17 rate).
        _glide[0] += ix
        _glide[1] += iy
        global _glide_seq
        _glide_seq += 1
        _glide_event.set()  # R14: wake the stepper

async def _glide_stepper():
    """250Hz cursor-motion interpolator. Drains the pending glide buffer in
    capped steps (max _GLIDE_STEP px per 4ms tick), carrying the fractional
    remainder, so a burst — or one big 5×-sens delta — renders as a smooth flow
    instead of a jump. Runs in the asyncio loop, the same thread as do_move, so
    no locking is needed. R14: event-driven �?" only wakes when there's backlog, reducing CPU wakeups by ~90% when idle."""
    while True:
        bx, by = _glide
        if not bx and not by:
            _glide_carry[0] = _glide_carry[1] = 0.0
            # R13.41: seq-gated clear — only clear if no NEW move arrived since
            # we last looked. The old blind clear() ate wake-ups queued mid-drain
            # (do_move set the event, we cleared it after draining) → the stepper
            # slept 100ms on a full buffer → lump-then-nothing start-of-drag.
            seen = _glide_seq
            if _glide[0] or _glide[1]:
                bx, by = _glide
            else:
                _glide_event.clear()
                if _glide_seq != seen:
                    _glide_event.set()  # fresh move landed during clear — re-arm
                    bx, by = _glide
                    if not bx and not by:
                        continue
                else:
                    try:
                        await asyncio.wait_for(_glide_event.wait(), timeout=0.1)
                    except asyncio.TimeoutError:
                        continue
                    bx, by = _glide
                    if not bx and not by:
                        continue
        await asyncio.sleep(_GLIDE_TICK)
        sx = _GLIDE_STEP if bx > 0 else -_GLIDE_STEP
        sy = _GLIDE_STEP if by > 0 else -_GLIDE_STEP
        if abs(bx) < _GLIDE_STEP:
            sx = bx
        if abs(by) < _GLIDE_STEP:
            sy = by
        _glide[0] -= sx
        _glide[1] -= sy
        _glide_carry[0] += sx
        _glide_carry[1] += sy
        gx = int(_glide_carry[0])
        gy = int(_glide_carry[1])
        _glide_carry[0] -= gx
        _glide_carry[1] -= gy
        if gx or gy:
            try:
                mouse.move(gx, gy)
            except Exception:
                # pynput reads mouse.position inside move(); it returns None
                # transiently (lock screen / UAC / display off) which raised
                # TypeError and KILLED this while-True task forever — every later
                # move then piled into _glide unseen (dead trackpad, live clicks).
                # Swallow one bad tick; the next tick retries. Re-queue the
                # undelivered step so no pixels are lost.
                _glide[0] += sx
                _glide[1] += sy
                _glide_carry[0] -= sx
                _glide_carry[1] -= sy
                await asyncio.sleep(0.05)


def do_click(button_name, action):
    btn = MOUSE_BUTTONS.get(button_name)
    if btn is None:
        return
    if button_name == "right":
        # RC-SYNTH do_click-right: every OS right press/release flows through here
        rc_trace("RC-SYNTH do_click-right server.py:do_click", "%s/%s" % (button_name, action))
    if action == "down":
        mouse.press(btn)
        held_mouse.add(button_name)
    else:
        mouse.release(btn)
        held_mouse.discard(button_name)


def do_scroll(dx, dy):
    if dx or dy:
        mouse.scroll(dx, dy)


# R14: PINCH-TO-ZOOM — the tablet sends {"type":"zoom","dir":±N}; the PC holds
# Ctrl and emits N wheel notches (dir>0 = in, dir<0 = out). Holding ctrl via
# kbd.press/​release around ONE mouse.scroll call makes Windows deliver a
# genuine Ctrl+wheel, which is exactly what every app (editors, browsers, video
# timelines) treats as zoom. The press→scroll→release is atomic per message so
# a held Ctrl can never leak into later typing if a packet is lost — and the
# tablet already debounces the gesture (PINCH_GATE_PX), so single steps here.
# R24: returns True when a real Ctrl+wheel left this PC (the log's "sent to PC"
# evidence), False when the message carried nothing.
def do_zoom(steps):
    try:
        n = int(steps)
    except Exception:
        record_gesture(2, "pinch", "", "none",
                       "zoom message arrived but held no number — nothing done", "YES")
        return False
    if not n:
        record_gesture(2, "pinch", "", "none",
                       "zoom of 0 — nothing to do, nothing done", "YES")
        return False
    n = max(-8, min(8, n))   # sanity cap: one message never zooms more than 8
    try:
        kbd.press(Key.ctrl)
        try:
            mouse.scroll(0, n)
        finally:
            kbd.release(Key.ctrl)
        # R24 RECORDER: the zoom signal reached the page AND the PC acted.
        record_gesture(2, "pinch", "",
                       "zoom-%s" % ("IN" if n > 0 else "OUT"),
                       "hold-Ctrl + %d wheel-notch(es) %s (acted on by the PC)"
                       % (abs(n), "up = zoom in" if n > 0 else "down = zoom out"),
                       "YES")
        return True
    except Exception as exc:
        try:
            kbd.release(Key.ctrl)
        except Exception:
            pass
        record_gesture(2, "pinch", "", "none",
                       "tried Ctrl+wheel but the PC refused (%s)" % exc, "YES")
        return False


def do_key(name, action):
    key = _key_from(name)
    if action == "down":
        press_key(key)
        held_keys.add(name)
        if name in ("ctrl", "alt", "shift", "win"):
            held_mods.add(name)
    else:
        release_key(key)
        held_keys.discard(name)
        held_mods.discard(name)


def do_char(ch):
    if not ch:
        return
    if held_mods:
        # a modifier is held -> press the literal key so it combines (Ctrl+C…)
        try:
            kbd.press(ch)
            kbd.release(ch)
        except Exception:
            kbd.type(ch)
    else:
        kbd.type(ch)


def do_text(text):
    if not text:
        return
    restore = []
    for name in tuple(held_mods):
        key = resolve_key(name)
        if key is not None:
            release_key(key)
            restore.append(key)
    kbd.type(text)
    for key in restore:
        press_key(key)


def do_combo(names):
    keys = [_key_from(n) for n in names]
    for k in keys:
        press_key(k)
        held_keys.add(str(k))
    for k in reversed(keys):
        release_key(k)
        held_keys.discard(str(k))


def release_all():
    # R13.38 FIX (2026-09-04) for the phantom ~30s right-click: the old code
    # released ALL THREE mouse buttons unconditionally on every disconnect /
    # release_all — including Button.right even when the tablet never pressed
    # it. On Windows a bare RBUTTONUP with no matching RBUTTONDOWN still
    # surfaces the context menu, and the watchdog probes via 127.0.0.1 every
    # 30s (connect hello/ping/pong -> drop), so each probe cycle flashed the
    # right-click menu. Now: release ONLY buttons in held_mouse (i.e. buttons
    # the tablet actually pressed via do_click down). Keys unchanged.
    for name in list(held_keys):
        key = resolve_key(name)
        if key is not None:
            release_key(key)
    held_keys.clear()
    held_mods.clear()
    _held = set(held_mouse)
    for button_name in _held:
        btn = MOUSE_BUTTONS.get(button_name)
        if btn is None:
            continue
        try:
            mouse.release(btn)
            if btn == Button.right:
                # RC-SYNTH release-all-right: fires ONLY when right was truly held
                rc_trace("RC-SYNTH release-all-right server.py:release_all", "released held Button.right")
        except Exception:
            pass
    held_mouse.clear()


def _find_tabletfriend():
    """Best-effort hunt for a TabletFriend.exe so the tablet button just works."""
    import glob
    import os

    roots = []
    for env in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "APPDATA"):
        if os.environ.get(env):
            roots.append(os.environ[env])
    patterns = ["**/TabletFriend.exe", "**/TabletFriend*.exe"]
    for root in roots:
        for pat in patterns:
            hits = glob.glob(os.path.join(root, pat), recursive=True)
            if hits:
                return hits[0]
    return ""


def do_launch(name):
    """Start an app configured in config.json -> "launch". Returns (ok, error)."""
    cmd = (CONFIG.get("launch") or {}).get(name)
    if not cmd and name == "tabletfriend":
        cmd = _find_tabletfriend()
    if not cmd:
        return False, f"no launch command configured for '{name}' (config.json → launch)"
    try:
        if sys.platform == "win32":
            # use start /b so the server doesn't wait and no console pops up
            subprocess.Popen(f'start "" /b {cmd}', shell=True)
        else:
            subprocess.Popen(cmd, shell=True)
        return True, None
    except Exception as exc:
        return False, str(exc)


# ------------------------------------------------------------ websocket ----
async def client_handler(ws):
    global _CLIENTS, _touch_active, _touch_last  # R14 finger-gate: touch handler must write the MODULE globals (bare `global _CLIENTS` silently lost every touch msg)
    peer = ws.remote_address
    print(f"[+] client connected: {peer[0]}")
    authed = False
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if not authed:
                if mtype == "hello":
                    pin = str(msg.get("pin", ""))
                    if CONFIG["pin"] and pin != str(CONFIG["pin"]):
                        await ws.send(json.dumps({"type": "error", "message": "wrong pin"}))
                        print(f"[x] bad pin from {peer[0]}")
                        return
                    authed = True
                    _CLIENTS += 1
                    _SOCKETS.add(ws)
                    await ws.send(json.dumps({
                        "type": "welcome",
                        "server": "touch-tools",
                        "version": 1,
                        "ips": lan_ips(),
                    }))
                    print(f"[+] client authed: {peer[0]}")
                continue
            # NOTE (2026-08-26): the per-message cursor-reveal nudge is GONE. It ran
            # on EVERY WS message — including each move packet — injecting a 1px
            # mouse.move(1,1);(-1,-1) tremor on top of every real move (~60Hz) =
            # jittery/laggy cursor even with the screen stream off. The 2s
            # cursor_keepalive() task below already reveals the pointer, so the
            # per-message nudge was pure redundancy. Smooth moves: no wiggle.
            if mtype == "ping":
                await ws.send(json.dumps({"type": "pong", "t": msg.get("t")}))
            elif mtype == "move":
                do_move(float(msg.get("dx", 0)), float(msg.get("dy", 0)))
            elif mtype == "stop":
                # R13.17: all fingers lifted — drop the glide backlog NOW so the
                # cursor stops the instant the finger is gone (no skid).
                _glide[0] = _glide[1] = 0
                _glide_carry[0] = _glide_carry[1] = 0.0
            elif mtype == "touch":
                # R14 finger-gate: tablet signals finger contact on the trackpad.
                # active=1 while down (with periodic heartbeats), 0 on lift.
                _touch_active = 1 if msg.get("active") else 0
                _touch_last = time.time()
            elif mtype == "click":
                # RC-INBOUND click-msg: every WS click reaching right-click logic
                if msg.get("button") == "right":
                    rc_trace("RC-INBOUND click-msg server.py:client_handler", "button=right action=%s" % (msg.get("action", "down"),))
                do_click(msg.get("button"), msg.get("action", "down"))
            elif mtype == "scroll":
                do_scroll(float(msg.get("dx", 0)), float(msg.get("dy", 0)))
            elif mtype == "zoom":
                # R14 pinch-to-zoom: {"type":"zoom","dir":±N} → Ctrl+wheel.
                # R24: the tablet's gesture beacon calls record_gesture() for
                # the page-side half of the record; do_zoom logs the PC half.
                do_zoom(msg.get("dir", 0))
            elif mtype == "glog":
                # R24 RECORDER — the tablet's gesture beacon: one small beacon
                # per pad gesture (tap / scroll / pinch / draw / hold). This
                # branch NEVER touches the mouse or keyboard — it only writes
                # the page-side half of the record (what the pad classified).
                # Zoom beacons carry what the pad sent (or "none" when it sent
                # nothing); scroll/tap beacons carry what the pad did.
                try:
                    record_gesture(msg.get("fingers", "?"),
                                   str(msg.get("gesture", "unknown")),
                                   str(msg.get("separation", "")),
                                   str(msg.get("zoom_signal", "none")),
                                   str(msg.get("sent_to_pc", "")),
                                   "YES")
                except Exception:
                    pass
            elif mtype == "key":
                do_key(msg.get("key"), msg.get("action", "down"))
            elif mtype == "char":
                do_char(msg.get("char"))
            elif mtype == "text":
                do_text(msg.get("text"))
            elif mtype == "combo":
                do_combo(msg.get("keys", []))
            elif mtype == "release_all":
                # RC-CANDIDATE release-all: releases Button.right too — entry marker
                rc_trace("RC-CANDIDATE release-all server.py:client_handler", "held_mouse=%s" % (sorted(held_mouse),))
                release_all()
            elif mtype == "launch":
                ok, err = do_launch(msg.get("name"))
                await ws.send(json.dumps({
                    "type": "launch_result", "name": msg.get("name"), "ok": ok, "error": err,
                }))
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _CLIENTS -= 1
        _SOCKETS.discard(ws)
        # RC-CANDIDATE disconnect-release_all: every drop runs release_all()
        # (releases Button.right) — entry marker to correlate with client
        # reconnect traces when the phantom fires on a ~30-40s link flap
        rc_trace("RC-CANDIDATE disconnect-release_all server.py:client_handler", "clients_left=%d" % (_CLIENTS,))
        release_all()
        # R13.16: a dropped connection can leave a stale glide backlog (deltas
        # that arrived in the last burst). If we don't clear it, the stepper keeps
        # draining it — and on reconnect the cursor jumps to that stale position.
        # Only when NO client is connected: with another client live the backlog
        # belongs to the surviving one.
        if _CLIENTS <= 0:
            _glide[0] = _glide[1] = 0
            _glide_carry[0] = _glide_carry[1] = 0.0
            _move_accum[0] = _move_accum[1] = 0.0
        print(f"[-] client gone: {peer[0]}")


# ------------------------------------------------------------------ http ----
def lan_ips():
    ips = set()
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    return sorted(ips, key=lambda ip: (not ip.startswith(("192.168.", "10.", "172.")),))


# ------------------------------------------------------------- screen --------
# R13: PC → tablet screen streaming, the "easier than Moonlight" way. mss does a
# fast GDI screen grab of the primary monitor, Pillow downscales + JPEG-encodes,
# and the tablet renders it with a plain <img> tag pointing at an MJPEG stream —
# zero client-side decode work, nothing to install on the tablet. Capture runs
# ONLY inside the /api/screen HTTP handler, so with the stream closed the server
# does no screen work at all. R13.2: the real cursor is drawn INTO every frame
# (_draw_cursor) — the tablet shows the raw screen, no overlay, so the cursor
# can't flicker or lag behind the picture.
_screen_viewers = 0   # tablets currently streaming (HTTP thread writes, WS loop reads)
_touch_active = 0   # R14 finger-gate: 1 while a tablet finger is on the trackpad
_touch_last = 0.0   # time of last touch:active=1 heartbeat (safety for missed lift)


def _screen_available():
    try:
        import mss          # noqa: F401
        from PIL import Image  # noqa: F401
        return True
    except Exception:
        return False


def _screen_info():
    """Primary monitor size — the client maps cursor coordinates onto the
    downscaled streamed image with this. If mss/Pillow are missing we still
    answer so the client can show a graceful "unavailable" state."""
    if not _screen_available():
        return {"ok": False, "error": "screen capture unavailable — install mss + Pillow"}
    try:
        import mss

        with mss.mss() as sct:
            mon = sct.monitors[1]
            return {"ok": True, "monitor": {"w": mon["width"], "h": mon["height"]}}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def _draw_cursor(img, x, y):
    """Draw a small pointer arrow into a grabbed frame at (x, y) — the arrow's
    tip sits exactly on the PC cursor's position, scaled to the frame width.
    Drawn INTO the frame itself (not as an overlay), so on the tablet it moves
    with the picture: no separate channel, nothing to flicker, nothing to lag."""
    from PIL import ImageDraw
    s = max(10, min(26, img.width // 46))
    pts = [
        (x, y),
        (x + int(0.85 * s), y + int(0.30 * s)),
        (x + int(0.45 * s), y + int(0.45 * s)),
        (x + int(0.62 * s), y + int(0.95 * s)),
        (x + int(0.46 * s), y + int(s)),
        (x + int(0.28 * s), y + int(0.50 * s)),
        (x - int(0.12 * s), y + int(0.60 * s)),
        (x - int(0.12 * s), y + int(0.32 * s)),
    ]
    draw = ImageDraw.Draw(img)
    draw.polygon(pts, fill=(8, 12, 26))                              # dark outline
    inner = [(x + int((px - x) * 0.72), y + int((py - y) * 0.72)) for (px, py) in pts]
    draw.polygon(inner, fill=(255, 255, 255))                        # white fill


def _grab_jpeg(sct, w_max, q):
    """Grab the primary monitor once and JPEG-encode it. Returns bytes. The mss
    context lives in the caller so we don't re-enumerate monitors per frame."""
    from PIL import Image

    shot = sct.grab(sct.monitors[1])
    img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
    scale = min(1.0, w_max / float(img.width))
    if scale < 1.0:
        # R13.2: BILINEAR instead of LANCZOS — visually identical for a
        # streamed video frame but several × cheaper on the CPU.
        img = img.resize(
            (max(1, int(img.width * scale)), max(1, int(img.height * scale))),
            Image.BILINEAR,
        )
    # R13.2: bake the real cursor INTO the frame so the tablet shows just the
    # screen (overlays flickered and lagged behind the picture).
    pos = _cursor_pos()
    if pos is not None:
        _draw_cursor(img, int(pos[0] * scale), int(pos[1] * scale))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=q, optimize=False, progressive=False)
    return buf.getvalue()


def _cursor_pos():
    try:
        p = ctypes.wintypes.POINT()
        if ctypes.windll.user32.GetCursorPos(ctypes.byref(p)):
            return p.x, p.y
    except Exception:
        pass
    return None


def make_qr_svg(url):
    import qrcode
    import qrcode.image.svg

    qr = qrcode.QRCode(border=2, box_size=8, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(url)
    qr.make(fit=True)
    buf = io.BytesIO()
    qr.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(buf)
    return buf.getvalue().decode("utf-8")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/info":
            body = json.dumps({
                "name": "touch-tools",
                "version": 1,
                "http_port": CONFIG["http_port"],
                "ws_port": CONFIG["ws_port"],
                "pin": bool(CONFIG["pin"]),
                "ips": lan_ips(),
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/btips":
            # Bluetooth mode discovery: the app is served over Wi-Fi, but it can
            # reconnect its WebSocket over the PC's Bluetooth-PAN IP instead (a
            # Bluetooth tether the tablet hosts). Exclude the host the app was
            # served from so the WS actually hops the Bluetooth link, not Wi-Fi.
            q = urllib.parse.parse_qs(parsed.query)
            excl = {ip for ip in q.get("exclude", []) if ip}
            cands = [ip for ip in lan_ips() if ip not in excl]
            body = json.dumps({"ips": cands}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/btjoin":
            # Force the PC to JOIN the tablet's Bluetooth-tether PAN before the
            # app scans for a BT-PAN address. Bluetooth tethering makes the pad
            # a Personal Area Network (NAP); Windows does NOT auto-join it — the
            # PC must connect as a PANU client. The probe below is the same call
            # Windows makes for "Connect using → Access point":
            # BluetoothSetServiceState(radio, &dev, PAN_GUID, ENABLE). Runs
            # over the still-alive Wi-Fi link; after it, lan_ips() picks up the
            # new 192.168.44.x/42.x PAN address and BT discovery can find it.
            probe = ROOT / "_bt_join.ps1"
            out, err = "", ""
            try:
                r = subprocess.run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
                     "-File", str(probe)],
                    capture_output=True, text=True, timeout=30,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                out, err = r.stdout, r.stderr
            except Exception as e:
                out = f"PROBE-ERR {e}"
            body = json.dumps({
                "ok": True,
                "ips": lan_ips(),
                "log": (out + "\n" + err).strip()[-2000:],
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/screeninfo":
            body = json.dumps(_screen_info()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/screen":
            return self._serve_screen(parsed)
        if parsed.path == "/api/gesture-log":
            # R24 RECORDER — the ONE link: returns the whole gesture log as a
            # downloadable plain-text file (legend header included). Always on,
            # no flag needed.
            _glog_ensure_legend()
            try:
                body = GLOG_PATH.read_bytes()
            except Exception:
                body = _GLOG_LEGEND.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition",
                             'attachment; filename="gesture-log.txt"')
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/traces":
            recs = 0
            if TRACES_LOG.exists():
                try:
                    with open(str(TRACES_LOG), encoding="utf-8") as f:
                        recs = sum(1 for _ in f)
                except Exception:
                    pass
            body = json.dumps({"count": recs, "file": str(TRACES_LOG)}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/qr":
            url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            if url:
                svg = make_qr_svg(url)
                body = svg.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "image/svg+xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_error(400, "missing url")
            return
        # LIVE BACKUP — /bkp2 serves the frozen 1.5 web app (bkp2/web), the version
        # in use right now. Untouched while v2.0 is built on web/. Self-hosted under
        # its own /bkp2 scope so the main service worker just passes it through.
        if parsed.path.startswith("/bkp2"):
            # Bare /bkp2 (no trailing slash) MUST redirect to /bkp2/ — serving it
            # directly leaves the document base at /bkp2, so the page's relative
            # app.js resolves to /app.js (v2 touch-mode) = wrong interface.
            if parsed.path == "/bkp2":
                self.send_response(301)
                self.send_header("Location", "/bkp2/")
                self.end_headers()
                return
            rel = parsed.path[len("/bkp2"):] or "/"
            old_path, self.path = self.path, rel
            old_dir, self.directory = self.directory, str(BKP2_WEB_DIR)
            try:
                super().do_GET()
            finally:
                self.directory = old_dir
                self.path = old_path
            return
        super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/ai":
            # RELAY for model endpoints the browser refuses to call cross-origin.
            # The tablet posts {url, key, body}; this PC asks the endpoint instead
            # (a browser rule does not apply to the PC). The key is used for this
            # one request and is NEVER stored, logged or written down here.
            # Only https endpoints on a short allow-list are relayed, so this
            # cannot be turned into a way to poke at other machines.
            try:
                n = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(n) if n else b""
                data = json.loads(raw.decode("utf-8")) if raw else {}
                url = str(data.get("url", ""))
                payload = data.get("body") or {}
                key = str(data.get("key", ""))
                host = (urllib.parse.urlparse(url).hostname or "").lower()
                allowed = ("api.meta.ai", "opencode.ai", "localhost", "127.0.0.1")
                if host not in allowed:
                    raise ValueError("endpoint not allowed")
                if not (url.startswith("https://") or host in ("localhost", "127.0.0.1")):
                    raise ValueError("only https endpoints are relayed")
                headers = {"Content-Type": "application/json",
                           "Accept": "application/json",
                           # some endpoints put a bot wall in front and reject
                           # the default python-urllib signature outright
                           "User-Agent": "Touch-Tools/2.15",
                           # OpenCode Go wants a per-request session id; any
                           # unique value is accepted, so a fresh one per call.
                           "x-opencode-session": uuid.uuid4().hex}
                if key:
                    headers["Authorization"] = "Bearer " + key
                req = urllib.request.Request(
                    url, data=json.dumps(payload).encode("utf-8"),
                    headers=headers, method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        code, text = resp.status, resp.read()
                except urllib.error.HTTPError as he:
                    code, text = he.code, he.read()      # 401/402/429 pass through as-is
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(text)))
                self.end_headers()
                self.wfile.write(text)
            except Exception as exc:
                body = json.dumps({"error": {"message": str(exc)}}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        if parsed.path == "/api/glog":
            # R24 RECORDER fallback: the page couldn't reach the WebSocket, so
            # it POSTs its gesture beacon here instead. Same record, plus a
            # note that the live channel was down (the "reached page?" half of
            # the classification: classified but never left the page live).
            try:
                n = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(n) if n else b""
                data = json.loads(raw.decode("utf-8")) if raw else {}
                sent = str(data.get("sent_to_pc", ""))
                record_gesture(data.get("fingers", "?"),
                               str(data.get("gesture", "unknown")),
                               str(data.get("separation", "")),
                               str(data.get("zoom_signal", "none")),
                               (sent + " [note: live channel was down, sent after]"
                                if sent else
                                "[note: live channel was down — classified on the page, PC got nothing live]"),
                               "YES-via-fallback")
                body = b'{"ok":true}'
                self.send_response(200)
            except Exception as exc:
                body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
                self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/traces":
            try:
                n = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(n) if n else b""
                data = json.loads(raw.decode("utf-8")) if raw else {}
                pts = data.get("pts")
                if not (pts and isinstance(pts, list) and len(pts) >= 2):
                    raise ValueError("empty trace")
                # compact stroke: timestamp + canvas size + raw points + verdict.
                # First 4000 points is far beyond any real finger trace.
                rec = {
                    "t": time.time(),
                    "n": len(pts),
                    "ok": bool(data.get("ok")),
                    "cw": data.get("cw", 0),
                    "ch": data.get("ch", 0),
                    "pts": [[round(float(a), 1), round(float(b), 1)] for a, b in pts[:4000]],
                }
                with open(str(TRACES_LOG), "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec) + "\n")
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"ok": False, "error": str(exc)}).encode("utf-8")
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return
        self.send_error(404, "unknown POST")

    def _serve_screen(self, parsed):
        """R13: MJPEG stream of the PC screen. One long-lived HTTP response that
        keeps pushing JPEG frames until the tablet closes it — which is exactly
        how capture stays zero-cost when nobody is watching. Query params:
          w   max frame width  (640..2560, default 960)
          q   JPEG quality      (20..95,  default 60)
          fps max frames/sec    (1..30,   default 10)
        Quality presets on the tablet map to these."""
        if not _screen_available():
            self.send_error(503, "screen capture unavailable — server needs mss + Pillow")
            return
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            w = max(320, min(2560, int(qs.get("w", ["960"])[0])))
            q = max(20, min(95, int(qs.get("q", ["60"])[0])))
            fps = max(1.0, min(30.0, float(qs.get("fps", ["10"])[0])))
        except ValueError:
            self.send_error(400, "bad screen params")
            return

        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=RCframe")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        import mss

        global _screen_viewers
        _screen_viewers += 1
        interval = 1.0 / fps
        # R13.3: ADAPTIVE quality — the tablet's Wi-Fi decides the bitrate, like
        # Moonlight. The client asks for the clearest it *might* get; if a frame
        # can't be pushed at the requested fps (measured end-to-end: encode + TCP
        # write), quality drops — q first, then width — until the link keeps up,
        # and climbs back when there's headroom. This is what kills the video
        # stutter that showed up as "flickering cursor + 0.5–1s delay".
        # LAG-FIX (2026-09-02): motion-aware adaptive quality. Replaces the
        # blunt BLUR-FIX disable. HIGH quality when idle (sharp screen viewing);
        # relax quality ONLY while the cursor moves (smooth, no lag); recover
        # to HIGH promptly when motion stops. Motion signal = real cursor pos,
        # which we already sample each frame to draw the cursor. Recovery is
        # achievable: at the relaxed floor a frame encodes well under budget,
        # so the still-streak climbs and recovery triggers (unlike broken
        # R13.3 whose ema_enc < interval*0.3 floor was unachievable).
        cur_q, cur_w = q, w
        # Floor = the LOW preset so the stream stays usable under fast motion.
        FLOOR_W, FLOOR_Q = 854, 60
        DEADZONE = 3.0          # px; ignore cursor jitter smaller than this
        MOTION_NEED = 2         # consecutive moving frames -> drop quality
        STILL_NEED = 5          # consecutive still frames -> recover quality
        DROP_STEP_W = 0.82      # width multiplier per motion tick (toward floor)
        DROP_STEP_Q = 8         # quality subtraction per motion tick
        RISE_STEP_W = 1.18      # width multiplier per still tick (toward peak)
        RISE_STEP_Q = 6         # quality addition per still tick
        last_cx, last_cy = None, None
        motion_streak = 0
        still_streak = 0
        try:
            sct = mss.mss()
            try:
                while True:
                    t0 = time.time()
                    # sample cursor for motion detection BEFORE the grab
                    cpos = _cursor_pos()
                    jpeg = _grab_jpeg(sct, cur_w, cur_q)
                    t1 = time.time()
                    self.wfile.write(
                        b"--RCframe\r\nContent-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(jpeg)).encode("ascii") +
                        b"\r\n\r\n" + jpeg + b"\r\n"
                    )
                    self.wfile.flush()
                    t2 = time.time()
                    total = t2 - t0  # full loop cost (encode + net)
                    # --- motion-aware adaptive controller ---
                    if cpos is not None and last_cx is not None:
                        moved = abs(cpos[0] - last_cx) + abs(cpos[1] - last_cy)
                    else:
                        moved = 0.0
                    last_cx = cpos[0] if cpos else last_cx
                    last_cy = cpos[1] if cpos else last_cy
                    if moved > DEADZONE:
                        motion_streak += 1
                        still_streak = 0
                        if motion_streak >= MOTION_NEED and (cur_q > FLOOR_Q or cur_w > FLOOR_W):
                            # relax toward floor: width first (biggest encode win), then quality
                            if cur_w > FLOOR_W:
                                cur_w = max(FLOOR_W, int(cur_w * DROP_STEP_W))
                            else:
                                cur_q = max(FLOOR_Q, cur_q - DROP_STEP_Q)
                    else:
                        still_streak += 1
                        motion_streak = 0
                        # R14 finger-gate: only recover to HIGH when the finger is OFF the pad.
                        # A resting finger (no cursor move) must NOT trigger recovery, else the
                        # next move re-triggers the slow full-res encode = lag. Safety timeout:
                        # if the client goes silent mid-touch, expire after 2.0s so a missed
                        # pointerup can't pin low quality forever.
                        finger_off = (not _touch_active) or (time.time() - _touch_last > 2.0)
                        if still_streak >= STILL_NEED and (cur_q < q or cur_w < w) and finger_off:
                            # recover toward peak: quality first (sharpen), then width
                            if cur_q < q:
                                cur_q = min(q, cur_q + RISE_STEP_Q)
                            else:
                                cur_w = min(w, int(cur_w * RISE_STEP_W))
                    if total < interval:
                        time.sleep(interval - total)
            finally:
                sct.close()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass  # the tablet closed the stream — that's the normal stop signal
        finally:
            _screen_viewers -= 1

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


def run_http():
    httpd = ThreadingHTTPServer((CONFIG["host"], CONFIG["http_port"]), Handler)
    httpd.serve_forever()


def main():
    threading.Thread(target=run_http, daemon=True).start()

    ips = lan_ips()
    print()
    print("  =============================================")
    print("        TOUCH TOOLS  (server)")
    print("  =============================================")
    print(f"  HTTP UI    : http://{CONFIG['host']}:{CONFIG['http_port']}")
    print(f"  WS control : ws://{CONFIG['host']}:{CONFIG['ws_port']}")
    print(f"  PIN set    : {'yes' if CONFIG['pin'] else 'no'}")
    print("  Connect from your tablet (same Wi-Fi):")
    for ip in ips:
        print(f"      http://{ip}:{CONFIG['http_port']}")
    if ips:
        url = f"http://{ips[0]}:{CONFIG['http_port']}"
        try:
            import qrcode

            qr = qrcode.QRCode(border=1)
            qr.add_data(url)
            qr.make(fit=True)
            print("  Or scan this QR with the tablet camera:")
            qr.print_ascii(invert=True)
        except Exception:
            pass
    print("  Press Ctrl+C to stop.")
    print()

    async def serve_ws():
        asyncio.create_task(cursor_keepalive())
        asyncio.create_task(_glide_stepper())
        async with websockets.serve(
            client_handler,
            CONFIG["host"],
            CONFIG["ws_port"],
            max_size=1 << 20,
            ping_interval=20,
            ping_timeout=30,
            compression=None,
        ):
            await asyncio.Future()

    try:
        asyncio.run(serve_ws())
    except KeyboardInterrupt:
        pass
    finally:
        release_all()
        print("\n[*] server stopped")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:                      # keep the window open on any failure
        import traceback
        traceback.print_exc()
        msg = str(exc).lower()
        print("\n" + "=" * 60)
        if "10048" in msg or "address already in use" in msg or "only one usage" in msg:
            print("The port is already in use by another program.")
            print("Most likely a second copy of this server is already running.")
            print("Close the other window, or change http_port and ws_port in config.json.")
        else:
            print("The server stopped because of the error shown above.")
        print("=" * 60)
        print("\nPress Enter to close this window.")
        try:
            input()
        except Exception:
            pass
