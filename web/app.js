'use strict';
/* Touch Tools — tablet client.
 * Talks to server.py over WebSocket. Relative-delta mouse moves are
 * coalesced on a requestAnimationFrame timer so we always send the LATEST
 * finger position — never a backlog — which is what keeps the cursor smooth.
 *
 * There is NO built-in keyboard: the type bar at the bottom is a real input,
 * so tapping it opens the tablet's own keyboard (Gboard etc.). In "Live" mode
 * every keystroke goes straight to the PC; in "Send" mode you compose first.
 *
 * Customization: gestures, rail buttons and the left button bank all live in
 * the active PROFILE. Profiles are auto-saved on the tablet and can be
 * exported/imported as .json files (⚙ Customize → Profiles).
 * The "?" button runs a step-by-step guided tour that highlights each area.
 */

/* --------------------------------------------------- themes (R13.35) ----- */
/* 4-color theme system (blue/black/purple/yellow). Applies a [data-theme]
   attribute on <html>, persists the choice, and updates the PWA theme-color
   meta so the browser chrome matches. PURELY cosmetic â€” no layout, geometry,
   or input behavior changes. */
const THEMES = ["blue", "black", "purple", "yellow"];
const THEME_KEY = "rc_theme";

function currentThemeMetaBg() {
  // The per-theme background is carried by --meta-bg; read it so the
  // theme-color meta always matches the active theme's actual background.
  const t = document.documentElement.getAttribute("data-theme") || "blue";
  const map = {
    blue: "#0b1120", black: "#05070d", purple: "#100a1c", yellow: "#16120a"
  };
  return map[t] || map.blue;
}

function applyTheme(t) {
  if (!THEMES.includes(t)) t = "blue";
  const html = document.documentElement;
  if (t === "blue") html.removeAttribute("data-theme");
  else html.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", currentThemeMetaBg());
  localStorage.setItem(THEME_KEY, t);
  markThemeSwatch(t);
}

function markThemeSwatch(t) {
  document.querySelectorAll("#theme-popup .tsw").forEach((el) => {
    el.classList.toggle("on", el.getAttribute("data-theme-sw") === t);
  });
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || "blue";
  applyTheme(saved);
}

function wireThemePicker() {
  const btn = $("theme-btn");
  const pop = $("theme-popup");
  if (!btn || !pop) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    pop.classList.toggle("hidden");
  });
  pop.querySelectorAll(".tsw").forEach((sw) => {
    sw.addEventListener("click", () => {
      applyTheme(sw.getAttribute("data-theme-sw"));
      pop.classList.add("hidden");
    });
  });
  // close on outside click
  document.addEventListener("click", () => pop.classList.add("hidden"));
}

const $ = (id) => document.getElementById(id);

// R12: suppress the browser's long-press context menu. On a touch device a
// long-press on a key/button can pop the browser's own menu, which cancels the
// pointer (killing a hold on ⌫ / arrows before Windows can repeat) and can leak
// a stray input to the PC. The PC's right-click is sent by buttons/gestures.
document.addEventListener('contextmenu', (e) => e.preventDefault());

const state = {
  ws: null,
  connected: false,
  retry: 0,
  linkMode: 'wifi',            // 'wifi' | 'bt' — BT reconnects the WS over the Bluetooth-PAN link
  pin: localStorage.getItem('rc_pin') || '',
  sens: 2,
  zoomSens: 100,          // R27: Zoom-slider % — notches per pinch step (see zoomNotches()). Persisted as rc_zoomsens.
  prec: false,               // precision (fine) mode toggle
  holdBtn: null,             // 'left' | 'right' | null — click-and-hold button
  drag: false,               // pad "DRAG" toggle
  toggledMods: new Set(),    // sticky ctrl/shift/alt/win
  held: new Set(),           // keys currently pressed down
  profile: null,             // active profile object
  profiles: {},              // name -> profile (persisted)
  activeName: 'Default',
  dragBtn: null,             // current DRAG chip element (if rendered)
  bankTab: 'all',            // active button-bank tab ('all' = every section)
  scrollMode: false,         // the pad's scroll dial: ON → dragging scrolls instead of moving
  gestureMode: false,        // R13.7: the pad's top-right ◯ dial: ON → draw gestures w/o moving the cursor
  autoScroll: { on: false, dir: 0, mag: 1, timer: null },  // M button autoscroll
  panMode: { on: false },    // R13.10: M DOUBLE-tap → middle held down = PAN (DaVinci preview)
};

const PREC_FACTOR = 0.25;    // precision mode scales pointer deltas down by this
const SCROLL_FACTOR = 0.2;   // scroll-mode drag → wheel notches (finger down = scroll down)
function scrollWheelFactor() {
  // R13.6: the ↕ dial's wheel speed follows the Sens slider — high sens = fast
  // scroll, low sens = slow. Normalized to the default (5.0) so nothing changes
  // out of the box; lower the slider and the wheel turns gentler.
  return SCROLL_FACTOR * (state.sens / 5);
}
// R12: autoscroll + hold-to-repeat timing
const AUTOSCROLL_MS = 40;    // continuous-scroll cadence while autoscrolling (25 notches/s)
// R13.10: M button double-tap → PAN mode (hold middle, drag to pan). Window for the
// second tap + a short block after release so a double-tap release can't re-engage.
const PAN_DBL_MS = 350;
let mTapTime = 0, mPanBlock = 0;
// R13.6: volume keys repeat too — hold Vol+ / Vol- and the PC volume keeps stepping
const REPEAT_KEYS = new Set(['backspace', 'delete', 'space', 'up', 'down', 'left', 'right', 'volume_up', 'volume_down']);
const REPEAT_START = 320;    // OS-like delay before a hold starts repeating
const REPEAT_EVERY = 40;     // repeat cadence while held

let WS_PORT = 8856;
/* Cloudflare-tunnel support (hosted https build): open the page with
 * ?tunnel=<host>.trycloudflare.com — saved in localStorage — and the control
 * socket goes to wss://<host>/ (port 443) through the tunnel instead of
 * :8856 (blocked on https). LAN http:// use is untouched. */
let RC_TUNNEL = '';
try {
  const qTun = new URLSearchParams(location.search).get('tunnel');
  if (qTun) localStorage.setItem('rc_tunnel', qTun.replace(/^https?:\/\//, '').replace(/\/+$/, ''));
  RC_TUNNEL = localStorage.getItem('rc_tunnel') || '';
} catch (e) { RC_TUNNEL = ''; }
// R12: right after a page load/refresh, Chrome can replay the tap that reloaded
// the page onto the freshly loaded UI — e.g. onto the R button (top-right of the
// rail in landscape) → a stray right-click on the PC. Drop every input for the
// first moment; only the handshake + latency probes pass.
const INPUT_SETTLED = performance.now() + 250;

/* ======================================================== profiles ========= */
const DEFAULT_GESTURES = {
  oneTap: { click: 'left' },
  twoTap: { click: 'right' },
  threeTap: { click: 'middle' },
  // R13.5: draw a loop ("O") anywhere on the pad with one finger → this action
  // (default Import, remappable in ⚙ Customize → Gestures). The trace still
  // moves the PC cursor normally; only a clear loop triggers the action.
  circle: { keys: ['ctrl', 'i'] },
  // R13.18: draw a sharp two-arm "V" → this action (default Ctrl+Alt+S — Vibe
  // software launch). Checked only when the trace is NOT a circle.
  vee: { keys: ['ctrl', 'alt', 's'] },
  // R13.19+: draw the LETTER N/n (tall, open, two-arch stroke) → this action (default
  // launch notepad.exe — a new Notepad window). Checked only when the trace is
  // NOT a circle and NOT a V.
  notepad: { launch: 'notepad' },
  hold: 'drag',              // 'drag' | 'none'
};

function defaultMajorRow() {
  // R13.6: reworked rows. The quick-click M moved OUT of the major row into the
  // static mod row (M SHIFT Z R); ALT took CTRL's old slot and L sits far right
  // (Ctrl itself lives at the arrow cluster's old SPC spot). Portrait now shows
  // the SAME rows as landscape — the old orientation-split is gone.
  return [
    { label: 'ESC',   action: { keys: ['esc'] } },
    { label: 'TAB',   action: { keys: ['tab'] } },
    { label: 'WIN',   action: { keys: ['win'] } },
    { label: 'ALT',   action: { keys: ['alt'] } },
    { label: 'L',     action: { click: 'left' } },
  ];
}
function defaultPadButtons() {
  // (DG moved into the arrow cluster in R8; L/M/R moved into the major row in R9;
  //  the ▲▼ scroll chips were removed in R11 — the pad's scroll dial replaces them)
  return [];
}
function defaultArrows() {
  // R13.6: the ⏎ / ⌫ / SPC slots moved OUT into the hold column — the freed
  // spots became Vol+ (above →) and Vol− (above ←), both hold-to-repeat, and
  // CTRL (a toggle modifier) at the old SPC spot. Every slot still remappable.
  return [
    { id: 'del',       label: 'DEL',  action: { keys: ['delete'] } },
    { id: 'vol_down',  label: 'Vol-', action: { keys: ['volume_down'] } },
    { id: 'up',        label: '↑',    action: { keys: ['up'] } },
    { id: 'vol_up',    label: 'Vol+', action: { keys: ['volume_up'] } },
    { id: 'v',         label: 'V',    action: { keys: ['ctrl', 'alt', 's'] } },
    // R13.8: DG left the arrow cluster (it lives in the modrow, left of M, now)
    // and its old bottom-left slot became a plain Z key — handy for Ctrl+Z.
    { id: 'z',         label: 'Z',    action: { keys: ['z'] } },
    { id: 'left',      label: '←',    action: { keys: ['left'] } },
    { id: 'down',      label: '↓',    action: { keys: ['down'] } },
    { id: 'right',     label: '→',    action: { keys: ['right'] } },
    { id: 'ctrl',      label: 'CTRL', action: { keys: ['ctrl'] } },
  ];
}
function defaultHolds() {
  // R13.6: the hold column is now SIX buttons — L · M · R on the upper half,
  // then Space · Enter · Backspace on the lower half (video editing: play /
  // pause, confirm, delete). Each is half the height the single L/R buttons
  // used to be (3 fit in the column's old height). L/R hold a mouse button, M
  // toggles autoscroll, SPC/⏎/⌫ send a real keypress. All six are remappable.
  return [
    { id: 'holdL',   label: 'L',   action: { hold: 'left' } },
    { id: 'holdM',   label: 'M',   action: { auto: true } },
    { id: 'holdR',   label: 'R',   action: { hold: 'right' } },
    { id: 'holdSPC', label: 'SPC', action: { keys: ['space'] } },
    { id: 'holdENT', label: '⏎',   action: { keys: ['enter'] } },
    { id: 'holdBKSP', label: '⌫',  action: { keys: ['backspace'] } },
  ];
}
function defaultProfile(name) {
  return {
    name,
    gestures: JSON.parse(JSON.stringify(DEFAULT_GESTURES)),
    majorRow: defaultMajorRow(),
    padButtons: defaultPadButtons(),
    arrows: defaultArrows(),
    holds: defaultHolds(),
    bank: defaultBankSections(),
  };
}
// R13.4: DaVinci Resolve Studio editing shortcuts — one "Editing" bank tab
// (Import / Export / tool search / page switching / undo-redo-save-marker) plus
// a plain "Clipboard" tab (Copy / Paste / Cut). Tapping a button sends the combo
// to the PC. Seeded into every profile on first load (idempotent migration
// below), fully editable in ⚙ Customize → Button bank.
function editingSection() {
  return {
    name: 'Editing',
    buttons: [
      // Import / Export
      { label: 'Import', title: 'Import media — ctrl i', action: { keys: ['ctrl', 'i'] }, kw: 'import media add files bring in' },
      { label: 'Export', title: 'Export — ctrl e', action: { keys: ['ctrl', 'e'] }, kw: 'export render deliver out' },
      // Effects — Chroma key (green screen) is the classic example of a keyword
      // search: type "chroma" or "green screen" and this tool appears.
      { label: 'Chroma', title: 'Chroma key (green screen) — Color page', action: { keys: ['shift', '6'] }, kw: 'chroma key green screen background remove cg color keyer color page' },
      // Search
      { label: 'Tool', title: 'Tool search — ctrl space', action: { keys: ['ctrl', 'space'] }, kw: 'tool search palette switcher' },
      { label: 'Find', title: 'Find / search — ctrl f', action: { keys: ['ctrl', 'f'] }, kw: 'find search locate' },
      // Edit
      { label: 'Save', title: 'Save project — ctrl s', action: { keys: ['ctrl', 's'] }, kw: 'save project store' },
      { label: 'Undo', title: 'Undo — ctrl z', action: { keys: ['ctrl', 'z'] }, kw: 'undo revert back' },
      { label: 'Redo', title: 'Redo — ctrl shift z', action: { keys: ['ctrl', 'shift', 'z'] }, kw: 'redo repeat forward' },
      { label: 'Dup', title: 'Duplicate — ctrl d', action: { keys: ['ctrl', 'd'] }, kw: 'duplicate dup copy clone' },
      { label: 'SelAll', title: 'Select all — ctrl shift a', action: { keys: ['ctrl', 'shift', 'a'] }, kw: 'select all everything' },
      { label: 'RipDel', title: 'Ripple delete — shift delete', action: { keys: ['shift', 'delete'] }, kw: 'ripple delete remove trim' },
      // In / Out / playhead
      { label: 'In', title: 'Mark in — i', action: { keys: ['i'] }, kw: 'in point mark in start' },
      { label: 'Out', title: 'Mark out — o', action: { keys: ['o'] }, kw: 'out point mark out end' },
      { label: 'Match', title: 'Match frame — f', action: { keys: ['f'] }, kw: 'match frame still sync' },
      { label: 'Mark', title: 'Add marker — m', action: { keys: ['m'] }, kw: 'marker add marker note flag' },
      // Transport — J K L shuttle (no mouse, no space needed)
      { label: '◀', title: 'Shuttle reverse — j', action: { keys: ['j'] }, kw: 'shuttle reverse rewind back' },
      { label: '■', title: 'Stop — k', action: { keys: ['k'] }, kw: 'stop halt transport' },
      { label: '▶', title: 'Shuttle forward — l', action: { keys: ['l'] }, kw: 'shuttle forward fast forward speed' },
      { label: '⏮', title: 'Timeline start — home', action: { keys: ['home'] }, kw: 'timeline start initial frame beginning home' },
      { label: '⏭', title: 'Timeline end — end', action: { keys: ['end'] }, kw: 'timeline end final frame last end' },
      // Pages (tabs) — Shift+1..6 + Ctrl+PageUp/PageDown cycling
      { label: 'Cut', title: 'Cut page — shift 1', action: { keys: ['shift', '1'] }, kw: 'cut page timeline tab edit page' },
      { label: 'Edit', title: 'Edit page — shift 2', action: { keys: ['shift', '2'] }, kw: 'edit page timeline tab' },
      { label: 'Fusion', title: 'Fusion page — shift 3', action: { keys: ['shift', '3'] }, kw: 'fusion page composite nodes' },
      { label: 'Color', title: 'Color page — shift 4', action: { keys: ['shift', '4'] }, kw: 'color page grading colour correction' },
      { label: 'Fair', title: 'Fairlight page — shift 5', action: { keys: ['shift', '5'] }, kw: 'fairlight page audio sound mix' },
      { label: 'Deliver', title: 'Deliver page — shift 6', action: { keys: ['shift', '6'] }, kw: 'deliver page export render output' },
      { label: '◀Pg', title: 'Previous page — ctrl pageup', action: { keys: ['ctrl', 'pageup'] }, kw: 'previous page tab prev pageup' },
      { label: 'Pg▶', title: 'Next page — ctrl pagedown', action: { keys: ['ctrl', 'pagedown'] }, kw: 'next page tab pagedown' },
    ],
  };
}
function clipboardSection() {
  return {
    name: 'Clipboard',
    buttons: [
      { label: 'Copy', title: 'Copy — ctrl c', action: { keys: ['ctrl', 'c'] }, kw: 'copy clone duplicate ctrl c' },
      { label: 'Paste', title: 'Paste — ctrl v', action: { keys: ['ctrl', 'v'] }, kw: 'paste insert ctrl v' },
      { label: 'Cut', title: 'Cut — ctrl x', action: { keys: ['ctrl', 'x'] }, kw: 'cut remove ctrl x' },
    ],
  };
}

function loadProfiles() {
  try { state.profiles = JSON.parse(localStorage.getItem('rc_profiles') || '{}'); }
  catch (e) { state.profiles = {}; }
  if (!state.profiles.Default) state.profiles.Default = defaultProfile('Default');
  state.activeName = localStorage.getItem('rc_active') || 'Default';
  if (!state.profiles[state.activeName]) state.activeName = 'Default';
  state.profile = state.profiles[state.activeName];
  // R8: DG moved out of the pad row into the arrow cluster — drop any stored
  // drag-toggle button so it doesn't show up twice on legacy profiles.
  for (const p of Object.values(state.profiles)) {
    if (Array.isArray(p.padButtons)) {
      const cleaned = p.padButtons.filter((b) => !(b && b.action && b.action.drag));
      if (cleaned.length !== p.padButtons.length) p.padButtons = cleaned;
    }
  }
  // R13.25: the TF (Tablet Friend) button was removed entirely — strip any
  // stored action.launch === 'tabletfriend' from every button list so a legacy
  // profile can never resurrect it.
  const dropTF = (list) => Array.isArray(list) ? list.filter((b) => !(b && b.action && b.action.launch === 'tabletfriend')) : list;
  for (const p of Object.values(state.profiles)) {
    if (Array.isArray(p.padButtons)) p.padButtons = dropTF(p.padButtons);
    if (Array.isArray(p.majorRow)) p.majorRow = dropTF(p.majorRow);
    if (Array.isArray(p.arrows)) p.arrows = dropTF(p.arrows);
    if (Array.isArray(p.holds)) p.holds = dropTF(p.holds);
    if (Array.isArray(p.bank)) {
      for (const sec of p.bank) if (sec && Array.isArray(sec.buttons)) sec.buttons = dropTF(sec.buttons);
    }
  }
  // R9: the rail got reshuffled — backspace/delete/space left the major row
  // (they're in the arrow cluster now), WIN replaced Enter, and the L/M/R quick
  // clicks moved in (L on the ⌫ slot, M on the DEL slot = far right edge; R
  // sits above M in the modifier row). Rebuild stored rows so legacy profiles
  // pick up the new layout instead of showing dead keys.
  const MAJOR_REMAP = [
    { test: (a) => !!(a && a.keys && a.keys.includes('backspace')), to: { label: 'L', action: { click: 'left' } } },
    { test: (a) => !!(a && a.keys && a.keys.includes('delete')),    to: { label: 'M', action: { click: 'middle' } } },
    { test: (a) => !!(a && a.keys && a.keys.includes('space')),     to: null },           // dropped — SPC lives in the arrows
    { test: (a) => !!(a && a.keys && a.keys.includes('enter')),     to: { label: 'WIN', action: { keys: ['win'] } } },
  ];
  for (const p of Object.values(state.profiles)) {
    if (!Array.isArray(p.majorRow)) continue;
    let changed = false;
    const next = [];
    for (const b of p.majorRow) {
      let mapped = false;
      for (const r of MAJOR_REMAP) {
        if (b && b.action && r.test(b.action)) {
          if (r.to) next.push(r.to);
          mapped = true; changed = true;
          break;
        }
      }
      if (!mapped) next.push(b);
    }
    if (changed) p.majorRow = next;
    // L/M/R click chips are gone from the pad row too — they live in the major
    // row / modifier row now.
    if (Array.isArray(p.padButtons)) {
      // L/M/R click chips are gone from the pad row (they live in the major/mod
      // rows now), and R11 removed the ▲▼ scroll chips — the pad's scroll dial
      // replaces them.
      const kept = p.padButtons.filter((b) => !(b && b.action && (
        ['left', 'middle', 'right'].includes(b.action.click) ||
        (b.label === '▲' || b.label === '▼')
      )));
      if (kept.length !== p.padButtons.length) p.padButtons = kept;
    }
  }
  // R13: the arrow cluster + hold row are now profile-driven. Old profiles
  // (pre-R13) lack `arrows` / `holds` — give them the defaults.
  for (const p of Object.values(state.profiles)) {
    if (!Array.isArray(p.arrows) || !p.arrows.length) p.arrows = defaultArrows();
    if (!Array.isArray(p.holds) || !p.holds.length) p.holds = defaultHolds();
    // R13.6: the hold column grew from 3 buttons (L·M·R) to 6 — append
    // Space / Enter / Backspace to any profile still holding the old 3
    // (idempotent: only adds the ids that are missing).
    const NEW_HOLDS = [
      { id: 'holdSPC',  label: 'SPC', action: { keys: ['space'] } },
      { id: 'holdENT',  label: '⏎',   action: { keys: ['enter'] } },
      { id: 'holdBKSP', label: '⌫',   action: { keys: ['backspace'] } },
    ];
    const hasId = (id) => (p.holds || []).some((h) => h && h.id === id);
    const missing = NEW_HOLDS.filter((h) => !hasId(h.id));
    if (missing.length) p.holds = [...(p.holds || []), ...missing];
    // R13.6: the arrow-cluster ⏎/⌫/SPC slots moved OUT into the hold column;
    // their freed spots became Vol+ (above →), Vol− (above ←) and CTRL (old SPC
    // spot). Only remaps a slot still holding its DEFAULT action — never clobbers
    // a user-customized key.
    const ARROW_REMAP = {
      backspace: { id: 'vol_down', label: 'Vol-', action: { keys: ['volume_down'] } },
      enter:     { id: 'vol_up',   label: 'Vol+', action: { keys: ['volume_up'] } },
      space:     { id: 'ctrl',     label: 'CTRL', action: { keys: ['ctrl'] } },
    };
    if (Array.isArray(p.arrows)) {
      p.arrows = p.arrows.map((s) => {
        const m = s && ARROW_REMAP[s.id];
        if (!m) return s;
        const k = s.action && s.action.keys;
        return (k && k.length === 1 && k[0] === s.id) ? { ...s, ...m } : s;
      });
      // R13.8: DG moved out to the modrow (left of M) — the old bottom-left
      // arrow slot becomes a Z key (only if it still does its default drag).
      p.arrows = p.arrows.map((s) => {
        if (s && s.id === 'dg' && s.action && s.action.drag) {
          return { id: 'z', label: 'Z', action: { keys: ['z'] } };
        }
        return s;
      });
    }
    // R13.6: the major row was reworked — ALT took the old CTRL slot, the
    // quick-click M moved out to the static mod row, L sits far right. Migrate
    // the old ESC·TAB·WIN·L·M layout in one shot (only if it still matches it).
    if (Array.isArray(p.majorRow) && p.majorRow.length === 5) {
      const r = p.majorRow;
      const k1 = (a) => a && a.keys && a.keys[0];
      const isOld = k1(r[0].action) === 'esc' && k1(r[1].action) === 'tab' &&
                    k1(r[2].action) === 'win' &&
                    r[3] && r[3].action && r[3].action.click === 'left' &&
                    r[4] && r[4].action && r[4].action.click === 'middle';
      if (isOld) p.majorRow = defaultMajorRow();
    }
    // R13.4: every profile gets the Editing + Clipboard bank tabs once
    // (idempotent — skip a section if the profile already has one with that name).
    const have = (n) => (p.bank || []).some((s) => s && (s.name || '').toLowerCase() === n);
    if (!have('editing')) p.bank = [...(p.bank || []), editingSection()];
    if (!have('clipboard')) p.bank = [...(p.bank || []), clipboardSection()];
    // R13.26: search keywords + the Chroma (green screen) example — merged into
    // EXISTING profiles so keyword search works everywhere. We never re-add a
    // button the user deleted; we only fill missing kw fields on buttons that are
    // already there (matched by label) and ADD the new Chroma tool if absent.
    for (const def of [editingSection(), clipboardSection()]) {
      const sec = (p.bank || []).find((s) => s && (s.name || '').toLowerCase() === def.name.toLowerCase());
      if (!sec || !Array.isArray(sec.buttons)) continue;
      const defBy = new Map(def.buttons.map((b) => [b.label, b]));
      for (const b of sec.buttons) {
        const d = b && defBy.get(b.label);
        if (d && !b.kw) b.kw = d.kw;
      }
      const chroma = def.buttons.find((b) => b.label === 'Chroma');
      if (chroma && !sec.buttons.some((b) => b && b.label === 'Chroma')) sec.buttons.unshift(chroma);
    }
    // R13.8: merge default gestures into every loaded profile — profiles saved
    // before R13.5 have no `circle` key, so gestureFor('circle') resolved to
    // undefined and the O gesture silently never fired even on a perfect circle.
    // Object.assign fills only MISSING keys; an explicit user "off" (null) is kept.
    if (p && typeof p === 'object') {
      p.gestures = Object.assign(JSON.parse(JSON.stringify(DEFAULT_GESTURES)), p.gestures || {});
    }
  }
}
function persistProfile() {
  if (!state.profile) return;
  state.profiles[state.profile.name] = state.profile;
  localStorage.setItem('rc_profiles', JSON.stringify(state.profiles));
  localStorage.setItem('rc_active', state.profile.name);
}
function activateProfile(name) {
  if (!state.profiles[name]) return;
  state.activeName = name;
  state.profile = state.profiles[name];
  persistProfile();
  renderAll();
}

/* ------------------------------------------------------------- helpers ---- */
function send(obj) {
  // RC-TRACE ws-send app.js:send — catches EVERY right-click crossing to the server, any caller
  if (obj && obj.type === 'click' && obj.button === 'right') console.log('[RC-TRACE] app.js:send WS click right/' + obj.action);
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  // ghost-input guard: ignore stray input for the first 500ms after load
  if (performance.now() < INPUT_SETTLED && obj.type !== 'hello' && obj.type !== 'ping') return;
  state.ws.send(JSON.stringify(obj));
}
function sendKey(name, action) { send({ type: 'key', key: name, action }); }
function pressKey(name) { sendKey(name, 'down'); setTimeout(() => sendKey(name, 'up'), 30); }
function sendLaunch(name) {
  setStatus('Launching ' + name + '…', 'warn');
  send({ type: 'launch', name });
}
function setStatus(text, cls) {
  $('status').textContent = text;
  $('dot').className = 'dot ' + (cls || '');
}
let clickUpTimer = null;   // R13.10: pending clickBtn release — pan mode cancels it
function clickBtn(button) {
  // RC-TRACE clickBtn app.js:clickBtn — one stack per click dispatch incl. reason
  if (button === 'right') console.log('[RC-TRACE] app.js:clickBtn dispatch right down, reason=clickBtn caller:', new Error('rc-trace').stack);
  send({ type: 'click', button, action: 'down' });
  if (clickUpTimer) clearTimeout(clickUpTimer);
  clickUpTimer = setTimeout(() => { clickUpTimer = null; if (button === 'right') console.log('[RC-TRACE] app.js:clickBtn dispatch right up (40ms timer)'); send({ type: 'click', button, action: 'up' }); }, 40);
}
function toggleDrag() {
  state.drag = !state.drag;
  if (state.dragBtn) state.dragBtn.classList.toggle('on', state.drag);
  send({ type: 'click', button: 'left', action: state.drag ? 'down' : 'up' });
}
function toggleHold(button, el) {
  // RC-TRACE toggleHold app.js:toggleHold — hold-R down+stuck = held context menu
  if (button === 'right') console.log('[RC-TRACE] app.js:toggleHold right, held=' + (state.holdBtn === button) + ' -> ' + (state.holdBtn === button ? 'up' : 'down'));
  // click-and-hold L/R (the hold buttons flanking the pad, R13.1): hold that
  // mouse button down (drag files, context menus); tap again to release. `el`
  // is the tapped hold button — optional, since a bank/arrow slot can also
  // trigger a hold action and those have no visual toggle to flip.
  const held = state.holdBtn === button;
  state.holdBtn = held ? null : button;
  send({ type: 'click', button, action: held ? 'up' : 'down' });
  if (el) el.classList.toggle('on', !held);
  const nm = button === 'left' ? 'Left' : button === 'right' ? 'Right' : 'Middle';
  setStatus(!held ? nm + ' held — tap again to release' : nm + ' released', !held ? 'warn' : '');
  setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
}
function toggleScrollMode() {
  // the round ↕ dial at the pad's top-right edge: switches the WHOLE pad into
  // scroll mode (drag = mouse wheel) and back to cursor mode
  state.scrollMode = !state.scrollMode;
  $('scroll-dial').classList.toggle('on', state.scrollMode);
  // R13.26: the mirrored bottom ↕ dial glows together with the top one
  const sdb = document.getElementById('scroll-dial-b');
  if (sdb) sdb.classList.toggle('on', state.scrollMode);
  // a held left button + scrolling = a stuck drag — let go if DG was on
  if (state.scrollMode && state.drag) toggleDrag();
  // the two dials are exclusive — turning scroll ON turns gesture OFF
  if (state.scrollMode && state.gestureMode) { state.gestureMode = false; $('gesture-dial').classList.remove('on'); }
  setStatus(state.scrollMode ? 'Scroll mode — drag to scroll' : 'Scroll mode off', state.scrollMode ? 'good' : '');
  setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  updateTpHint();
}
// R13.31 (bkp2): the ↕ scroll dial ALSO scrolls while HELD — press and hold it and
// the PC keeps scrolling (real wheel notches, downward) until you let go. A quick
// tap still toggles scroll mode (drag on the pad to scroll either way), so the ↕
// button is guaranteed to do something visible even if toggle-then-drag isn't what
// the user expects. Wired to BOTH the top and bottom dials.
function wireScrollDial(id) {
  const el = document.getElementById(id);
  if (!el) return;
  let holdT = null, held = false, didHold = false;
  const stop = () => {
    held = false;
    if (holdT) { clearInterval(holdT); holdT = null; }
  };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); e.preventDefault();
    held = true; didHold = false;
    // shorter than a tap (TAP_MS 380) = a quick tap → toggle; longer = a real
    // press → start scrolling and suppress the toggle when the finger lifts
    setTimeout(() => {
      if (held && !holdT) {
        didHold = true;
        holdT = setInterval(() => send({ type: 'scroll', dx: 0, dy: -1 }), 40);
        setStatus('Scrolling…', 'good');
      }
    }, 380);
  });
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  // a quick tap (released before the hold engaged) still toggles scroll mode
  el.addEventListener('click', () => { if (!didHold) toggleScrollMode(); });
}
function toggleAutoScroll() {
  // R12: the portrait M button = middle-click AUTOSCROLL. Tap M → a real middle
  // click, then move the finger up/down on the pad: the pad latches that
  // direction and keeps scrolling on its own (a mouse-dial feel) until you tap
  // M / the pad again. Apps with native middle-click autoscroll engage too.
  state.autoScroll.on = !state.autoScroll.on;
  const mBtn = document.querySelector('#hold-col [data-hold="holdM"]');
  if (mBtn) mBtn.classList.toggle('on', state.autoScroll.on);
  if (state.autoScroll.on) {
    if (state.scrollMode) { state.scrollMode = false; $('scroll-dial').classList.remove('on'); }
    if (state.gestureMode) { state.gestureMode = false; $('gesture-dial').classList.remove('on'); }
    clickBtn('middle');                  // a real middle click — native autoscroll hooks in
    state.autoScroll.dir = 0; state.autoScroll.mag = 1;
    ensureAutoScrollTimer();
    setStatus('Autoscroll — move up/down on the pad · tap M or the pad to stop', 'good');
  } else {
    if (state.autoScroll.timer) { clearInterval(state.autoScroll.timer); state.autoScroll.timer = null; }
    clickBtn('middle');                  // second middle click stops native autoscroll too
    setStatus('Autoscroll off', '');
  }
  setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  updateTpHint();
}
function togglePanMode() {
  // R13.10: DOUBLE-tap M = PAN MODE — like holding the physical mouse's scroll-dial
  // button. While ON the MIDDLE button is held down and the pad is a pure move
  // surface, so dragging in a zoomed DaVinci preview PANS it. M glows GREEN (the
  // autoscroll state is light-blue). Any tap on M releases; a short block window
  // stops the release-tap's partner from instantly re-engaging pan.
  state.panMode.on = !state.panMode.on;
  const mBtn = document.querySelector('#hold-col [data-hold="holdM"]');
  if (state.panMode.on) {
    // exclusive — every other pad mode must go so the pad is a pure move surface
    if (state.autoScroll.on) {
      state.autoScroll.on = false;
      if (state.autoScroll.timer) { clearInterval(state.autoScroll.timer); state.autoScroll.timer = null; }
      state.autoScroll.dir = 0;
    }
    if (state.scrollMode) { state.scrollMode = false; $('scroll-dial').classList.remove('on'); }
    if (state.gestureMode) { state.gestureMode = false; $('gesture-dial').classList.remove('on'); }
    if (mBtn) { mBtn.classList.remove('on'); mBtn.classList.add('pan'); }
    // kill the autoscroll engage's pending clickBtn release (40ms later) — it
    // would pop the middle button back up right after we grip it for pan
    if (clickUpTimer) { clearTimeout(clickUpTimer); clickUpTimer = null; }
    send({ type: 'click', button: 'middle', action: 'down' });   // the pan grip
    setStatus('Pan — drag to move the preview · tap M to release', 'good');
  } else {
    if (mBtn) mBtn.classList.remove('pan');
    send({ type: 'click', button: 'middle', action: 'up' });
    setStatus('Pan released', '');
  }
  setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  updateTpHint();
}
function toggleGestureMode() {
  // R13.7: the round ◯ dial at the pad's TOP-RIGHT corner. ON → the pad captures
  // one-finger traces and fires the mapped gesture (O = circle = default Ctrl+I)
  // on finger-lift WITHOUT moving the cursor — so nothing in DaVinci Resolve gets
  // hovered/triggered while you draw. Scroll mode / autoscroll are exclusive.
  state.gestureMode = !state.gestureMode;
  $('gesture-dial').classList.toggle('on', state.gestureMode);
  if (state.gestureMode) {
    if (state.scrollMode) { state.scrollMode = false; $('scroll-dial').classList.remove('on'); }
    if (state.autoScroll.on) {
      state.autoScroll.on = false;
      const mBtn = document.querySelector('#hold-col [data-hold="holdM"]');
      if (mBtn) mBtn.classList.remove('on');
      if (state.autoScroll.timer) { clearInterval(state.autoScroll.timer); state.autoScroll.timer = null; }
    }
    setStatus('Gesture mode — draw O, V or an n (Notepad) on the pad (no cursor move) · fires on lift · tap ◯ to exit', 'good');
  } else {
    setStatus('Gesture mode off', '');
  }
  setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  updateTpHint();
}
function ensureAutoScrollTimer() {
  // the engine runs the whole time autoscroll is on; it only emits while a
  // direction is latched, so it never fires without a gesture
  if (!state.autoScroll.timer) {
    state.autoScroll.timer = setInterval(() => {
      if (state.autoScroll.dir) send({ type: 'scroll', dx: 0, dy: state.autoScroll.dir * state.autoScroll.mag });
    }, AUTOSCROLL_MS);
  }
}
function runAction(a) {
  if (!a) return;
  // R29: seq = timed steps (e.g. Win → type app name → Enter = open an app with
  // NO config.json). Each step re-enters runAction after a short pause so the PC
  // sees them in order (Start menu needs a beat before the typing arrives).
  if (Array.isArray(a.seq) && a.seq.length) {
    const steps = a.seq.slice(0, 6);
    const gap = Math.max(80, Math.min(2000, Number(a.delay) || 300));
    steps.forEach((step, i) => { if (step) setTimeout(() => runAction(step), i * gap); });
    return;
  }
  if (a.keys) {
    // R29 safety: never send a key the PC server does not know — an unknown name
    // raises server-side and drops the whole control connection.
    const KNOWN = (window.RCActionPicker && RCActionPicker.knownKey) ? RCActionPicker.knownKey : null;
    const ks = KNOWN ? a.keys.filter(KNOWN) : a.keys;
    if (ks.length) send({ type: 'combo', keys: ks });
  }
  else if (a.text) send({ type: 'text', text: a.text });
  else if (a.click) clickBtn(a.click);
  else if (a.scroll) send({ type: 'scroll', dx: a.scroll[0] || 0, dy: a.scroll[1] || 0 });
  // R14: zoom = a RELATIVE wheel burst with ctrl held on the PC (do_zoom in
  // server.py) — the app at the cursor treats it as pinch-zoom. dir>0 in.
  else if (a.zoom) send({ type: 'zoom', dir: a.zoom });
  else if (a.drag) toggleDrag();
  else if (a.hold) toggleHold(a.hold);
  else if (a.auto) toggleAutoScroll();
  else if (a.launch) sendLaunch(a.launch);
}
function actionTitle(a) {
  if (!a) return 'No action';
  // R29: friendly name first (menu / plain-language actions carry their own label)
  if (a.label) return a.label;
  if (Array.isArray(a.seq)) return a.seq.map((s) => actionTitle(s)).filter((t) => t && t !== 'No action').join(' then ');
  if (a.keys) return a.keys.join(' + ');
  if (a.click) return a.click + ' click';
  if (a.scroll) return 'scroll ' + (a.scroll[1] > 0 ? 'up' : 'down');
  if (a.zoom) return 'zoom ' + (a.zoom > 0 ? 'in' : 'out');
  if (a.text) return 'type "' + a.text + '"';
  if (a.drag) return 'drag toggle';
  if (a.hold) return 'hold ' + a.hold + ' button';
  if (a.auto) return 'autoscroll (middle)';
  if (a.launch) return 'launch ' + a.launch;
  return 'No action';
}
function singleKeyOf(a) {
  // a plain {keys:[one key]} action — the arrow key keeps native data-key
  // handling (repeat, mod-tap) instead of a generic one-shot click
  if (!a || !a.keys || a.keys.length !== 1) return null;
  return a.keys[0];
}
const round = (v) => Math.round(v * 100) / 100;

/* ------------------------------------------------------------ connect ---- */
async function init() {
  try {
    const r = await fetch('api/info', { cache: 'no-store' });
    const info = await r.json();
    WS_PORT = info.ws_port || WS_PORT;
    if (isPcView()) showPcBanner(info);
  } catch (e) { /* server still starting; defaults are fine */ }

  loadProfiles();
  if (!state.profile) state.profile = defaultProfile('Default');

  setupTypeBar();
  setupStream();
  await loadButtons();
  setupKeys();
  setupTrackpad();
  setupUi();
  setupTrainer();
  setupTester();
  // Train ↔ Lab bridge: index.html#train (the lab's "← Back to Train" link)
  // reopens the wizard straight away instead of leaving the user hunting.
  if (location.hash === '#train') setTimeout(() => { try { openTrainPanel(); } catch (e) {} }, 400);
  renderMajorRow();
  renderPadButtons();
  renderArrows();
  renderHolds();
  renderHotkeys();
  updateTpHint();

  // R13.15: boot mode-aware — a saved BT link goes through the full BT
  // discovery (which auto-falls back to Wi‑Fi if the PC has no PAN), so the
  // app can never boot straight into a dead BT-PAN address and loop forever.
  if (state.linkMode === 'bt') connectBluetooth(); else connect();
  // RC-TIMER ping app.js:init — 2s keepalive; sends ping only, never clicks.
  // Logged so a ~30-40s phantom cadence can be ruled OUT against this 2s beat.
  console.log('[RC-TIMER ping create] app.js:init interval=2000ms');
  setInterval(() => { console.log('[RC-TIMER ping fire] app.js:pingLoop'); pingLoop(); }, 2000);
  requestAnimationFrame(sizeTrackpad);
  window.addEventListener('resize', sizeTrackpad);
}

function isPcView() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/* --------------------------------------------------- link mode (R) ---- */
/* The page is served over Wi-Fi, but the WebSocket can hop the PC's Bluetooth
 * link instead. The tablet hosts a Bluetooth tether (Settings → Tethering →
 * Bluetooth tethering); the PC joins it (pair the tablet, then Join a Personal
 * Area Network) and the server answers on the PAN interface too — it already
 * binds 0.0.0.0. Wi‑Fi and BT are INDEPENDENT connections: each owns its own
 * socket to its own host, and switching tears the old one down before opening
 * the new, so the two links never mix. */
const RC_BT_KEY = 'rc_bt_ip', RC_LINK_KEY = 'rc_link';
let activeHost = location.hostname;
const savedBt = localStorage.getItem(RC_BT_KEY);
if (localStorage.getItem(RC_LINK_KEY) === 'bt' && savedBt) activeHost = savedBt;
state.linkMode = (localStorage.getItem(RC_LINK_KEY) === 'bt' && savedBt) ? 'bt' : 'wifi';

function wsClosed() {
  state.connected = false;
  // R13.10: a dropped link must release the pan grip (server also releases all
  // buttons on disconnect, so this is just the client's visual state)
  if (state.panMode.on) {
    state.panMode.on = false;
    const panBtn = document.querySelector('#hold-col [data-hold="holdM"]');
    if (panBtn) panBtn.classList.remove('pan');
  }
  setStatus('Disconnected', 'bad');
  scheduleReconnect();
}

// R13.24 (bkp2): a tab that sat across a server restart / Wi-Fi blip can come
// back from the browser's page cache (bfreeze) with its reconnect timer frozen —
// a plain refresh then shows the dead page forever. Whenever the tab becomes
// visible/active again, force an immediate reconnect if we're not connected.
function forceReconnectIfNeeded() {
  // RC-TRACE reconnect app.js:forceReconnectIfNeeded — a reconnect cycle runs
  // server release_all() (touches Button.right); log to correlate with log tags
  console.log('[RC-TRACE] app.js:forceReconnectIfNeeded connected=' + state.connected);
  if (state.connected || state.ws && state.ws.readyState === WebSocket.CONNECTING) return;
  state.retry = 0;
  scheduleReconnect();
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) forceReconnectIfNeeded();
  });
  window.addEventListener('pageshow', (e) => {
    if (e.persisted || !state.connected) forceReconnectIfNeeded();
  });
}

function setLinkMode(mode) {
  state.linkMode = mode;
  localStorage.setItem(RC_LINK_KEY, mode);
  const wifiBtn = $('lm-wifi'), btBtn = $('lm-bt');
  if (wifiBtn) { wifiBtn.classList.toggle('on', mode === 'wifi'); btBtn.classList.toggle('on', mode === 'bt'); }
  // tear the old socket down cleanly so the two links can never mingle
  if (state.ws) { const w = state.ws; state.ws = null; w.onclose = null; try { w.close(); } catch (e) {} }
  state.retry = 0;
  if (mode === 'bt') { setStatus('Bluetooth…', 'warn'); connectBluetooth(); }
  else { activeHost = location.hostname; connect(); }
}

// Try each candidate BT-PAN address; the first that completes a hello wins.
function tryConnect(ip) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); resolve(ok); };
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${ip}:${WS_PORT}/`);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} finish(false); }, 1500);
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'hello', pin: state.pin })); } catch (e) {} };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'welcome') {
        state.retry = 0;
        state.ws = ws; state.connected = true;
        activeHost = ip;
        localStorage.setItem(RC_BT_KEY, ip);
        setStatus('Connected · BT ' + ip, 'good');
        ws.onopen = null;                     // hello already sent
        ws.onmessage = (e2) => { try { handleMsg(JSON.parse(e2.data)); } catch (e) {} };
        ws.onclose = wsClosed;
        ws.onerror = () => { try { ws.close(); } catch (e) {} };
        finish(true);
      } else if (m.type === 'error' && m.message === 'wrong pin') {
        finish(false);
      }
    };
    ws.onerror = () => { finish(false); };
    ws.onclose = () => { finish(false); };
  });
}

// BT discovery, in order: ask the (still-alive Wi-Fi) server to FORCE the PC
// to join the tablet's Bluetooth-tether PAN (/api/btjoin — the same call
// Windows makes for "Connect using → Access point") → remembered IP → server's
// Bluetooth-PAN IP → quick-scan Android tethering subnets.
async function connectBluetooth() {
  const cands = [];
  const saved = localStorage.getItem(RC_BT_KEY);
  if (saved) cands.push(saved);
  try {
    // first make the PC join the pad's PAN, so a BT-PAN address appears at all
    const j = await (await fetch('api/btjoin', { cache: 'no-store' })).json();
    if (j && j.ips) for (const ip of j.ips) if (!cands.includes(ip)) cands.push(ip);
  } catch (e) { /* Wi-Fi already down — fall through */ }
  if (cands.length <= 1) {
    try {
      const r = await fetch('api/btips?exclude=' + encodeURIComponent(location.hostname), { cache: 'no-store' });
      const j = await r.json();
      for (const ip of (j.ips || [])) if (!cands.includes(ip)) cands.push(ip);
    } catch (e) { /* fall through to the subnet scan */ }
  }
  const toTry = cands.length ? cands : await scanSubnets();
  for (const ip of toTry) { if (await tryConnect(ip)) return; }
  // R13.15: BT gave up (this PC has no working Bluetooth-PAN) — fall back to
  // the Wi‑Fi link automatically so the app is never stranded in a dead mode.
  setLinkMode('wifi');
  setStatus('BT: PC not found — back on Wi‑Fi', 'warn');
}

// Only used when Wi-Fi is down and we never learned the BT IP: probe the usual
// Android tethering subnets (192.168.44.x / 192.168.42.x) for the server HTTP
// banner, in parallel and fast, then WS-connect whatever answers.
async function scanSubnets() {
  const hits = [];
  const probe = (ip) => new Promise((res) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 350);
    fetch('http://' + ip + ':' + location.port + '/api/info', { signal: ctl.signal, cache: 'no-store' })
      .then(r => { clearTimeout(t); if (r.ok) hits.push(ip); res(); })
      .catch(() => { clearTimeout(t); res(); });
  });
  const ips = [];
  for (const a of [44, 42]) for (let i = 1; i <= 20; i++) ips.push('192.168.' + a + '.' + i);
  await Promise.all(ips.map(probe));
  return hits;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const viaTunnel = proto === 'wss' && RC_TUNNEL && activeHost === location.hostname;
  state.ws = viaTunnel
    ? new WebSocket(`${proto}://${RC_TUNNEL}/`)
    : new WebSocket(`${proto}://${activeHost}:${WS_PORT}/`);
  state.ws.onopen = () => {
    state.retry = 0;
    setStatus('Connecting…', 'warn');
    send({ type: 'hello', pin: state.pin });
  };
  state.ws.onmessage = (ev) => { try { handleMsg(JSON.parse(ev.data)); } catch (e) {} };
  state.ws.onclose = wsClosed;
  state.ws.onerror = () => { try { state.ws.close(); } catch (e) {} };
}

function scheduleReconnect() {
  const delay = Math.min(1000 * Math.pow(2, state.retry++), 10000);
  // RC-TIMER reconnect app.js:scheduleReconnect — retries max out at 10s; two
  // stacked timers (~30-40s apart after backoff reaches cap) are NOT from here
  // unless this fires repeatedly, so log create+fire to rule it in/out.
  const _rcId = 'reconnect-' + Date.now() + '-' + state.retry;
  console.log('[RC-TIMER ' + _rcId + ' create] app.js:scheduleReconnect delay=' + delay + 'ms retry=' + state.retry);
  setTimeout(() => { console.log('[RC-TIMER ' + _rcId + ' fire] app.js:scheduleReconnect'); if (!state.connected) connect(); }, delay);
}

function handleMsg(m) {
  if (m.type === 'welcome') {
    state.connected = true;
    setStatus('Connected', 'good');
  } else if (m.type === 'pong') {
    $('latency').textContent = (Date.now() - m.t) + ' ms';
  } else if (m.type === 'error' && m.message === 'wrong pin') {
    showPinModal();
  } else if (m.type === 'launch_result') {
    if (m.ok) setStatus(m.name + ' launched ✓', 'good');
    else setStatus('Launch failed: ' + (m.error || 'unknown'), 'bad');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 3000);
  }
}
function pingLoop() { if (state.connected) send({ type: 'ping', t: Date.now() }); }

/* --------------------------------------------------- screen stream (R13) ---- */
/* The PC screen streams to the tablet as MJPEG (a plain <img> tag — the
 * browser decodes it natively, nothing to install). The strip is PORTRAIT-only
 * and sits at the very top; 🖥 collapses it to zero height. The server does no
 * screen work while the stream is closed (capture lives inside the /api/screen
 * HTTP handler), so leaving it off costs nothing. mss doesn't capture the
 * cursor, so the server pushes the real position and we draw a small arrow
 * overlay on top of the streamed image. */
const STREAM_Q = {
  // R13.3: fps up (fresher frames = less visible delay), quality down a touch.
  // The SERVER adapts automatically: if the tablet's Wi-Fi can't push a frame
  // at the requested rate it drops q (then width) until the link keeps up, so
  // the stream never stutters into "flickering cursor" territory. Med (1280)
  // is native for the 1184px strip; High (1920) is the monitor's full 1080p —
  // the hard maximum (2K/4K would just upscale the same source).
  low:  { w: 854,  q: 50, fps: 20, label: 'Low' },
  med:  { w: 1280, q: 70, fps: 24, label: 'Med' },
  high: { w: 1920, q: 80, fps: 30, label: 'High' },
};
let streamQ = localStorage.getItem('rc_stream_q') || 'med';
if (!STREAM_Q[streamQ]) streamQ = 'med';
let screenInfo = null;   // {w,h} of the PC's primary monitor (from /api/screeninfo)
let streamOn = localStorage.getItem('rc_stream') === '1';   // the 🖥 preference

function streamUrl() {
  const s = STREAM_Q[streamQ];
  return `/api/screen?w=${s.w}&q=${s.q}&fps=${s.fps}&ts=${Date.now()}`;
}

// R13.16: newest-frame MJPEG renderer. A plain <img src=multipart> decodes EVERY
// JPEG the browser buffered, IN ORDER — so after a Wi-Fi latency spike the
// tablet fast-forwards through stale frames (cursor painted at old positions) =
// the "jumps from one frame to another / one area to another" feel. Instead we
// fetch the stream and hand-parse it, keeping only the LATEST complete frame per
// animation frame and DROPPING older ones: a spike now shows a brief hold, then
// the LIVE picture. When the link is smooth it looks identical to before.
let streamCtl = null;   // AbortController for the live screen fetch
let _streamEnc = null;
function _frameBoundary() {
  if (!_streamEnc) _streamEnc = new TextEncoder();
  return _streamEnc.encode('--RCframe');
}
function _indexOfSub(hay, needle, from) {
  for (let i = from; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}
function _indexOfCrlfCrlf(hay, from) {
  for (let i = from; i + 4 <= hay.length; i++)
    if (hay[i] === 13 && hay[i + 1] === 10 && hay[i + 2] === 13 && hay[i + 3] === 10) return i;
  return -1;
}
// Parse a raw MJPEG buffer: return { frame: newest complete JPEG bytes (or
// null), tail: unparsed remainder }. Pure + testable — called on every chunk.
function newestFrame(buf) {
  const needle = _frameBoundary();
  let tail = buf;
  let latest = null;
  for (;;) {
    const b = _indexOfSub(tail, needle, 0);
    if (b < 0) break;
    const hdr = _indexOfCrlfCrlf(tail, b + needle.length);
    if (hdr < 0) break;
    const m = /Content-Length:\s*(\d+)/i.exec(
      new TextDecoder().decode(tail.slice(b + needle.length, hdr)));
    if (!m) break;
    const bodyStart = hdr + 4, frameEnd = bodyStart + parseInt(m[1], 10);
    if (frameEnd + 2 > tail.length) break;      // frame not complete yet — wait
    latest = tail.slice(bodyStart, frameEnd);
    tail = tail.slice(frameEnd + 2);            // drop the trailing \r\n
  }
  return { frame: latest, tail };
}
function stopStream() {
  if (streamCtl) { try { streamCtl.abort(); } catch (e) {} streamCtl = null; }
  $('stream-img').removeAttribute('src');       // closing the HTTP stream stops capture
}
async function runStream() {
  stopStream();
  const ctl = new AbortController();
  streamCtl = ctl;
  const img = $('stream-img');
  try {
    const res = await fetch(streamUrl(), { cache: 'no-store', signal: ctl.signal });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    let buf = new Uint8Array(0);
    let pending = null;                          // newest complete frame awaiting paint
    let raf = 0;                                 // 0 = no paint scheduled
    let _blobUrl = null;                         // R14: reuse blob URL across frames
    const paint = () => {
      raf = 0;
      if (!pending) return;
      if (_blobUrl) URL.revokeObjectURL(_blobUrl);
      _blobUrl = URL.createObjectURL(new Blob([pending], { type: 'image/jpeg' }));
      img.src = _blobUrl;
      pending = null;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done || ctl.signal.aborted) break;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf); merged.set(value, buf.length);
      const { frame, tail } = newestFrame(merged);
      buf = tail;
      if (frame) {
        pending = frame;                         // drop any older buffered frame
        if (!raf) raf = requestAnimationFrame(paint);
      }
    }
  } catch (e) { /* aborted or the link closed — normal stop */ }
  finally { if (streamCtl === ctl) streamCtl = null; }
}

function applyStream() {
  // The strip follows the user's wish in EVERY orientation. It used to also
  // require isPortrait(), so on a tablet/phone held sideways 🖥 Show set the
  // flag, started nothing and drew nothing — reported as "Show does nothing".
  const active = streamOn;
  const bar = $('streambar');
  bar.classList.toggle('off', !active);
  document.body.classList.toggle('stream-on', active);   // R13.27: while the PC screen is shown, the whole right rail scrolls instead of clipping
  $('stream-toggle').textContent = active ? '🖥 Hide' : '🖥 Show';
  if (active && !streamCtl) {
    runStream();
    $('stream-tip').textContent = 'PC screen';
    fetch('api/screeninfo', { cache: 'no-store' })
      .then(r => r.json())
      .then(i => {
        screenInfo = (i && i.ok) ? i.monitor : null;
        $('stream-tip').textContent = screenInfo
          ? `PC screen · ${screenInfo.w}×${screenInfo.h}`
          : 'PC screen (unavailable)';
      })
      .catch(() => { screenInfo = null; $('stream-tip').textContent = 'PC screen (unavailable)'; });
  } else if (!active) {
    stopStream();                      // closing the HTTP stream stops capture
    screenInfo = null;
    $('stream-tip').textContent = 'PC screen · off';
  }
  // R13.42k: re-apply the persisted stream-stage height AFTER the on/off toggle
  // (clamped to the current viewport) so rotation/resize can't strand a stale
  // value — then re-fit the pad, which measures the bar + splitter heights.
  if (applySavedStreamH) { try { applySavedStreamH(); } catch (e) {} }
  sizeTrackpad();   // the strip changed #layout's height — re-fit the pad
}

function setStreamPref(on) {
  streamOn = on;
  localStorage.setItem('rc_stream', on ? '1' : '0');
  applyStream();
}

function cycleStreamQ() {
  const keys = Object.keys(STREAM_Q);
  streamQ = keys[(keys.indexOf(streamQ) + 1) % keys.length];
  localStorage.setItem('rc_stream_q', streamQ);
  $('stream-qual').textContent = '⚙ ' + STREAM_Q[streamQ].label;
  if (streamOn) runStream();                                        // restart at the new quality
}

function toggleStreamFullscreen() {
  const el = document.documentElement;
  if (document.fullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    if (r && r.catch) r.catch(() => {});   // e.g. a modal is open / gesture not accepted
  }
}

function setupStream() {
  $('stream-qual').textContent = '⚙ ' + STREAM_Q[streamQ].label;
  $('stream-toggle').addEventListener('click', () => setStreamPref(!streamOn));
  $('stream-qual').addEventListener('click', cycleStreamQ);
  $('stream-full').addEventListener('click', toggleStreamFullscreen);
  setupStreamZoom();
  applyStream();
}

/* ------------------------------------------------ R13.39 stream zoom --------- */
/* Pinch-zoom (and 1-finger pan while zoomed) INSIDE the stream stage only. The
 * stage keeps its layout height (aspect of the frame) and clips; the <img> is
 * transform: scale(z) translate(tx,ty) above it. Double-tap toggles 1× ↔ 2.5×.
 * Purely presentational — the MJPEG stream, trackpad and buttons are untouched. */
const streamZoom = { z: 1, tx: 0, ty: 0 };
const STREAM_ZMIN = 1, STREAM_ZMAX = 4, STREAM_ZDBL = 2.5;
function streamZoomApply() {
  const img = $('stream-img'), stage = $('stream-stage');
  img.style.transform = `scale(${streamZoom.z}) translate(${streamZoom.tx}px, ${streamZoom.ty}px)`;
  $('stream-zoom-reset').classList.toggle('hidden', streamZoom.z <= 1.01);
  $('stream-zoom-reset').textContent = `⤾ ${streamZoom.z.toFixed(1)}×`;
  stage.classList.toggle('zoomable', true);
}
function streamZoomReset() {
  streamZoom.z = 1; streamZoom.tx = 0; streamZoom.ty = 0;
  const img = $('stream-img');
  img.style.transform = '';
  $('stream-zoom-reset').classList.add('hidden');
}
function streamZoomClamp() {
  // keep the picture covering the stage: translate bounded so no black gap shows
  const stage = $('stream-stage'), img = $('stream-img');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  if (!sw || !sh) return;
  const iw = img.clientWidth, ih = img.clientHeight;
  if (!iw || !ih) return;
  const zw = iw * streamZoom.z, zh = ih * streamZoom.z;
  // translate is in pre-scale px (origin 0 0): max shift = (scaled - stage) / z
  const mx = Math.max(0, (zw - sw) / streamZoom.z);
  const my = Math.max(0, (zh - sh) / streamZoom.z);
  streamZoom.tx = Math.min(0, Math.max(-mx, streamZoom.tx));
  streamZoom.ty = Math.min(0, Math.max(-my, streamZoom.ty));
}
function setupStreamZoom() {
  const stage = $('stream-stage');
  stage.classList.add('zoomable');
  $('stream-zoom-reset').addEventListener('click', (e) => { e.stopPropagation(); streamZoomReset(); });
  const pts = new Map();   // pointerId -> {x,y}
  let pinchD0 = 0, pinchZ0 = 1, pinchCx0 = 0, pinchCy0 = 0;
  let lastTap = 0, lastTapX = 0, lastTapY = 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchD0 = dist(a, b) || 1;
      pinchZ0 = streamZoom.z;
      const r = $('stream-img').getBoundingClientRect();
      pinchCx0 = (a.x + b.x) / 2 - r.left;
      pinchCy0 = (a.y + b.y) / 2 - r.top;
    }
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.preventDefault();
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = dist(a, b) || 1;
      const nz = Math.min(STREAM_ZMAX, Math.max(STREAM_ZMIN, pinchZ0 * d / pinchD0));
      // zoom anchored at the CURRENT pinch midpoint: the img point under it
      // stays put. screen = z·(imgPt + t)  →  t_new = midStage/nz - imgPt.
      // (offsetLeft/Top, NOT getBoundingClientRect — the rect lies while the
      // img is mid-transform; offsets are layout truth.)
      const img = $('stream-img');
      const sr = stage.getBoundingClientRect();   // stage itself is untransformed
      const midSx = (a.x + b.x) / 2 - sr.left - img.offsetLeft;
      const midSy = (a.y + b.y) / 2 - sr.top - img.offsetTop;
      const oz = streamZoom.z;
      streamZoom.tx = midSx / nz - (midSx / oz - streamZoom.tx);
      streamZoom.ty = midSy / nz - (midSy / oz - streamZoom.ty);
      streamZoom.z = nz;
      streamZoomClamp();
      streamZoomApply();
    } else if (pts.size === 1 && streamZoom.z > 1.01) {
      // 1-finger pan while zoomed (translate in pre-scale px)
      streamZoom.tx += dx / streamZoom.z;
      streamZoom.ty += dy / streamZoom.z;
      streamZoomClamp();
      streamZoomApply();
    }
  });
  const up = (e) => {
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchD0 = 0;
    // double-tap toggles 1× ↔ 2.5× (centered on the tap, or reset)
    const now = performance.now();
    if (p && pts.size === 0) {
      if (now - lastTap < 300 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40) {
        if (streamZoom.z > 1.01) {
          streamZoomReset();
        } else {
          // center the tapped point at 2.5× (offsets are layout truth)
          const img = $('stream-img');
          const sr = stage.getBoundingClientRect();
          const px = (e.clientX - sr.left - img.offsetLeft) / streamZoom.z;
          const py = (e.clientY - sr.top - img.offsetTop) / streamZoom.z;
          streamZoom.z = STREAM_ZDBL;
          // want tapped point px centered: z·(px + t) = stageW/2 → t = stageW/2/z − px
          streamZoom.tx = (sr.width / 2 / STREAM_ZDBL - px);
          streamZoom.ty = (sr.height / 2 / STREAM_ZDBL - py);
          streamZoomClamp();
          streamZoomApply();
        }
        lastTap = 0;
        return;
      }
      lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  // reset zoom when the stream restarts / stops so a stale transform never shows
  new MutationObserver(() => { if ($('streambar').classList.contains('off')) streamZoomReset(); })
    .observe($('streambar'), { attributes: true, attributeFilter: ['class'] });
}

/* --------------------------------------------------------- type bar ------- */
/* The type bar is a real input, so the tablet's OWN keyboard (Gboard etc.)
 * opens when tapped. Live mode types straight onto the PC as you type.
 * Send mode composes first, then types everything on Send / Enter. */
const MODS = new Set(['ctrl', 'shift', 'alt', 'win']);
let liveMode = true;
let typeOldVal = '';       // last value we diffed against, so backspaces are caught

function setupTypeBar() {
  const input = $('typeInput');

  // Diff old value -> new value and send the difference to the PC.
  // In Live mode the box is a mirror of what is being typed on the PC, so
  // backspaces and autocorrect changes are forwarded too. In Send mode the
  // box just collects text until Send / Enter.
  // Gboard (and most Android soft keyboards) delete a character via a
  // beforeinput with inputType "deleteContentBackward" / "deleteContentForward".
  // The value-diff below usually catches deletions too, but some Android
  // WebViews/Chrome versions never fire a value-changing "input" for soft-key
  // backspace — so we mirror the deletion at the beforeinput level and tell the
  // diff to stand down, otherwise the PC would get the delete twice.
  let mirroredDelete = false;
  input.addEventListener('beforeinput', (e) => {
    const t = e.inputType || '';
    if (t === 'deleteContentBackward') {
      pressKey('backspace'); mirroredDelete = true;
    } else if (t === 'deleteContentForward') {
      pressKey('delete'); mirroredDelete = true;
    }
    // deleteWordBackward / deleteByCut / drag-deletes: the value-diff below
    // counts the exact number of removed characters, so it handles those.
    if (mirroredDelete) setTimeout(() => { mirroredDelete = false; }, 120);
  });
  input.addEventListener('input', () => {
    const v = input.value;
    let i = 0;
    while (i < v.length && i < typeOldVal.length && v[i] === typeOldVal[i]) i++;
    const removed = typeOldVal.length - i;
    const added = v.slice(i);
    if (liveMode) {
      if (!mirroredDelete) {
        for (let k = 0; k < removed; k++) setTimeout(() => pressKey('backspace'), k * 30);
      }
      if (added) send({ type: 'text', text: added });
    }
    mirroredDelete = false;
    typeOldVal = v;
  });

  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    if (liveMode) {
      pressKey('enter');            // Enter goes straight to the PC
      input.value = ''; typeOldVal = '';
    } else {
      sendTextFromBox();            // Send mode: Enter = Send
    }
  });

  $('typeLive').addEventListener('click', () => {
    liveMode = !liveMode;
    $('typeLive').classList.toggle('on', liveMode);
    $('typeLive').textContent = liveMode ? '⌨ Live' : '💬 Send';
    $('typeSend').style.display = liveMode ? 'none' : '';
    if (liveMode && input.value) {  // flush anything composed in Send mode
      send({ type: 'text', text: input.value });
      typeOldVal = input.value;     // the box stays as the live mirror
    }
  });

  $('typeSend').addEventListener('click', sendTextFromBox);
  $('typeClear').addEventListener('click', () => { input.value = ''; typeOldVal = ''; input.focus(); });
}

function sendTextFromBox() {
  const input = $('typeInput');
  const t = input.value;
  if (!t) return;
  send({ type: 'text', text: t });
  if ($('typeEnter').checked) pressKey('enter');
  input.value = ''; typeOldVal = '';
}

/* ------------------------------------------------------ keys (mods+arrows) */
/* Handles the permanent modifier row and arrow row. Buttons without data-key
 * (custom major-row actions) are handled elsewhere with click events. */
function setupKeys() {
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.key');
    if (!el || !el.dataset.key) return;
    e.preventDefault();
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    keyDown(el.dataset.key, el);
  });
  document.addEventListener('pointerup', (e) => {
    const el = e.target.closest('.key');
    if (el && el.dataset.key) keyUp(el.dataset.key, el);
  });
  document.addEventListener('pointercancel', (e) => {
    const el = e.target.closest('.key');
    if (el && el.dataset.key) keyUp(el.dataset.key, el);
  });
}

function keyDown(name, el) {
  if (MODS.has(name)) {
    if (state.toggledMods.has(name)) {
      sendKey(name, 'up');
      state.toggledMods.delete(name);
      el.classList.remove('on');
    } else {
      sendKey(name, 'down');
      state.toggledMods.add(name);
      el.classList.add('on');
    }
    return;
  }
  sendKey(name, 'down');
  state.held.add(name);
  // R12: hold a repeatable key (⌫ DEL arrows SPC) and it keeps sending — just
  // like a physical keyboard. Windows would repeat a held key, but the browser
  // long-press used to cancel the hold before that kicked in; this drives the
  // repeat ourselves (snappier than the OS initial delay, too).
  if (REPEAT_KEYS.has(name)) {
    clearInterval(state.repeatTimer);
    state.repeatTimer = setTimeout(() => {
      state.repeatTimer = setInterval(() => { sendKey(name, 'up'); sendKey(name, 'down'); }, REPEAT_EVERY);
    }, REPEAT_START);
  }
}

function keyUp(name, el) {
  if (MODS.has(name)) return;       // modifiers are toggle-managed
  if (state.repeatTimer) { clearTimeout(state.repeatTimer); clearInterval(state.repeatTimer); state.repeatTimer = null; }
  if (state.held.has(name)) {
    sendKey(name, 'up');
    state.held.delete(name);
  }
}

/* -------------------------------------------------------- button bank ---- */
// R13.6: the predefined left-panel sections are a SAFETY NET — they can never
// be permanently wiped by an accidental ✕. Every default section (buttons.json
// + the built-in Editing / Clipboard tabs) is restored into the bank on load if
// it's missing (idempotent by name — custom sections are never touched), and a
// "Restore defaults" button in ⚙ → Button bank does the same on demand.
let JSON_SECTIONS = null;   // cached copy of buttons.json, first successful fetch

function defaultBankSections() {
  return [...(JSON_SECTIONS || []), editingSection(), clipboardSection()]
    .filter(Boolean).map((s) => JSON.parse(JSON.stringify(s)));
}
// make sure every predefined section is present in a bank (adds the missing ones)
function ensureDefaultSections(bank) {
  if (!Array.isArray(bank)) bank = [];
  const have = (n) => bank.some((s) => s && (s.name || '').toLowerCase() === (n || '').toLowerCase());
  for (const d of defaultBankSections()) {
    if (d && d.name && !have(d.name)) bank.push(JSON.parse(JSON.stringify(d)));
  }
  return bank;
}

async function loadButtons() {
  try {
    if (!JSON_SECTIONS) {
      const r = await fetch('buttons.json', { cache: 'no-store' });
      JSON_SECTIONS = (await r.json()).sections || [];
    }
  } catch (e) { JSON_SECTIONS = JSON_SECTIONS || []; }
  state.profile.bank = ensureDefaultSections(state.profile.bank);
  persistProfile();
  renderBank(state.profile.bank);
}

// R13.25 (bkp2 only): Windows-Start-tile icons for the bank. Labels are
// auto-mapped so no button data needs an icon field; a stored btn.icon always
// wins. A label that is already a single glyph (◀ ■ ▶ 1 2 … ← ↑) is shown big
// as the icon itself with no sub-label below.
const BANK_ICONS = {
  Import: '📥', Export: '📤', Tool: '🛠', Find: '🔍',
  Save: '💾', 'Save as': '💽', Undo: '↩', Redo: '↪',
  Dup: '📄', SelAll: '✅', 'Select all': '✅', RipDel: '🗑',
  In: '↤', 'In point': '↤', Out: '↦', 'Out point': '↦',
  Match: '🔗', Mark: '📌',
  Copy: '📑', Paste: '📋', Cut: '✂',
  Edit: '✏', Fusion: '🔥', Color: '🎨', Fair: '🎵', Deliver: '📦',
  '◀Pg': '⏪', 'Pg▶': '⏩',
  New: '🆕', Open: '📂', Esc: '⎋', 'Play/Pause': '⏯',
  'Prev frame': '⏪', 'Next frame': '⏩', 'Go start': '⏮', 'Go end': '⏭',
  'Split / Del': '✂', PgUp: '⤒', PgDn: '⤓',
  "Type 'hello'": '⌨', 'Type name': '👤',
};
function isGlyphOnly(s) { return !!s && s.length <= 2 && !/[A-Za-z]/.test(s); }
function bankIconFor(btn) {
  const lab = btn.label || '';
  if (btn.icon) return btn.icon;
  if (BANK_ICONS[lab]) return BANK_ICONS[lab];
  if (isGlyphOnly(lab)) return lab;
  return '🔘';
}

function renderBankTabs(sections) {
  const tabsEl = $('bank-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  // Always-visible tab bar → one tap switches, one tap back. Tapping a tab also
  // clears any search (both sides) so you always land on the full section.
  const makeTab = (label, idx) => {
    const b = document.createElement('button');
    b.className = 'bbtn-tab' + (state.bankTab === idx ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => { state.bankTab = idx; renderBankTabs(sections); clearSearch(); });
    return b;
  };
  tabsEl.appendChild(makeTab('↩ Recent', 'recent'));
  tabsEl.appendChild(makeTab('All', 'all'));
  sections.forEach((sec, i) => tabsEl.appendChild(makeTab(sec.name || ('Section ' + (i + 1)), i)));
}
function makeBankTile(btn, sections) {
  const b = document.createElement('button');
  b.className = 'bbtn';
  const ico = document.createElement('span');
  ico.className = 'bbtn-ico';
  ico.textContent = bankIconFor(btn);
  b.appendChild(ico);
  const lab = btn.label || '';
  if (!isGlyphOnly(lab)) {
    const l = document.createElement('span');
    l.className = 'bbtn-lbl';
    l.textContent = lab;
    b.appendChild(l);
  }
  // ✎ edits this bank button's search keywords (saved on the button itself)
  const pen = document.createElement('span');
  pen.className = 'tile-pen'; pen.textContent = '✎';
  pen.title = 'Edit search keywords for this button';
  pen.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  pen.addEventListener('click', (ev) => {
    ev.stopPropagation(); ev.preventDefault();
    editBankKw(btn, sections);
  });
  b.appendChild(pen);
  // R13.43/45: ⭐ favorite toggle (top-LEFT, opposite ✎) — permanent one-tap
  // access beside Recent. Fires nothing itself; just toggles and re-renders.
  // R13.45: hidden unless Favorite mode is armed (see the tile-pin CSS gate).
  const pinEntry = { side: 'bank', label: btn.label, ico: bankIconFor(btn), action: btn.action };
  const pin = document.createElement('span');
  pin.className = 'tile-pin' + (isPinned(pinEntry) ? ' on' : ''); pin.textContent = '⭐';
  pin.title = 'Star / unstar this button';
  pin.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  pin.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); togglePin(pinEntry); });
  b.appendChild(pin);
  b.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    // R13.44: armed modes hijack the tile tap — pin/edit INSTEAD of firing.
    // Long-press/repeat keys (⌫ etc.) never break: modes are explicit, so a
    // hold still repeats when no mode is armed, and an armed tap never fires.
    if (pinMode === 'bank' || pinMode === 'both') { togglePin(pinEntry); return; }
    if (editMode === 'bank' || editMode === 'both') { editBankKw(btn, sections); return; }
    logRecent({ side: 'bank', label: btn.label, ico: bankIconFor(btn), action: btn.action });
    runAction(btn.action);
  });
  return b;
}
// R13.44: bank keyword editor, shared by tile-✎ and armed-edit taps.
function editBankKw(btn, sections) {
  const v = prompt('Search keywords for "' + (btn.label || '') + '" (space-separated):', btn.kw || '');
  if (v !== null) { btn.kw = v.trim(); persistProfile(); renderBankBody(sections); }
}
function recentBankSection() {
  // R13.30: the "↩ Recent" tiles — recently-used bank buttons, most-recent
  // first. Used by the Recent tab AND shown above search results while typing.
  const recents = recentUsed.filter((r) => r.side === 'bank');
  if (!recents.length) return null;
  const rs = document.createElement('section');
  rs.className = 'bsec';
  const h = document.createElement('h4'); h.textContent = '↩ Recent'; rs.appendChild(h);
  const g = document.createElement('div'); g.className = 'bgrid';
  for (const r of recents) {
    const rt = document.createElement('button'); rt.className = 'bbtn';
    const ri = document.createElement('span'); ri.className = 'bbtn-ico'; ri.textContent = r.ico || '🔘'; rt.appendChild(ri);
    if (!isGlyphOnly(r.label || '')) { const rl = document.createElement('span'); rl.className = 'bbtn-lbl'; rl.textContent = r.label; rt.appendChild(rl); }
    rt.addEventListener('pointerdown', (ev) => { ev.preventDefault(); logRecent(r); runAction(r.action); });
    g.appendChild(rt);
  }
  rs.appendChild(g);
  return rs;
}
// R13.43/45: "⭐ Favorites" bank group — permanent one-tap tools above Recent.
// Same tile shape/fire path as Recent; unstar via ⭐ (armed Favorite mode).
function pinnedBankSection() {
  const pins = pinnedTools.filter((p) => p.side === 'bank');
  if (!pins.length) return null;
  const rs = document.createElement('section');
  rs.className = 'bsec';
  const h = document.createElement('h4'); h.textContent = '⭐ Favorites'; rs.appendChild(h);
  const g = document.createElement('div'); g.className = 'bgrid';
  for (const r of pins) {
    const rt = document.createElement('button'); rt.className = 'bbtn';
    const ri = document.createElement('span'); ri.className = 'bbtn-ico'; ri.textContent = r.ico || '🔘'; rt.appendChild(ri);
    if (!isGlyphOnly(r.label || '')) { const rl = document.createElement('span'); rl.className = 'bbtn-lbl'; rl.textContent = r.label; rt.appendChild(rl); }
    rt.addEventListener('pointerdown', (ev) => { ev.preventDefault(); logRecent(r); runAction(r.action); });
    g.appendChild(rt);
  }
  rs.appendChild(g);
  return rs;
}
function renderBankBody(sections) {
  const body = $('bank-body');
  if (!body) return;
  body.innerHTML = '';
  const q = (searchQuery || '').trim().toLowerCase();
  // R13.30: the dedicated 'recent' tab shows only the recently-used buttons.
  // R13.43: Pinned group renders ABOVE Recent (persists even with no recents).
  if (!q && state.bankTab === 'recent') {
    const ps = pinnedBankSection();
    if (ps) body.appendChild(ps);
    const rs = recentBankSection();
    if (rs) body.appendChild(rs);
    if (!ps && !rs) body.innerHTML = '<p class="empty">Nothing used yet — tap some bank buttons and they\'ll show up here. Star tools with ⭐ to keep them here.</p>';
    return;
  }
  if (!sections.length) {
    body.innerHTML = '<p class="empty">No custom buttons yet — add them in <b>⚙ Customize → Button bank</b>.</p>';
    return;
  }
  if (state.bankTab !== 'all' && state.bankTab !== 'recent' && !sections[state.bankTab]) {
    state.bankTab = 'all';        // the tab's section was deleted
  }
  const list = q ? sections : (state.bankTab === 'all' ? sections : [sections[state.bankTab]]);
  let shown = 0;
  if (q) {
    // while searching, recently-used bank buttons sit on top for one-tap reuse
    const rs = recentBankSection();
    if (rs) { body.appendChild(rs); shown += recentUsed.filter((r) => r.side === 'bank').length; }
  }
  for (const sec of list) {
    const btns = (sec.buttons || []).filter((b) => b && (!q || matchesKw(b, q, sec)));
    if (!btns.length) continue;
    shown += btns.length;
    const s = document.createElement('section');
    s.className = 'bsec';
    if (sec.name) {
      const h = document.createElement('h4');
      h.textContent = sec.name;
      s.appendChild(h);
    }
    const g = document.createElement('div');
    g.className = 'bgrid';
    for (const btn of btns) g.appendChild(makeBankTile(btn, sections));
    s.appendChild(g);
    body.appendChild(s);
  }
  if (!shown) body.innerHTML = '<p class="empty">No buttons match.</p>';
}
function renderBank(sections) { renderBankTabs(sections); renderBankBody(sections); renderFavStrips(); }

/* --------------------------------------------------------- rail rows ------ */
const LABEL_MAP = { SPACE: 'SPC', DRAG: 'DG' };  // short labels; legacy saved profiles still show the new names

function renderMajorRow() {
  // R13.6: the rows are now orientation-INDEPENDENT — the major row is exactly
  // what the profile says (ESC · TAB · WIN · ALT · L), rendered the same in
  // portrait and landscape. Single-key slots (ESC/TAB/WIN/ALT…) get native
  // data-key handling so modifiers toggle like the old mod row did; click/other
  // actions (L = left-click) run on tap.
  const host = $('majorrow');
  host.innerHTML = '';
  (state.profile.majorRow || []).forEach((slot) => {
    const b = document.createElement('button');
    b.className = 'key mbtn';
    b.textContent = LABEL_MAP[slot.label] || slot.label || '•';
    b.title = actionTitle(slot.action);
    const k = singleKeyOf(slot.action);
    if (k) {
      b.dataset.key = k;                 // native key + mod-toggle handling
    } else {
      b.addEventListener('click', (e) => { e.preventDefault(); runAction(slot.action); });
    }
    host.appendChild(b);
  });
}

function renderPadButtons() {
  const host = $('padbtns');
  host.innerHTML = '';
  (state.profile.padButtons || []).forEach((slot) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = LABEL_MAP[slot.label] || slot.label || '•';
    b.title = actionTitle(slot.action);
    if (state.drag && slot.action && slot.action.drag) b.classList.add('on');
    b.addEventListener('click', (e) => { e.preventDefault(); runAction(slot.action); });
    if (slot.action && slot.action.drag) state.dragBtn = b;
    host.appendChild(b);
  });
}

function renderArrows() {
  // R13: the whole arrow cluster renders from profile.arrows — every key is a
  // remappable slot. Single-key actions keep native data-key handling (repeat
  // for ⌫ DEL ↑↓←→ SPC, mod-toggle); everything else is a click → runAction.
  const host = $('arrowrow');
  host.innerHTML = '';
  state.dragBtn = null;
  const list = state.profile.arrows || defaultArrows();
  const row1 = document.createElement('div'); row1.className = 'arrow-line';
  const row2 = document.createElement('div'); row2.className = 'arrow-line';
  list.forEach((slot, i) => {
    const b = document.createElement('button');
    b.className = 'key';
    b.textContent = slot.label || '•';
    b.title = actionTitle(slot.action);
    const k = singleKeyOf(slot.action);
    if (k) {
      b.dataset.key = k;                       // native key + repeat handling
    } else if (slot.action && slot.action.drag) {
      b.dataset.role = 'dg';                   // the drag toggle — track it
      b.addEventListener('click', (e) => { e.preventDefault(); toggleDrag(); });
    } else {
      b.addEventListener('click', (e) => { e.preventDefault(); runAction(slot.action); });
    }
    (i < 5 ? row1 : row2).appendChild(b);
  });
  host.appendChild(row1);
  host.appendChild(row2);
  // R13.8: DG lives in the modrow now (left of M); keep a custom drag slot in the
  // arrows working too, but default the highlight to the modrow DG button.
  state.dragBtn = host.querySelector('[data-role="dg"]') || document.getElementById('btn-dg') || null;
}

function renderHolds() {
  // R13.6: the six-button hold column (L · M · R · SPC · ⏎ · ⌫) flanks the
  // trackpad — LEFT edge in landscape, RIGHT edge in portrait — and renders
  // from profile.holds. Each button is half the old single height; auto→
  // autoscroll, hold→hold, anything else→runAction (SPC/⏎/⌫ send keypresses).
  const host = $('hold-col');
  host.innerHTML = '';
  (state.profile.holds || defaultHolds()).forEach((slot) => {
    const b = document.createElement('button');
    b.className = 'hold';
    b.id = slot.id || ('hold-' + (host.children.length + 1));
    b.dataset.hold = slot.id || b.id;
    b.textContent = slot.label || '•';
    b.title = actionTitle(slot.action);
    if (slot.action && slot.action.auto) {
      // R13.10: M = single-tap autoscroll, DOUBLE-tap pan mode (green). While pan
      // is active any tap releases it — so the release tap's partner can't sneak
      // back in within the double window and instantly re-engage pan.
      b.addEventListener('click', (e) => {
        e.preventDefault();
        const now = performance.now();
        if (now < mPanBlock) return;
        if (state.panMode.on) {
          mPanBlock = now + PAN_DBL_MS + 60;   // swallow the release-tap's partner
          mTapTime = 0;
          togglePanMode();
          return;
        }
        if (now - mTapTime < PAN_DBL_MS) { mTapTime = 0; togglePanMode(); }
        else { mTapTime = now; toggleAutoScroll(); }
      });
    } else if (slot.action && slot.action.hold) {
      b.addEventListener('click', (e) => { e.preventDefault(); toggleHold(slot.action.hold, b); });
    } else {
      b.addEventListener('click', (e) => { e.preventDefault(); runAction(slot.action); });
    }
    host.appendChild(b);
  });
}

/* ----------------------------------------- editing hotkeys (R13.26, bkp2) -- */
// The right-rail hotkey strip (fills the empty area above the right-side panels
// in portrait): SMALL switchable category tabs — the tab row scrolls horizontally,
// so unlimited categories can be added — plus the active tab's keys as small
// square tiles. Every tile shows its icon, a short label AND the exact hotkey
// combo it fires (so the user can mirror the same shortcut in their PC app).
// Entries reuse the same {keys:[...]} combo the rest of the app sends.
const HOTKEY_SECTIONS = [
  { name: 'Play', buttons: [
    { ico: '⏯', label: 'Play/Pause', keys: ['space'], keyText: 'Space', kw: 'play pause playpause space toggle start stop' },
    { ico: '⏮', label: 'Go start', keys: ['home'], keyText: 'Home', kw: 'go start initial frame beginning home timeline start first' },
    { ico: '◀', label: 'Prev frame', keys: ['left'], keyText: '←', kw: 'previous frame earlier back left prev' },
    { ico: '▶', label: 'Next frame', keys: ['right'], keyText: '→', kw: 'next frame forward right advance' },
    { ico: '⏭', label: 'Go end', keys: ['end'], keyText: 'End', kw: 'go end final frame last timeline end finish' },
    { ico: '◀◀', label: 'Shuttle back', keys: ['j'], keyText: 'J', kw: 'shuttle back rewind reverse j slow play backwards' },
    { ico: '■', label: 'Stop', keys: ['k'], keyText: 'K', kw: 'stop halt k pause transport' },
    { ico: '▶▶', label: 'Shuttle fwd', keys: ['l'], keyText: 'L', kw: 'shuttle forward fast forward l speed play' },
  ]},
  { name: 'Edit', buttons: [
    { ico: '↩', label: 'Undo', keys: ['ctrl', 'z'], keyText: 'Ctrl+Z', kw: 'undo revert back undo ctrl z' },
    { ico: '↪', label: 'Redo', keys: ['ctrl', 'shift', 'z'], keyText: 'Ctrl+Sh+Z', kw: 'redo forward repeat ctrl shift z' },
    { ico: '✂', label: 'Cut', keys: ['ctrl', 'x'], keyText: 'Ctrl+X', kw: 'cut remove clip ctrl x' },
    { ico: '📑', label: 'Copy', keys: ['ctrl', 'c'], keyText: 'Ctrl+C', kw: 'copy clone ctrl c duplicate' },
    { ico: '📋', label: 'Paste', keys: ['ctrl', 'v'], keyText: 'Ctrl+V', kw: 'paste insert ctrl v' },
    { ico: '🗑', label: 'Delete', keys: ['delete'], keyText: 'Del', kw: 'delete remove del clear' },
    { ico: '✅', label: 'Select all', keys: ['ctrl', 'a'], keyText: 'Ctrl+A', kw: 'select all everything ctrl a' },
    { ico: '📄', label: 'Duplicate', keys: ['ctrl', 'd'], keyText: 'Ctrl+D', kw: 'duplicate dup copy clone ctrl d' },
  ]},
  { name: 'Clip', buttons: [
    { ico: '📥', label: 'Import', keys: ['ctrl', 'i'], keyText: 'Ctrl+I', kw: 'import media add files bring in ctrl i' },
    { ico: '💾', label: 'Save', keys: ['ctrl', 's'], keyText: 'Ctrl+S', kw: 'save project store ctrl s' },
    { ico: '🔍', label: 'Find', keys: ['ctrl', 'f'], keyText: 'Ctrl+F', kw: 'find search locate ctrl f' },
    { ico: '🛠', label: 'Tool search', keys: ['ctrl', 'space'], keyText: 'Ctrl+Space', kw: 'tool search palette switcher ctrl space' },
    { ico: '🔗', label: 'Match frame', keys: ['f'], keyText: 'F', kw: 'match frame still f sync' },
    { ico: '📌', label: 'Add marker', keys: ['m'], keyText: 'M', kw: 'marker add marker note m flag bookmark' },
    { ico: '↤', label: 'In point', keys: ['i'], keyText: 'I', kw: 'in point mark in start i' },
    { ico: '↦', label: 'Out point', keys: ['o'], keyText: 'O', kw: 'out point mark out end o' },
  ]},
  { name: 'Pages', buttons: [
    { ico: '🗂', label: 'Project Manager', keys: ['shift', '1'], keyText: 'Sh+1', kw: 'project manager open projects dashboard start screen shift 1' },
    { ico: '🎞', label: 'Media', keys: ['shift', '2'], keyText: 'Sh+2', kw: 'media page media pool import footage browser clips files shift 2' },
    { ico: '✂️', label: 'Cut', keys: ['shift', '3'], keyText: 'Sh+3', kw: 'cut page quick edit fast cut speed shift 3' },
    { ico: '🛠', label: 'Edit', keys: ['shift', '4'], keyText: 'Sh+4', kw: 'edit page timeline editor editing workspace shift 4' },
    { ico: '🌀', label: 'Fusion', keys: ['shift', '5'], keyText: 'Sh+5', kw: 'fusion page node vfx effects compositing visual shift 5' },
    { ico: '🎨', label: 'Color', keys: ['shift', '6'], keyText: 'Sh+6', kw: 'color page grade grading photo color wheels cg shift 6' },
    { ico: '🎵', label: 'Fairlight', keys: ['shift', '7'], keyText: 'Sh+7', kw: 'fairlight page audio sound mixer music shift 7' },
    { ico: '📤', label: 'Deliver', keys: ['shift', '8'], keyText: 'Sh+8', kw: 'deliver page export render output share upload shift 8' },
    { ico: '⚙️', label: 'Project settings', keys: ['shift', '9'], keyText: 'Sh+9', kw: 'project settings timeline resolution composition size square vertical format frame rate shift 9' },
  ]},
  { name: 'Trim', buttons: [
    { ico: '⏴', label: 'Trim left', keys: ['shift', '['], keyText: 'Sh+[', kw: 'trim left trim start head beginning shorten cut edge handle' },
    { ico: '⏵', label: 'Trim right', keys: ['shift', ']'], keyText: 'Sh+]', kw: 'trim right trim end tail ending shorten cut edge handle' },
    { ico: '✂', label: 'Split', keys: ['ctrl', 'b'], keyText: 'Ctrl+B', kw: 'split cut at playhead blade slice divide split clip' },
    { ico: '⛓', label: 'Ripple delete', keys: ['shift', 'backspace'], keyText: 'Sh+⌫', kw: 'ripple delete close gap remove shift backspace' },
    { ico: '👁', label: 'Hide / Show', keys: ['d'], keyText: 'D', kw: 'hide show eye visibility toggle clip enable disable display' },
    { ico: '🔖', label: 'Bookmark', keys: ['m'], keyText: 'M', kw: 'bookmark marker add marker flag note mark spot' },
  ]},
];
let hkTab = 0;
// ONE shared search query — the left bank and the right hotkey strip are SYNCED:
// typing in either search box filters BOTH sides live (and both boxes show the
// same text). An empty query = normal per-tab display on each side.
let searchQuery = '';
// per-button keyword OVERRIDES (right hotkeys are a const — the ✎ edits land here)
const hkKw = (() => { try { return JSON.parse(localStorage.getItem('rc_hk_kw') || '{}'); } catch (e) { return {}; } })();
// recently used tools (BOTH sides) — shown at the top of search results for
// one-tap reuse. Persisted so recents survive reloads.
let recentUsed = (() => { try { return JSON.parse(localStorage.getItem('rc_recent') || '[]'); } catch (e) { return []; } })();
function saveRecent() { try { localStorage.setItem('rc_recent', JSON.stringify(recentUsed.slice(0, 12))); } catch (e) {} }
// R13.43: PINNED tools (BOTH sides) — permanent one-tap access beside Recent.
// Same entry shape as recentUsed ({side,label,ico,...}) so tiles render through
// the same paths. Persisted separately (rc_pinned) so profile save/load and
// Recent rotation can never wipe pins.
let pinnedTools = (() => { try { return JSON.parse(localStorage.getItem('rc_pinned') || '[]'); } catch (e) { return []; } })();
function savePinned() { try { localStorage.setItem('rc_pinned', JSON.stringify(pinnedTools)); } catch (e) {} }
// R13.44/45: ARMED customize modes — tiles stay clean (no per-tile ⭐/✎) unless
// a mode is armed from the search-row toggles. Armed + tap tile = pin/unpin or
// edit-keywords INSTEAD of firing (long-press/repeat keys like ⌫ never break).
// 'off' | 'bank' | 'hk' | 'both'; persisted so a refresh keeps the mode.
let pinMode = (() => { try { return localStorage.getItem('rc_pinmode') || 'off'; } catch (e) { return 'off'; } })();
let editMode = (() => { try { return localStorage.getItem('rc_editmode') || 'off'; } catch (e) { return 'off'; } })();
function applyModes() {
  document.body.dataset.pinmode = (pinMode === 'off' ? '' : pinMode);
  document.body.dataset.editmode = (editMode === 'off' ? '' : editMode);
  for (const [id, on] of [['bank-pinmode', pinMode === 'bank' || pinMode === 'both'],
      ['hk-pinmode', pinMode === 'hk' || pinMode === 'both'],
      ['bank-editmode', editMode === 'bank' || editMode === 'both'],
      ['hk-editmode', editMode === 'hk' || editMode === 'both']]) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('on', !!on);
  }
}
function setPinMode(v) { pinMode = v; try { localStorage.setItem('rc_pinmode', v); } catch (e) {} if (v !== 'off') setEditMode('off'); applyModes(); }
function setEditMode(v) { editMode = v; try { localStorage.setItem('rc_editmode', v); } catch (e) {} if (v !== 'off') setPinMode('off'); applyModes(); }
// tapping the search-row toggle cycles off → this side → both → off
function cycleMode(which, side) {
  const cur = which === 'pin' ? pinMode : editMode;
  const set = which === 'pin' ? setPinMode : setEditMode;
  set(cur === 'off' ? side : (cur === side ? 'both' : 'off'));
}
function pinKey(r) { return (r.side || '') + '|' + (r.label || ''); }
function isPinned(r) { const k = pinKey(r); return pinnedTools.some((p) => pinKey(p) === k); }
function togglePin(r) {
  const k = pinKey(r);
  const i = pinnedTools.findIndex((p) => pinKey(p) === k);
  if (i >= 0) pinnedTools.splice(i, 1);
  else pinnedTools.unshift(JSON.parse(JSON.stringify(r)));
  savePinned();
  renderBankBody(state.profile.bank || []);
  renderHotkeyBody();
  renderFavStrips();
  if (searchQuery && searchQuery.trim()) renderSearchOverlay();
}
// R13.46: ⭐ favorites strips — one-tap chips directly below each search bar
// (above the tabs). Same fire paths as tiles; hidden when empty (.has gate).
// Re-rendered on every pin toggle + every bank/hotkey render.
function favChip(r) {
  const c = document.createElement('button');
  c.className = 'favchip';
  c.title = r.label || 'Favorite';
  const ic = document.createElement('span'); ic.className = 'fic'; ic.textContent = r.ico || '⭐'; c.appendChild(ic);
  const lb = document.createElement('span'); lb.className = 'flb'; lb.textContent = r.label || ''; c.appendChild(lb);
  const keyText = r.keyText || ((r.keys || []).join('+'));
  if (keyText) { const k = document.createElement('span'); k.className = 'fkey'; k.textContent = keyText; c.appendChild(k); }
  c.addEventListener('pointerdown', (ev) => { ev.preventDefault(); });
  c.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (r.side === 'hk') { logRecent(r); runAction({ keys: r.keys }); }
    else { logRecent(r); runAction(r.action); }
  });
  return c;
}
function renderFavStrips() {
  const bb = $('bank-favs'), hb = $('hk-favs');
  const pinsB = pinnedTools.filter((p) => p.side === 'bank');
  const pinsH = pinnedTools.filter((p) => p.side === 'hk');
  if (bb) {
    bb.innerHTML = '';
    bb.classList.toggle('has', pinsB.length > 0);
    for (const r of pinsB) bb.appendChild(favChip(r));
  }
  if (hb) {
    hb.innerHTML = '';
    hb.classList.toggle('has', pinsH.length > 0);
    for (const r of pinsH) hb.appendChild(favChip(r));
  }
}
function logRecent(r) {
  recentUsed = recentUsed.filter((x) => !(x.side === r.side && x.label === r.label));
  recentUsed.unshift(r);
  if (recentUsed.length > 12) recentUsed.length = 12;
  saveRecent();
}
// does a button match a query? matches label, title, key combo, section name and
// keywords (built-in + any user override). SUBSTRING match — typing "us" shows
// "Play/Pause", "lush", anything containing the text. q is lowercased; every word must hit.
function matchesKw(b, q, sec, kwExtra) {
  if (!b) return false;  // a stored profile may carry a null button — skip it
  const keys = b.keys || (b.action && b.action.keys) || [];
  const hay = [b.label, b.title, b.keyText, b.ico, b.kw, kwExtra, sec && sec.name, keys.join(' ')]
    .filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
// set the SHARED search query — syncs both search boxes and re-renders both sides.
function setSearch(q, source) {
  searchQuery = q;
  const li = $('bank-search'), ri = $('hk-search');
  if (li && li.value !== q) li.value = q;
  if (ri && ri.value !== q) ri.value = q;
  // R13.43: a live query renders into the floating overlay (tappable even with
  // the bank shrunk); the inline panels stay untouched behind it. Empty query
  // hides the overlay and restores the inline view.
  if (q && q.trim()) {
    renderSearchOverlay(source);
  } else {
    hideSearchOverlay();
    renderBankBody(state.profile.bank || []);
    renderHotkeyBody();
  }
}
function clearSearch() {
  searchQuery = '';
  const li = $('bank-search'), ri = $('hk-search');
  if (li) li.value = '';
  if (ri) ri.value = '';
  hideSearchOverlay();
  renderBankBody(state.profile.bank || []);
  renderHotkeyBody();
}
/* ------------------------- R13.43 search overlay -------------------------- */
/* One shared floating results panel for BOTH search boxes. Collects matches
 * through the EXISTING matchesKw engine (bank sections + HOTKEY_SECTIONS +
 * hkKw overrides), groups by side (Pinned → Recent → matches), anchors to the
 * searching side so the trackpad is never covered. Row taps fire the EXISTING
 * action paths (bank: runAction(action); hk: runAction({keys})) and logRecent
 * with the EXACT shapes the Recent tabs expect. */
function collectSearchMatches(q2) {
  const bank = [];
  for (const sec of (state.profile.bank || [])) {
    for (const b of (sec.buttons || [])) {
      if (b && matchesKw(b, q2, sec)) bank.push({ b, sec });
      if (bank.length >= 30) break;
    }
    if (bank.length >= 30) break;
  }
  const hk = [];
  for (const sec of HOTKEY_SECTIONS) {
    for (const b of (sec.buttons || [])) {
      if (b && matchesKw(b, q2, sec, hkKw[sec.name + '/' + b.label])) hk.push({ b, sec });
      if (hk.length >= 30) break;
    }
    if (hk.length >= 30) break;
  }
  return { bank, hk };
}
function soRow(ico, label, keyText, side, pinEntry, fireFn) {
  const row = document.createElement('button');
  row.className = 'so-row';
  const ic = document.createElement('span'); ic.className = 'so-ico'; ic.textContent = ico || '🔘'; row.appendChild(ic);
  const lb = document.createElement('span'); lb.className = 'so-lbl'; lb.textContent = label; row.appendChild(lb);
  if (keyText) { const k = document.createElement('span'); k.className = 'so-key'; k.textContent = keyText; row.appendChild(k); }
  const sd = document.createElement('span'); sd.className = 'so-side'; sd.textContent = side; row.appendChild(sd);
  // R13.45: overlay-row ⭐ shows ONLY while Favorite mode is armed for this
  // side — otherwise the row is just icon+label+key (clean list). Unstarred
  // rows of starred items still show the star state via the Favorites group.
  const favArmed = (side === 'Bank') ? (pinMode === 'bank' || pinMode === 'both') : (pinMode === 'hk' || pinMode === 'both');
  const pin = document.createElement('span');
  pin.className = 'so-pin' + (isPinned(pinEntry) ? ' on' : '');
  pin.style.display = favArmed ? '' : 'none';
  pin.textContent = '⭐'; pin.title = 'Star / unstar';
  pin.addEventListener('pointerdown', (e) => e.stopPropagation());
  pin.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); togglePin(pinEntry); });
  row.appendChild(pin);
  // pointerdown stopped (not prevented) so the tap fires AND the Android
  // keyboard stays up for query refinement
  row.addEventListener('pointerdown', (e) => e.stopPropagation());
  row.addEventListener('click', (e) => { e.preventDefault(); fireFn(); });
  return row;
}
function renderSearchOverlay(source) {
  const panel = $('search-overlay'), list = $('so-list'), scrim = $('search-scrim');
  if (!panel || !list) return;
  const q2 = (searchQuery || '').trim().toLowerCase();
  if (!q2) { hideSearchOverlay(); return; }
  const { bank, hk } = collectSearchMatches(q2);
  list.innerHTML = '';
  let total = 0;
  const addGroup = (title, entries, entryOf) => {
    if (!entries.length) return;
    const g = document.createElement('div'); g.className = 'so-group';
    const h = document.createElement('h4'); h.textContent = title + ' (' + entries.length + ')'; g.appendChild(h);
    for (const en of entries) g.appendChild(entryOf(en));
    list.appendChild(g);
    total += entries.length;
  };
  const bankRow = ({ b }) => soRow(bankIconFor(b), b.label, null, 'Bank',
    { side: 'bank', label: b.label, ico: bankIconFor(b), action: b.action },
    () => { const r = { side: 'bank', label: b.label, ico: bankIconFor(b), action: b.action }; logRecent(r); runAction(b.action); renderSearchOverlay(source); });
  const hkRow = ({ b, sec }) => soRow(b.ico, b.label, b.keyText || (b.keys || []).join('+'), 'Hotkey',
    { side: 'hk', label: b.label, ico: b.ico || '🔘', keys: b.keys, keyText: b.keyText, secName: sec.name },
    () => { const r = { side: 'hk', label: b.label, ico: b.ico || '🔘', keys: b.keys, keyText: b.keyText, secName: sec.name }; logRecent(r); runAction({ keys: b.keys }); renderSearchOverlay(source); });
  const recentRow = (r) => (r.side === 'hk'
    ? soRow(r.ico, r.label, r.keyText || (r.keys || []).join('+'), 'Hotkey', r,
      () => { logRecent(r); runAction({ keys: r.keys }); renderSearchOverlay(source); })
    : soRow(r.ico, r.label, null, 'Bank', r,
      () => { logRecent(r); runAction(r.action); renderSearchOverlay(source); }));
  // order per side: Pinned → Recent → matches
  const pinsB = pinnedTools.filter((p) => p.side === 'bank');
  const pinsH = pinnedTools.filter((p) => p.side === 'hk');
  const recB = recentUsed.filter((r) => r.side === 'bank');
  const recH = recentUsed.filter((r) => r.side === 'hk');
  if (pinsB.length) addGroup('⭐ Favorites · Bank', pinsB, (r) => recentRow(r));
  if (pinsH.length) addGroup('⭐ Favorites · Hotkeys', pinsH, (r) => recentRow(r));
  if (recB.length) addGroup('↩ Recent · Bank', recB, (r) => recentRow(r));
  if (recH.length) addGroup('↩ Recent · Hotkeys', recH, (r) => recentRow(r));
  addGroup('Custom buttons', bank, bankRow);
  addGroup('Hotkeys', hk, hkRow);
  $('so-count').innerHTML = total ? ('<b>' + total + '</b> result' + (total === 1 ? '' : 's')) : '';
  if (!total) { const e = document.createElement('div'); e.className = 'so-empty'; e.textContent = 'No matches.'; list.appendChild(e); }
  // R13.43b: anchor BELOW the typed-in search box (YouTube-style) — the box
  // itself + its tab row stay visible so you always see what you typed; only
  // the area under the box is covered. Falls back to the side-box top when the
  // box rect is missing. Bottom still clamps above pad-area/typebar.
  try {
    const boxEl = (source && source.getBoundingClientRect) ? source
      : $(source && source.id === 'hk-search' ? 'hk-search' : 'bank-search');
    const boxR = boxEl ? boxEl.getBoundingClientRect() : null;
    const srcBox = (source && source.id === 'hk-search') ? $('rail-btns') : $('bank');
    const anchor = (srcBox && srcBox.getBoundingClientRect().width) ? srcBox : $('bank');
    const r = anchor.getBoundingClientRect();
    const top = (boxR && boxR.width) ? boxR.bottom + 6 : r.top + 4;
    const padTop = ($('pad-area') || document.body).getBoundingClientRect().top;
    const typeTop = ($('typebar') || document.body).getBoundingClientRect().top;
    const bottom = Math.min(padTop > top ? padTop : Infinity, typeTop > top ? typeTop : Infinity);
    panel.style.left = Math.max(8, Math.round(r.left)) + 'px';
    panel.style.top = Math.round(top) + 'px';
    panel.style.width = Math.round(r.width) + 'px';
    panel.style.maxHeight = Math.max(160, Math.round((isFinite(bottom) ? bottom : innerHeight) - top - 8)) + 'px';
  } catch (e) { /* default CSS caps apply */ }
  panel.classList.add('open');
  if (scrim) scrim.classList.add('open');
}
function hideSearchOverlay() {
  const panel = $('search-overlay'), scrim = $('search-scrim');
  if (panel) panel.classList.remove('open');
  if (scrim) scrim.classList.remove('open');
}
// R13.30: sentinel for the '↩ Recent' hotkey tab (real section indices are >= 0)
const HK_RECENT = -1;
function renderHotkeyTabs() {
  const tabs = $('hk-tabs');
  if (!tabs) return;
  tabs.innerHTML = '';
  const rec = document.createElement('button');
  rec.className = 'hk-tab' + (hkTab === HK_RECENT ? ' on' : '');
  rec.textContent = '↩ Recent';
  rec.title = 'Recently-used hotkeys';
  rec.addEventListener('click', () => { hkTab = HK_RECENT; renderHotkeyTabs(); clearSearch(); });
  tabs.appendChild(rec);
  HOTKEY_SECTIONS.forEach((s, i) => {
    const t = document.createElement('button');
    t.className = 'hk-tab' + (i === hkTab ? ' on' : '');
    t.textContent = s.name;
    t.title = (s.buttons ? s.buttons.length : 0) + ' keys';
    t.addEventListener('click', () => { hkTab = i; renderHotkeyTabs(); clearSearch(); });
    tabs.appendChild(t);
  });
}
function makeHotkeyTile(b, sec) {
  const el = document.createElement('button');
  el.className = 'hk';
  el.title = b.label + ' — ' + (b.keyText || b.keys.join(' + '));
  const ico = document.createElement('span'); ico.className = 'hk-ico'; ico.textContent = b.ico || '🔘';
  const lbl = document.createElement('span'); lbl.className = 'hk-lbl'; lbl.textContent = b.label;
  const key = document.createElement('span'); key.className = 'hk-key'; key.textContent = b.keyText || b.keys.join('+');
  el.appendChild(ico); el.appendChild(lbl); el.appendChild(key);
  // ✎ edits this hotkey's search keywords (stored as an override in localStorage)
  const pen = document.createElement('span');
  pen.className = 'tile-pen'; pen.textContent = '✎';
  pen.title = 'Edit search keywords for this button';
  pen.addEventListener('pointerdown', (e) => e.stopPropagation());
  pen.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    editHkKw(b, sec);
  });
  el.appendChild(pen);
  // R13.43/45: ⭐ favorite toggle (top-LEFT, opposite ✎) — same as bank tiles.
  const pinEntry = { side: 'hk', label: b.label, ico: b.ico || '🔘', keys: b.keys, keyText: b.keyText, secName: sec.name };
  const pin = document.createElement('span');
  pin.className = 'tile-pin' + (isPinned(pinEntry) ? ' on' : ''); pin.textContent = '⭐';
  pin.title = 'Star / unstar this hotkey';
  pin.addEventListener('pointerdown', (e) => e.stopPropagation());
  pin.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); togglePin(pinEntry); });
  el.appendChild(pin);
  el.addEventListener('click', (e) => {
    e.preventDefault();
    // R13.44: armed modes hijack the tile tap — same deal as bank tiles.
    if (pinMode === 'hk' || pinMode === 'both') { togglePin(pinEntry); return; }
    if (editMode === 'hk' || editMode === 'both') { editHkKw(b, sec); return; }
    logRecent({ side: 'hk', label: b.label, ico: b.ico || '🔘', keys: b.keys, keyText: b.keyText, secName: sec.name });
    runAction({ keys: b.keys });
  });
  return el;
}
// R13.44: hotkey keyword editor, shared by tile-✎ and armed-edit taps.
function editHkKw(b, sec) {
  const cur = (hkKw[sec.name + '/' + b.label] || b.kw || '');
  const v = prompt('Search keywords for "' + b.label + '" (space-separated):', cur);
  if (v !== null) {
    hkKw[sec.name + '/' + b.label] = v.trim();
    try { localStorage.setItem('rc_hk_kw', JSON.stringify(hkKw)); } catch (err) {}
    renderHotkeyBody();
  }
}
function renderHotkeyBody() {
  const body = $('hk-body');
  if (!body) return;
  body.innerHTML = '';
  body.classList.remove('recent-list');   // R13.30g: recent-tab vertical listing (removed on every other render)
  const q = (searchQuery || '').trim().toLowerCase();
  // R13.30: the dedicated '↩ Recent' tab shows only the recently-used hotkeys.
  // R13.43: Pinned group renders ABOVE Recent (persists even with no recents).
  if (!q && hkTab === HK_RECENT) {
    body.classList.add('recent-list');
    const pins = pinnedTools.filter((p) => p.side === 'hk');
    const recents = recentUsed.filter((r) => r.side === 'hk');
    if (!pins.length && !recents.length) { body.innerHTML = '<p class="empty">Nothing used yet — fire some hotkeys and they\'ll show up here. Star tools with ⭐ to keep them here.</p>'; return; }
    if (pins.length) {
      const ph = document.createElement('div'); ph.className = 'hk-group'; ph.textContent = '⭐ Favorites';
      body.appendChild(ph);
      for (const r of pins) body.appendChild(makeHotkeyTile({ ico: r.ico, label: r.label, keys: r.keys, keyText: r.keyText, kw: '' }, { name: r.secName || 'Pinned' }));
    }
    if (recents.length) {
      const h = document.createElement('div'); h.className = 'hk-group'; h.textContent = '↩ Recent';
      body.appendChild(h);
      for (const r of recents) body.appendChild(makeHotkeyTile({ ico: r.ico, label: r.label, keys: r.keys, keyText: r.keyText, kw: '' }, { name: r.secName || 'Recent' }));
    }
    return;
  }
  const sections = q ? HOTKEY_SECTIONS : [HOTKEY_SECTIONS[hkTab] || HOTKEY_SECTIONS[0]];
  if (!sections.length) return;
  let shown = 0;
  if (q) {
    // while searching, recently-used hotkeys sit on top for one-tap reuse
    const recents = recentUsed.filter((r) => r.side === 'hk');
    if (recents.length) {
      const h = document.createElement('div'); h.className = 'hk-group'; h.textContent = '↩ Recent';
      body.appendChild(h);
      for (const r of recents) body.appendChild(makeHotkeyTile({ ico: r.ico, label: r.label, keys: r.keys, keyText: r.keyText, kw: '' }, { name: r.secName || 'Recent' }));
      shown += recents.length;
    }
  }
  for (const sec of sections) {
    for (const b of (sec.buttons || [])) {
      if (q && !matchesKw(b, q, sec, hkKw[sec.name + '/' + b.label])) continue;
      shown++;
      body.appendChild(makeHotkeyTile(b, sec));
    }
  }
  if (!shown) body.innerHTML = '<p class="empty">No hotkey matches.</p>';
}
function renderHotkeys() { renderHotkeyTabs(); renderHotkeyBody(); renderFavStrips(); }

function renderAll() {
  renderBank(state.profile.bank || []);
  renderMajorRow();
  renderPadButtons();
  renderArrows();
  renderHolds();
  renderHotkeys();
  updateTpHint();
  sizeTrackpad();
}

/* ---------------------------------------------------------- trackpad ----- */
const MOVE_THRESH = 7;   // px before a touch becomes a real move
const TAP_MS = 380;      // max duration of a tap
const LONG_MS = 460;     // hold duration that starts a drag
// R14: pinch-vs-scroll gate. PINCH_GATE_PX = how much the finger SEPARATION
// must change (from the 2nd-finger-landing baseline) before ANY zoom fires —
// below it, a 2-finger drag is pure scroll even if the distance wobbles a
// little (this is the explicit anti-ambiguity gate: separation change = pinch,
// parallel motion = scroll). PINCH_STEP_PX = one zoom step per this many px of
// further separation change — small enough to feel continuous, large enough
// that one slow pinch is a handful of steps, not dozens. The first step fires
// at GATE+STEP (14+40=54px) so the gate is a true dead zone; later steps every
// STEP px. zoomNotches() below = wheel notches per step at the Zoom-slider
// value — so the slider changes how much zoom one pinch step produces. The
// gate math (fingers vs noise) is untouched.
const PINCH_GATE_PX = 14;
const PINCH_STEP_PX = 40;
// R27: 3-finger SWIPE — dominant-axis midpoint travel past this = a swipe,
// under it = a tap. 60 dots ≈ a deliberate flick, well above tap jitter and
// the pinch gate, well below a full-pad slide.
const SWIPE_GATE_PX = 60;
function zoomNotches() {
  // R27: Zoom slider → notches per pinch step. 0% = 1 notch (the old feel,
  // byte-identical to the old ZOOM_STEP=1), 100% = 3 notches (today's "very
  // low" feel tripled — the new default punch), 200% = 5 notches. Odd numbers
  // keep the sign of tiny steps unambiguous on the PC log.
  const z = (typeof state.zoomSens === 'number' && isFinite(state.zoomSens)) ? state.zoomSens : 100;
  return Math.max(1, Math.round(1 + (z / 100) * 2));
}
function swipeActionFor(dx, dy) {
  // R27: Windows-default swipe meanings (Microsoft's own gesture page):
  // up = Task View (Win+Tab), down = show desktop (Win+D), left/right =
  // switch apps (one Alt+Tab step per swipe, like a single flick on a real
  // pad). Returns {keys, name} for the log + the send.
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy < 0 ? { keys: ['win', 'tab'], name: 'Task View (Win+Tab — shows all open windows)' }
                  : { keys: ['win', 'd'], name: 'show desktop (Win+D)' };
  }
  return dx < 0 ? { keys: ['alt', 'tab'], name: 'switch apps (Alt+Tab — next window)' }
                : { keys: ['alt', 'shift', 'tab'], name: 'switch apps backwards (Alt+Shift+Tab — previous window)' };
}

function gestureFor(n) {
  // R13.8: per-key default merge — even if a profile (or a code path) is missing
  // a newer gesture name, the default fills it in. Never returns undefined for
  // 'circle' on an old profile.
  const g = Object.assign({}, DEFAULT_GESTURES, (state.profile && state.profile.gestures) || {});
  // string names (circle / hold) map straight to the named gesture — R13.7: the
  // old fallthrough made gestureFor('circle') return threeTap (a middle click!)
  if (typeof n === 'string') return g[n];
  return n === 1 ? g.oneTap : n === 2 ? g.twoTap : g.threeTap;
}
function holdDragEnabled() {
  const g = Object.assign({}, DEFAULT_GESTURES, (state.profile && state.profile.gestures) || {});
  return g.hold === 'drag';
}

// R13.5: shape recognizer — is a one-finger trace a closed "O" loop? Used by the
// pad to fire the configurable circle gesture (default Import). Only a clearly
// round loop qualifies, so plain drags and scribbles never misfire. Geometry:
//   - enough points, big enough to matter, roughly square bounding box
//   - start ≈ end (it loops back), angular span ≥ ~1.5π (it went all the way round)
//   - radius stays within ±35% of the mean around the centroid in every 30° bin
//     (a square's corners push radius up ~41%, a triangle's ~100% → both rejected)
// R13.8: the trace is SMOOTHED first — a real finger leaves a jittery, dense
// point cloud whose raw perimeter reads ~4+ (way over the 3.75 gate) and fails
// every otherwise-perfect hand-drawn O. A short moving average removes the tremor
// without hurting squares/triangles (their straight edges don't smooth away).
function smoothTrace(pts, half) {
  if (pts.length < 2 * half) return pts.slice();
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    let sx = 0, sy = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      const k = Math.max(0, Math.min(pts.length - 1, j));
      sx += pts[k][0]; sy += pts[k][1]; n++;
    }
    out[i] = [sx / n, sy / n];
  }
  return out;
}
function recognizeCircle(raw) {
  if (!raw || raw.length < 14) return false;
  const pts = smoothTrace(raw, Math.min(5, Math.max(2, Math.ceil(raw.length / 60))));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, cx = 0, cy = 0;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    cx += p[0]; cy += p[1];
  }
  cx /= pts.length; cy /= pts.length;
  const bw = maxX - minX, bh = maxY - minY;
  const diag = Math.hypot(bw, bh);
  const ar = bw / bh;
  let perim = 0;
  for (let i = 1; i < pts.length; i++) perim += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const pr = perim / Math.max(bw, bh);
  const d0 = pts[0], d1 = pts[pts.length - 1];
  const close = Math.hypot(d1[0] - d0[0], d1[1] - d0[1]) / diag;
  // unwrap angles around the centroid → how many full turns; collect radii
  let prev = Math.atan2(pts[0][1] - cy, pts[0][0] - cx), turns = 0;
  const rads = [];
  for (const p of pts) {
    const a = Math.atan2(p[1] - cy, p[0] - cx);
    let d = a - prev; prev = a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    turns += d;
    rads.push(Math.hypot(p[0] - cx, p[1] - cy));
  }
  const turnsPi = Math.abs(turns) / Math.PI;
  // roundness via trimmed radius extremes (5th↔95th percentile — one jittered
  // point can't fool it).
  rads.sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(rads.length * 0.05));
  const rratio = rads[rads.length - 1 - k] / rads[k];

  // MODE A — a clean single loop (the original strict recognizer): rejects
  // squares (pr≈4.0 > 3.75) and triangles (rratio≈2.0 > 1.65).
  const modeA = diag >= 36 && ar >= 0.55 && ar <= 1.8 && pr >= 2.6 && pr <= 3.75 &&
                close <= 0.35 && turnsPi >= 1.5 && turnsPi <= 2.6 && rratio <= 1.65;
  // MODE B — R13.9, tuned from 58 REAL tablet traces (test-gesture.html logging):
  // the user's natural "O" is a loose, jittery, MULTI-TURN inward spiral — open at
  // the end (closure up to 0.85), high perimeter (pr up to 6.5), shrinking/wobbly
  // radius (rratio up to 12). Squares/triangles/lines stay out via the turns floor:
  // they sum to exactly 2π, the user's O's run 2.2π–4.9π.
  const modeB = diag >= 30 && ar >= 0.5 && ar <= 2.0 && pr >= 2.8 && pr <= 6.5 &&
                close <= 0.85 && turnsPi >= 2.2 && rratio <= 12;
  return modeA || modeB;
}
// R13.18: V recognizer — is a one-finger trace a sharp two-arm "V" (finger down
// then up, like the letter V)? Fires the configurable vee gesture (default
// Ctrl+Alt+S — Vibe launch). Checked only when recognizeCircle already said no,
// so O loops never collide with it.
// The trace is FIRST resampled to a fixed ~6px spacing (kills most tremor), then
// simplified with Ramer-Douglas-Peucker. A V has EXACTLY one bend, so it reduces
// to [start, apex, end]; W/M/zigzags/curves keep more points and a line collapses
// to two. (Per-segment heading SUMS are unreliable for this: finger tremor on
// ~1px raw segments inflates the sum to 2π+ even on straight arms.)
// Geometry:
//   - big enough to matter, OPEN ends (start ≠ end) — a loop, triangle or square
//     closes up and is rejected
//   - simplifies to EXACTLY 3 points → a single sharp bend
//   - apex interior angle in [15°, 85°] — a 90° corner (an "L") is too wide,
//     a shallow arc is wider still
//   - both arms ≥ 15% of the diagonal, no lopsided "checkmark" (ratio ≤ 4)
//   - the bend sits in the MIDDLE of the stroke (0.25–0.75), not at an end
function resamplePath(pts, step) {
  if (!pts || pts.length < 2) return [];
  const out = [pts[0].slice()];
  let D = 0, prev = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const seg = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    if (seg === 0) continue;
    if (D + seg >= step) {
      const f = (step - D) / seg;
      out.push([prev[0] + (p[0] - prev[0]) * f, prev[1] + (p[1] - prev[1]) * f]);
      let rest = seg - (step - D);
      while (rest >= step) {
        const last = out[out.length - 1];
        out.push([last[0] + (p[0] - prev[0]) * (step / seg), last[1] + (p[1] - prev[1]) * (step / seg)]);
        rest -= step;
      }
      D = rest;
    } else {
      D += seg;
    }
    prev = p;
  }
  return out;
}
function rdp(points, eps) {
  if (points.length < 3) return points;
  const a = points[0], b = points[points.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  let maxDist = -1, idx = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const px = points[i][0], py = points[i][1];
    let d;
    if (len2 === 0) d = Math.hypot(px - a[0], py - a[1]);
    else {
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
      d = Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
    }
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > eps && idx > 0) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function recognizeV(raw) {
  if (!raw || raw.length < 12) return false;
  const pts = resamplePath(raw, 6);
  if (pts.length < 8) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const bw = maxX - minX, bh = maxY - minY, diag = Math.hypot(bw, bh);
  if (diag < 30) return false;                       // too small to matter
  const d0 = pts[0], d1 = pts[pts.length - 1];
  const close = Math.hypot(d1[0] - d0[0], d1[1] - d0[1]) / diag;
  if (close < 0.25) return false;                    // ends loop back → circle/triangle/square

  // Ramer-Douglas-Peucker: a V has EXACTLY one bend, so it simplifies to
  // [start, apex, end]. W/M/zigzag/curve/scribble keep more points; a line
  // collapses to 2.
  const sim = rdp(pts, Math.max(4, diag * 0.05));
  if (sim.length !== 3) return false;
  const a = sim[0], m = sim[1], b = sim[2];

  // apex interior angle + arm lengths
  const v1x = a[0] - m[0], v1y = a[1] - m[1];
  const v2x = b[0] - m[0], v2y = b[1] - m[1];
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  if (l1 < diag * 0.15 || l2 < diag * 0.15) return false;           // a stub arm → more a line+nick
  if (Math.max(l1, l2) / Math.min(l1, l2) > 4) return false;        // too lopsided (checkmark-like)
  const dot = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (l1 * l2)));
  const ang = Math.acos(dot) * 180 / Math.PI;
  if (ang < 15 || ang > 85) return false;                           // too sharp / an L is 90° → out

  // the bend must sit in the MIDDLE of the stroke, not at an end
  let ai = 0, best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dd = (pts[i][0] - m[0]) ** 2 + (pts[i][1] - m[1]) ** 2;
    if (dd < best) { best = dd; ai = i; }
  }
  const apexPos = ai / (pts.length - 1);
  if (apexPos < 0.25 || apexPos > 0.75) return false;
  return true;
}

// R13.20: log every gesture-mode stroke to the PC's _traces.jsonl — recognized or
// not — so a missed gesture is diagnosable from the PC side (mirrors
// test-gesture.html's logTrace). Fire-and-forget; never throws.
function logGestureTrace(pts, ok) {
  if (window.__logHook) { window.__logHook({ pts, ok }); return; }
  try {
    const pad = $('trackpad');
    fetch('/api/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pts, ok: !!ok, cw: pad ? pad.clientWidth : innerWidth, ch: pad ? pad.clientHeight : innerHeight }),
    }).catch(() => {});
  } catch (e) {}
}

// R13.19+: Notepad recognizer — is a one-finger trace the LETTER N/n (a tall,
// open, ELONGATED multi-bend stroke, drawn as two arches — "draw an n on the pad")?
// Fires the configurable notepad gesture (default: launch notepad.exe). Checked ONLY
// when the trace is NOT a circle and NOT a V, so loops and single bends never
// collide. Retuned R13.20 on the user's REAL n-letters (gesture-lab export 2026-08-27):
//   - big enough to matter, OPEN ends (close/dist >= 0.4 — an n never closes)
//   - ELONGATED (max/min >= 1.2) — horizontal OR vertical (portrait AND landscape)
//   - RDP keeps 4..12 points (eps 0.03·diag — the shallow n-arches/zigzag bends
//     survive; 0.05 like the V flattens them into a straight line)
//   - every bend is REAL: |cross|/(la·lb) >= 0.08 — a tremor nick is skipped
//   - NET-TURN BALANCE: |net|/Σ|turns| < 0.7 — natural handwriting draws the n's
//     DOWNSTROKES vertical and UPSTROKES slanted, so bends lean one way (bal 0.5-0.7)
//     without being a one-way scribble; arcs/same-sign scribbles still rejected
function recognizeNotepad(raw) {
  if (!raw || raw.length < 12) return false;
  const pts = resamplePath(raw, 6);
  if (pts.length < 8) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const bw = maxX - minX, bh = maxY - minY, diag = Math.hypot(bw, bh);
  if (diag < 30) return false;                       // too small to matter
  const d0 = pts[0], d1 = pts[pts.length - 1];
  const close = Math.hypot(d1[0] - d0[0], d1[1] - d0[1]) / diag;
  if (close < 0.4) return false;                     // ends loop back → circle/triangle/square
  if (Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) < 1.2) return false;  // not elongated → O/V/scribble

  // RDP: a zigzag keeps several bends; a line collapses to 2, a V to 3.
  const sim = rdp(pts, Math.max(4, diag * 0.03));
  if (sim.length < 4 || sim.length > 12) return false;

  // net-turn balance: real zigzags alternate left/right, so signed turns cancel
  // (|net| small). An arc/circle/scribble keeps turning one way → |net| big.
  let net = 0, tot = 0;
  for (let i = 1; i < sim.length - 1; i++) {
    const a = sim[i - 1], m = sim[i], b = sim[i + 1];
    const v1x = a[0] - m[0], v1y = a[1] - m[1];
    const v2x = b[0] - m[0], v2y = b[1] - m[1];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1 || l2 < 1) continue;
    const cross = v1x * v2y - v1y * v2x;
    const mag = Math.abs(cross) / (l1 * l2);         // sine of the turn angle
    if (mag < 0.08) continue;                        // nearly straight → tremor nick, not a bend
    net += Math.sign(cross); tot += 1;
  }
  if (tot < 3) return false;                         // need at least ~3 real bends
  if (Math.abs(net) / tot >= 0.7) return false;      // letter-n: natural downstroke/upstroke lean gives bal 0.5-0.7
  return true;
}

/* ---- R28 GESTURE TRAINER — template matcher ------------------------------
 * recognizeTemplate(pts, templates): nearest-match over the user's own saved
 * examples. Reuses the built-in recognizers' helpers (smoothTrace → resamplePath
 * → rdp) and then NORMALISES into a unit box (centre on the bbox middle, divide
 * by the long side), so the same shape matches anywhere on the pad and at any
 * size. After simplification the path is re-resampled to a fixed 32 arc-length
 * points, so candidate and template align point-for-point; distance = mean
 * Euclidean error over those points (computed in BOTH draw directions, so a
 * shape drawn start↔end reversed still matches).
 *
 * THRESHOLD = 0.12 (in unit space, where 1.0 = the shape's long side):
 *   - three recorded samples of the SAME shape typically land 0.03–0.07
 *     (finger tremor + start/end wobble only)
 *   - a genuinely different shape lands ≥ 0.15
 *   - the check runs ONLY after circle / V / notepad all said no, so built-ins
 *     always win and a borderline custom match can never steal them; and with
 *     nearest-match over multiple templates the user gets slack for one sloppy
 *     recording without loosening the gate.
 */
const TR_N = 32;          // fixed point count after normalisation
const TR_THRESH = 0.12;   // max mean unit-space distance for a match
const TR_KEEP = 16;       // max stored templates per gesture (see condenseSamples)
const TR_MERGE = 0.07;    // samples this close together get averaged into one

function normalizeGesture(raw) {
  if (!raw || raw.length < 8) return null;
  const sm = smoothTrace(raw, Math.min(4, Math.max(2, Math.ceil(raw.length / 50))));
  const rs = resamplePath(sm, 6);
  if (rs.length < 6) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of rs) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  const bw = maxX - minX, bh = maxY - minY;
  const s = Math.max(bw, bh);
  if (s < 24) return null;                          // a tap-sized wiggle isn't a shape
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const unit = rs.map((p) => [(p[0] - cx) / s, (p[1] - cy) / s]);
  // RDP drops tremor corners without eating real bends, then ONE even
  // arc-length resample makes point i of any drawing = point i of a template.
  const sim = rdp(unit, 0.02);
  if (sim.length < 4) return null;
  let per = 0;
  for (let i = 1; i < sim.length; i++) per += Math.hypot(sim[i][0] - sim[i - 1][0], sim[i][1] - sim[i - 1][1]);
  if (per < 0.5) return null;
  const fixed = resamplePath(sim, per / (TR_N - 1));
  if (fixed.length < TR_N - 4) return null;
  while (fixed.length < TR_N) fixed.push(fixed[fixed.length - 1].slice());
  return fixed.slice(0, TR_N);
}

function gestureDist(a, b) {
  let d = 0;
  for (let i = 0; i < TR_N; i++) d += Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
  return d / TR_N;
}

/* VOLUME (R28.1): a user may record 20/50/100 samples of the same shape —
 * hand variation, position and size all differ, so accuracy comes from volume.
 * Storing 100 raw templates per gesture would bloat localStorage and slow the
 * nearest-match, so condenseSamples CLUSTERS them: samples within TR_MERGE of
 * an existing centroid are merged (running average) until TR_KEEP centroids
 * remain. The matcher then only ever compares against ≤16 exemplars per
 * gesture — recognition cost stays flat no matter how much was recorded. */
function condenseSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const arr = samples.filter((s) => Array.isArray(s) && s.length === TR_N);
  if (arr.length <= TR_KEEP) return arr;
  const sums = [], counts = [], cents = [];
  for (const s of arr) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < cents.length; i++) {
      const d = gestureDist(s, cents[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi >= 0 && bd <= TR_MERGE) {
      counts[bi]++;
      for (let j = 0; j < TR_N; j++) { sums[bi][j][0] += s[j][0]; sums[bi][j][1] += s[j][1]; }
      cents[bi] = sums[bi].map((p) => [p[0] / counts[bi], p[1] / counts[bi]]);
    } else if (cents.length < TR_KEEP) {
      cents.push(s.map((p) => p.slice()));
      sums.push(s.map((p) => p.slice()));
      counts.push(1);
    } else {
      // centroid pool full — fold into the nearest one (keeps the average honest)
      let ni = 0, nd = Infinity;
      for (let i = 0; i < cents.length; i++) { const d = gestureDist(s, cents[i]); if (d < nd) { nd = d; ni = i; } }
      counts[ni]++;
      for (let j = 0; j < TR_N; j++) { sums[ni][j][0] += s[j][0]; sums[ni][j][1] += s[j][1]; }
      cents[ni] = sums[ni].map((p) => [p[0] / counts[ni], p[1] / counts[ni]]);
    }
  }
  return cents;
}

/* Nearest-match WITHOUT the accept gate — the Test button uses it to report
 * the closest saved gesture (and its distance) even when it is not a hit. */
function bestTemplateMatch(pts, templates) {
  if (!templates || !templates.length) return null;
  const cand = normalizeGesture(pts);
  if (!cand) return null;
  const rev = cand.slice().reverse();
  let best = null, bestD = Infinity;
  for (const t of templates) {
    if (!t || !Array.isArray(t.samples)) continue;
    for (const s of t.samples) {
      if (!s || s.length !== TR_N) continue;
      const d = Math.min(gestureDist(cand, s), gestureDist(rev, s));
      if (d < bestD) { bestD = d; best = t; }
    }
  }
  if (!best) return null;
  return { name: best.name, action: best.action, dist: bestD };
}

function recognizeTemplate(pts, templates) {
  const best = bestTemplateMatch(pts, templates);
  if (!best || best.dist > TR_THRESH) return null;
  return best;
}

// every learned gesture in the ACTIVE profile → [{id, name, action, samples}]
function customGestureList() {
  const g = state.profile && state.profile.gestures;
  const c = g && g.custom;
  if (!c || typeof c !== 'object') return [];
  return Object.keys(c)
    .map((id) => {
      const e = c[id] || {};
      let samples = e.samples;
      // VOLUME guard: a legacy entry saved before clustering (e.g. 100 raw
      // samples) is condensed ON THE FLY so recognition stays ≤16 templates
      // per gesture — never mutates storage, never slows the pad down.
      if (Array.isArray(samples) && samples.length > TR_KEEP) {
        const cond = condenseSamples(samples);
        if (cond.length) samples = cond;
      }
      return { id, name: e.name, action: e.action, samples, count: e.count };
    })
    .filter((t) => t && t.name && Array.isArray(t.samples) && t.samples.length);
}

function setupTrackpad() {
  const tp = $('trackpad');
  // R21: pinch diagnostic — off unless the page URL carries ?pinchdbg=1.
  // Read once here (setupTrackpad runs at init) so the flag is fixed for the
  // session; no UI, no extra listeners when off.
  let pinchDbgOn = false;
  try { pinchDbgOn = /(?:\?|&)pinchdbg=1(?:&|$)/.test(location.search); } catch (err) {}
  // R21: tiny on-pad readout element, created lazily on first 2-finger contact
  // so the normal DOM is untouched unless a pinch is actually attempted.
  let pinchDbgEl = null;
  const pinchDbgShow = (txt) => {
    if (!pinchDbgOn) return;
    if (!pinchDbgEl) {
      pinchDbgEl = document.createElement('div');
      pinchDbgEl.id = 'pinch-dbg';
      pinchDbgEl.style.cssText = 'position:absolute;left:6px;top:6px;z-index:9;'
        + 'font:11px/1.5 monospace;color:#0f0;background:rgba(0,0,0,.72);'
        + 'padding:4px 6px;border-radius:6px;pointer-events:none;white-space:pre;';
      tp.style.position = tp.style.position || 'relative';
      tp.appendChild(pinchDbgEl);
    }
    pinchDbgEl.textContent = txt;
  };
  // R24 RECORDER: one small beacon per pad gesture → the PC's gesture log
  // (server.py record_gesture). ALWAYS ON — no flag, no special page. The
  // user just uses the pad normally and the evidence collects itself on the
  // PC, ready to download from /api/gesture-log. Fire-and-forget: never
  // throws, never touches the mouse/keyboard, never changes what the pad
  // DOES — it only reports what the pad DECIDED. Prefers the live
  // WebSocket; if that is down, falls back to a plain POST so the log still
  // records that the page classified something the PC never received.
  const glogBeacon = (fingers, gesture, separation, zoom_signal, sent_to_pc) => {
    const body = {
      type: 'glog', fingers, gesture,
      separation: separation || '', zoom_signal: zoom_signal || 'none',
      sent_to_pc: sent_to_pc || '',
    };
    try {
      if (state.ws && state.ws.readyState === 1) { send(body); return; }
      fetch('/api/glog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => {});
    } catch (err) {}
  };
  // R24 RECORDER: one summary line when a 2-finger pad gesture ends — the
  // TRUE classification (pinch-with-zoom vs plain scroll), with the peak
  // separation so the gate decision is auditable from the log. Guarded:
  // fires at most once per gesture (tap beacons mark it summarized first).
  const glogSummarizeTwoFinger = () => {
    if (P.gSummarized || !P.pinchD0) return;
    P.gSummarized = true;
    const peak = Math.round(P.pinchPeak || 0);
    if (P.pinchSent !== 0) {
      const zin = P.pinchSent < 0;   // sent goes negative on spread (IN)
      const steps = Math.round(Math.abs(P.pinchSent) / PINCH_STEP_PX);
      glogBeacon(2, 'pinch', 'peak ' + peak + ' dots (gate 54)',
        zin ? 'zoom-IN' : 'zoom-OUT',
        steps + ' zoom step(s) ' + (zin ? 'IN' : 'OUT') +
        ' sent to PC (each step = hold-Ctrl + ' + zoomNotches() +
        ' wheel notch(es) at Zoom ' + Math.round(state.zoomSens) + '%)');
    } else {
      glogBeacon(2, 'scroll',
        'peak separation change ' + peak + ' dots (gate 54 — never passed)',
        'none',
        'wheel scroll on PC from a two-finger slide of about ' +
        Math.round(P.gDX || 0) + ',' + Math.round(P.gDY || 0) +
        ' dots — no zoom, as designed');
    }
  };
  const P = {
    map: new Map(),
    mode: 'idle',                    // idle | move | drag | scroll | multi
    dragHeld: false,
    tap: { count: 0, max: 0, start: 0, anyMove: false },
    long: null,
    autoAnchor: null, autoStart: 0, autoSet: false,   // autoscroll gesture state
    shape: { pts: [], on: false },   // R13.5: one-finger trace for the circle gesture
    pendX: 0, pendY: 0, pendSX: 0, pendSY: 0, raf: false, lastSent: 0,
    // R13.33: two-finger right-click — while one finger is already down (moving
    // the cursor), a SECOND finger that quickly taps = right click. twoLand =
    // when the 2nd finger landed, twoPid = its pointer id, twoFired = already
    // consumed. A held 2-finger drag stays the normal scroll.
    twoLand: 0, twoPid: null, twoFired: false,
    // R14: two-finger PINCH-to-zoom — tracked only while mode === 'scroll' and
    // exactly 2 fingers are down. pinchD0 = finger separation at 2nd-finger
    // land; pinchAcc = accumulated RELATIVE separation change (px); pinchSent =
    // last sent position. Separation SHRINK/GROW → zoom steps; parallel motion
    // keeps separation flat → pure scroll, never zoom. The gate (PINCH_*) is
    // below with the tuning constants.
    pinchD0: 0, pinchAcc: 0, pinchSent: 0,
    // R24 RECORDER: per-gesture audit fields — reset whenever the 2nd finger
    // lands (see pointerdown below), read by glogSummarizeTwoFinger at lift.
    // pinchPeak = biggest |separation change| seen this gesture (audits the
    // 54-dot gate); gSummarized = summary already written (tap marks first);
    // gDX/gDY = summed 2-finger midpoint drift (proves scroll-vs-pinch).
    pinchPeak: 0, gSummarized: false, gDX: 0, gDY: 0,
    // R27: 3-finger SWIPE trace — anchor (midpoint at 3rd-finger land) plus
    // accumulated midpoint drift. Read at lift: dominant-axis travel past
    // SWIPE_GATE_PX fires a Windows swipe action; under it = a tap. Reset on
    // every new 3rd-finger landing (see pointerdown) and at lift.
    swipeX0: 0, swipeY0: 0, swipeDX: 0, swipeDY: 0, swipeFired: false,
    // R21: pinch DIAGNOSTIC overlay (see pinchDbgShow above) — a tiny live
    // readout on the pad showing fingers/mode/separation so a pinch can be
    // WATCHED, not guessed. Enabled only via ?pinchdbg=1; off by default so
    // the normal UI is untouched.
  };

  const flush = () => {
    P.raf = false;
    P.lastSent = performance.now();
    if (P.pendX || P.pendY) {
      // keep 2 decimals, NOT rounded to int — the server accumulates fractional
      // pixels so slow/fine touches still move the cursor instead of being dropped
      send({ type: 'move', dx: Math.round(P.pendX * 100) / 100, dy: Math.round(P.pendY * 100) / 100 });
      P.pendX = P.pendY = 0;
    }
    if (P.pendSX || P.pendSY) {
      send({ type: 'scroll', dx: Math.round(P.pendSX * 10) / 100, dy: Math.round(P.pendSY * 10) / 100 });
      P.pendSX = P.pendSY = 0;
    }
  };
  // R13.13: cursor moves are sent per SAMPLE, straight from the pointermove
  // loop — touch input is NEVER throttled by the browser, unlike rAF and
  // setTimeout. Earlier this batched the coalesced samples into one message per
  // frame (summing them), so the PC received only the NET delta and JUMPED to
  // the end position — the "skipping frames" feel. One message per sample lets
  // the server trace the finger's real path at the tablet's touch-sampling rate.
  const queueMove = (dx, dy) => {
    const f = state.prec ? PREC_FACTOR : 1;
    P.pendX += dx * state.sens * f; P.pendY += dy * state.sens * f;
    flush();
  };
  const queueScroll = (dx, dy) => {
    P.pendSX += dx; P.pendSY += dy;
    if (performance.now() - P.lastSent >= 8) { flush(); return; }
    if (!P.raf) { P.raf = true; requestAnimationFrame(flush); }
  };
  // safety net: if both input and rAF stall, still flush
  setInterval(() => {
    if (!P.raf && (P.pendX || P.pendY || P.pendSX || P.pendSY)) flush();
  }, 33);

  tp.addEventListener('pointerdown', (e) => {
    tp.setPointerCapture(e.pointerId);
    e.preventDefault();
    P.shape = { pts: [], on: false };
    P.map.set(e.pointerId, {
      x: e.clientX, y: e.clientY, px: e.clientX, py: e.clientY,
      sx: e.clientX, sy: e.clientY, moved: false,
    });
    if (state.gestureMode) {
      // R13.7: gesture mode owns the pad — no taps, no long-press, no drag, no
      // cursor move. The move handler just collects the trace; on lift we fire it.
      P.shape.on = true;
      P.shape.pts.push([e.clientX, e.clientY]);
      return;
    }
    if (state.autoScroll.on) {
      // autoscroll owns the pad: touching it just re-anchors the scroll dial
      if (P.map.size === 1) { P.autoAnchor = e.clientY; P.autoStart = performance.now(); P.autoSet = false; }
      return;
    }
    if (state.panMode.on) {
      // R13.10: pan owns the pad as a pure move surface — no taps, no long-press,
      // no drag button; the middle button is already held, so dragging just pans.
      return;
    }
    if (P.tap.count === 0) P.tap.start = performance.now();
    P.tap.count++; P.tap.max = Math.max(P.tap.max, P.tap.count);

    if (P.map.size === 1) {
      clearTimeout(P.long);
      P.long = setTimeout(() => {
        const only = P.map.values().next().value;
        // scroll mode never starts a click-and-hold drag — the pad is a wheel there
        if (P.map.size === 1 && P.mode === 'idle' && only && !only.moved && holdDragEnabled() && !state.scrollMode) {
          P.mode = 'drag'; P.dragHeld = true;
          send({ type: 'click', button: 'left', action: 'down' });
        }
      }, LONG_MS);
    } else if (P.map.size === 2) {
      clearTimeout(P.long);
      P.mode = 'scroll';
      // R13.33: mark the SECOND finger that just landed — if it lifts within
      // TAP_MS while the first finger is still down, endPointer turns it into a
      // right-click instead of a scroll.
      // RC-TRACE twoLand-mark app.js:pointerdown — ghost 2nd-finger lands show here
      if (!P.twoLand) { P.twoLand = performance.now(); P.twoPid = e.pointerId; P.twoFired = false; console.log('[RC-TRACE] app.js:pointerdown twoLand mark pid=' + e.pointerId + ' mapSize=' + P.map.size); }
      // R14: arm the pinch baseline — separation of the two fingers right now.
      // Zoom stays ARMED (not fired) until the separation moves PINCH_GATE_PX;
      // a quick 2-finger tap (right-click) lifts before that, so it can never
      // zoom. A parallel 2-finger drag keeps separation flat → scroll only.
      const _pp = [...P.map.values()];
      P.pinchD0 = Math.hypot(_pp[0].x - _pp[1].x, _pp[0].y - _pp[1].y) || 1;
      P.pinchAcc = 0; P.pinchSent = 0;
      P.pinchPeak = 0; P.gSummarized = false; P.gDX = 0; P.gDY = 0;   // R24: fresh audit for this 2-finger gesture
    } else {
      clearTimeout(P.long);
      P.mode = 'multi';
      if (P.map.size === 3) {
        // (re)anchor the swipe trace on every new landing — a fresh 3rd finger
        // starts a fresh swipe, so a tap-then-slide can't inherit stale travel.
        // NOTE: pointerdown runs while map.size INCLUDES the finger that just
        // landed (P.map.set is above), so size 3 here = the real 3rd finger.
        // The R13.33 two-finger right-click marker (twoLand) is disarmed: with
        // 3 fingers down this is never a 2-finger tap, and a 2→3 landing would
        // otherwise leave twoLand armed for a phantom right-click at lift.
        P.twoLand = 0; P.twoPid = null;
        const _sp = [...P.map.values()];
        P.swipeX0 = (_sp[0].x + _sp[1].x + _sp[2].x) / 3;
        P.swipeY0 = (_sp[0].y + _sp[1].y + _sp[2].y) / 3;
        P.swipeDX = 0; P.swipeDY = 0; P.swipeFired = false;
      } else {
        // 4+ fingers: no swipe tracking — taps only (fired at lift below).
        P.swipeX0 = 0; P.swipeY0 = 0; P.swipeDX = 0; P.swipeDY = 0;
      }
    }
  });

  tp.addEventListener('pointermove', (e) => {
    const p = P.map.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    if (state.gestureMode) {
      // R13.7: never queueMove/queueScroll here — the PC cursor stays put while
      // you draw. Just accumulate the one-finger trace (coalesced samples give
      // recognizeCircle a denser loop).
      if (P.map.size === 1) {
        const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [e];
        for (const ce of evs) P.shape.pts.push([ce.clientX, ce.clientY]);
      }
      return;
    }
    if (state.autoScroll.on) {
      // the pad is a scroll "jog": where you push, it flows. Center = pause,
      // push up/down beyond 12px = scroll up/down; it keeps flowing after lift.
      if (P.map.size === 1) {
        const d = e.clientY - P.autoAnchor;               // + = finger pushed down
        if (Math.abs(d) <= 12) { state.autoScroll.dir = 0; state.autoScroll.mag = 1; }
        else {
          P.autoSet = true;
          state.autoScroll.dir = d < 0 ? 1 : -1;          // up → scroll up (dy > 0)
          state.autoScroll.mag = Math.min(2, Math.max(1, Math.ceil(Math.abs(d) / 100)));
        }
      }
      return;
    }
    // 2-finger scroll: one net delta per event (coalescing would halve it)
    if (P.mode === 'scroll') {
      // R13.33: a held two-finger scroll (past the tap window) disarms the
      // right-click so a long 2-finger drag can't fire it later on lift.
      if (P.twoLand && performance.now() - P.twoLand > TAP_MS) { P.twoLand = 0; P.twoPid = null; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.px = p.x; p.py = p.y; p.x = e.clientX; p.y = e.clientY;
      if (P.map.size === 2) {
        let sx = 0, sy = 0;
        for (const q of P.map.values()) { sx += q.x - q.px; sy += q.y - q.py; }
        // R21 FIX: a REAL pinch moves the fingers in OPPOSITE directions, so
        // the two per-finger deltas point against each other (dot < 0) and the
        // midpoint barely moves. A scroll moves them TOGETHER (dot > 0). Gate
        // the scroll queue on that: when the fingers oppose, the midpoint
        // drift is pinch geometry, not a scroll the user asked for — queueing
        // it is what made every pinch ALSO scroll (and, at 54px of travel,
        // made the "pinch" feel like nothing-but-scroll). Scroll path and
        // thresholds are otherwise untouched.
        const _pts = [...P.map.values()];
        const _ax = _pts[0].x - _pts[0].px, _ay = _pts[0].y - _pts[0].py;
        const _bx = _pts[1].x - _pts[1].px, _by = _pts[1].y - _pts[1].py;
        const _dot = _ax * _bx + _ay * _by;
        const _opp = _dot < 0 && (Math.hypot(_ax, _ay) + Math.hypot(_bx, _by)) > 0;
        if (!_opp) queueScroll(sx / 2, sy / 2);
        // R21 DIAG: one console line per 2-finger move when ?pinchdbg=1 — the
        // brief demands instrumentation over reading. Shows fingers, mode,
        // separation, acc, and whether a zoom fired.
        // R14: PINCH-to-zoom — separation change from the 2nd-finger baseline.
        // acc = D0 - d: fingers TOGETHER → acc positive → zoom OUT (dir -1);
        // fingers APART → acc negative → zoom IN (dir +1). Nothing fires until
        // |acc| passes the gate, so parallel-motion scrolls (separation wobble
        // < gate) NEVER zoom. Right-click disarm: any real motion (scroll
        // OR pinch past the move threshold) kills the tap window, matching
        // the old scroll rule.
        const _pa = [...P.map.values()];
        const _d = Math.hypot(_pa[0].x - _pa[1].x, _pa[0].y - _pa[1].y);
        P.pinchAcc = P.pinchD0 - _d;   // >0 together → OUT, <0 apart → IN
        if (Math.abs(P.pinchAcc) > P.pinchPeak) P.pinchPeak = Math.abs(P.pinchAcc);   // R24: audit the gate
        P.gDX += sx / 2; P.gDY += sy / 2;                                            // R24: audit the drift
        if (Math.abs(P.pinchAcc) >= MOVE_THRESH) { P.twoLand = 0; P.twoPid = null; }
        let _fired = 0;
        // first step at GATE+STEP past the baseline (true dead zone), then one
        // step per further STEP px. Max 2 steps per pointermove so a fast flick
        // can't dump a burst — the fingers keep moving, more steps follow on
        // the next events.
        // one step per further STEP px. sign: together(acc>0)→OUT(dir -1).
        const _need = (P.pinchSent === 0 ? PINCH_GATE_PX + PINCH_STEP_PX : PINCH_STEP_PX);
        while (Math.abs(P.pinchAcc - P.pinchSent) >= _need && _fired < 2) {
          _fired++;
          // direction: fingers together → zoom OUT (dir -1), apart → IN (+1)
          const _dir = (P.pinchAcc > P.pinchSent) ? -1 : 1;
          P.pinchSent += (_dir < 0 ? 1 : -1) * PINCH_STEP_PX;
          // R27: the slider scales the punch per step — one step = zoomNotches()
          // notches (old code always sent exactly 1). Gate/step math unchanged.
          send({ type: 'zoom', dir: _dir * zoomNotches() });
        }
        if (pinchDbgOn) { console.log('[R21-PINCH] fingers=2 mode=scroll d=' + Math.round(_d) + ' acc=' + Math.round(P.pinchAcc) + ' sent=' + Math.round(P.pinchSent) + ' opp=' + (_opp ? 1 : 0) + ' zoomFired=' + _fired); pinchDbgShow('fingers=2 mode=' + P.mode + '\nd=' + Math.round(_d) + ' D0=' + Math.round(P.pinchD0) + '\nacc=' + Math.round(P.pinchAcc) + ' sent=' + Math.round(P.pinchSent) + '\nopp=' + (_opp ? 'OPP(sep)' : 'same(scroll)') + '\nzoomFired=' + _fired); }
        // keep the sent cursor glued to the finger: remainder beyond one step
        // stays for the next event, but never more, so a stop leaves no stale
        // backlog that fires after the fingers lift.
        if (P.pinchSent !== 0) {
          const _over = P.pinchAcc - P.pinchSent;
          if (Math.abs(_over) > PINCH_STEP_PX) P.pinchSent = P.pinchAcc - Math.sign(_over) * PINCH_STEP_PX;
        }
      }
      return;
    }
    // R27: 3-finger swipe tracking — while exactly 3 fingers are down in multi
    // mode, accumulate the midpoint drift. Nothing fires here: at lift,
    // endPointer fires ONE swipe action if the dominant axis passed
    // SWIPE_GATE_PX, else the normal 3-finger tap below. Any real slide also
    // kills the tap window (P.tap.anyMove), so a swipe can never double-fire
    // as a tap. 4+ fingers skip this entirely (taps only).
    if (P.mode === 'multi' && P.map.size === 3 && P.swipeX0) {
      const _sm = [...P.map.values()];
      const _mx = (_sm[0].x + _sm[1].x + _sm[2].x) / 3;
      const _my = (_sm[0].y + _sm[1].y + _sm[2].y) / 3;
      P.swipeDX = _mx - P.swipeX0; P.swipeDY = _my - P.swipeY0;
      if (Math.hypot(P.swipeDX, P.swipeDY) >= MOVE_THRESH) P.tap.anyMove = true;
      p.px = p.x; p.py = p.y; p.x = e.clientX; p.y = e.clientY;
      return;
    }
    // move/drag: use every coalesced sample the browser buffered (high touch
    // sampling → smoother cursor, less "laggy" feel on the PC). R13.14:
    // getCoalescedEvents() returns the samples BEFORE the current event — its
    // own (newest) position is dropped unless we append e, which left the cursor
    // a step behind the finger on every pointermove. Always include e.
    const evs = [].concat(e.getCoalescedEvents ? e.getCoalescedEvents() : [], e);
    for (const ce of evs) {
      const dx = ce.clientX - p.x, dy = ce.clientY - p.y;
      p.px = p.x; p.py = p.y;
      p.x = ce.clientX; p.y = ce.clientY;
      if (Math.hypot(ce.clientX - p.sx, ce.clientY - p.sy) > MOVE_THRESH) {
        p.moved = true; P.tap.anyMove = true;
      }
      if (P.mode === 'idle' && P.map.size === 1 && p.moved) {
        P.mode = 'move';
        clearTimeout(P.long);
      }
      if (P.mode === 'move' || P.mode === 'drag') {
        // scroll mode: the whole pad becomes a mouse wheel — Y is inverted so
        // dragging a finger down scrolls down (natural), like rolling the dial
        if (state.scrollMode) queueScroll(dx * scrollWheelFactor(), -dy * scrollWheelFactor());
        else queueMove(dx, dy);
        // R13.7: gesture recognition moved OUT of normal move mode — it now only
        // runs inside the dedicated gesture mode (see the gestureMode branch), so
        // drawing an O while moving the cursor can never fire a stray gesture.
      }



    }
  });
  // R14: touchmove listener for lower-latency pointer sampling (~120Hz vs 60Hz)
  tp.addEventListener('touchmove', (e) => {
    if (e.touches.length === 0) return;
    const t = e.touches[0];
    // Find any active pointer in the map
    let p = null;
    for (const v of P.map.values()) { p = v; break; }
    if (!p) return;
    e.preventDefault();
    const dx = t.clientX - p.x, dy = t.clientY - p.y;
    p.px = p.x; p.py = p.y;
    p.x = t.clientX; p.y = t.clientY;
    if (Math.hypot(t.clientX - p.sx, t.clientY - p.sy) > MOVE_THRESH) {
      p.moved = true; P.tap.anyMove = true;
    }
    if (P.mode === 'idle' && P.map.size === 1 && p.moved) {
      P.mode = 'move';
      clearTimeout(P.long);
    }
    if (P.mode === 'move' || P.mode === 'drag') {
      if (state.scrollMode) queueScroll(dx * scrollWheelFactor(), -dy * scrollWheelFactor());
      else queueMove(dx, dy);
    }
  }, { passive: false });


  const endPointer = (e) => {
    const p = P.map.get(e.pointerId);
    if (!p) return;
    P.map.delete(e.pointerId);

    if (P.map.size === 0) {
      clearTimeout(P.long);
      const twoFired = P.twoFired;   // R13.33: did the 2-finger right-click already consume this tap?
      // R24 RECORDER: if the finished gesture was a 2-finger pad gesture, log
      // the TRUE classification before the state resets (tap → tap line,
      // scroll/pinch → summary line). Multi-finger (3+) lifts get their own
      // tap line; pure 1-finger taps keep their existing path untouched.
      if (P.tap.max === 2 && P.pinchD0) {
        if (twoFired || P.twoFired) {
          P.gSummarized = true;
          glogBeacon(2, 'tap',
            'quick two-finger touch (no real slide, no spread — under both the tap window and the 54-dot zoom gate)',
            'none', 'right-click at the cursor on the PC');
        } else {
          glogSummarizeTwoFinger();
        }
      } else if (P.tap.max >= 3) {
        // R27: 3-finger SWIPE fires here (at lift, exactly like the 2-finger
        // summary). FIRE-ONCE: the swipe/tap decision is made ONLY at the
        // map-size-0 full lift below — a partial lift (2 fingers still down)
        // never fires here, because the fingers may still come back together
        // (a tap with a mid-gesture wobble) and the anchor math needs the FULL
        // travel. The partial-lift swipe branch further below is REMOVED for
        // the same reason — one gesture, one decision, at the end.
        // Dominant-axis travel past SWIPE_GATE_PX = one Windows swipe action;
        // under it = the tap path below. 4+ fingers skip swipes (taps only —
        // a 4-finger slide is almost always an accidental palm rest).
        if (P.tap.max === 3 &&
            Math.max(Math.abs(P.swipeDX), Math.abs(P.swipeDY)) >= SWIPE_GATE_PX) {
          P.swipeFired = true;
          P.tap.anyMove = true;   // a swipe is not a tap — kill the tap window now
          const _sw = swipeActionFor(P.swipeDX, P.swipeDY);
          const _dir = Math.abs(P.swipeDY) >= Math.abs(P.swipeDX)
            ? (P.swipeDY < 0 ? 'up' : 'down') : (P.swipeDX < 0 ? 'left' : 'right');
          glogBeacon(3, 'swipe-' + _dir,
            '3-finger slide of about ' + Math.round(P.swipeDX) + ',' + Math.round(P.swipeDY) +
            ' dots (gate ' + SWIPE_GATE_PX + ' — passed)',
            'none', 'fires on PC as: ' + _sw.name);
          try { send({ type: 'combo', keys: _sw.keys }); } catch (err) {}
        } else {
          // R27: 3- and 4-finger taps now FIRE (were log-only before).
          // 3-finger tap = the Windows key (his words: "act like the Windows key
          // / Start" — same as a real laptop with Search remapped to Start, and
          // pynput already maps "win" → the real Windows key). 4-finger tap =
          // whatever Windows binds by default = Notification center = Win+N
          // (Win11 default per Microsoft's own gesture page; the Win10 default
          // was Action center = Win+A, kept in the log reason for honesty).
          // Both are queued AFTER the beacon so the log line lands first.
          const held3 = P.tap.max;
          const isFour = held3 >= 4;
          glogBeacon(held3, 'tap',
            'quick ' + held3 + '-finger touch (no real slide)',
            'none',
            isFour ? 'notification center on the PC (Win+N — the Windows default for a 4-finger tap)'
                   : 'Windows key on the PC (Start — his chosen action for a 3-finger tap)');
          try {
            if (isFour) send({ type: 'combo', keys: ['win', 'n'] });
            else send({ type: 'combo', keys: ['win'] });
          } catch (err) {}
        }
      }
      P.twoLand = 0; P.twoPid = null; P.twoFired = false;   // arm fresh next touch
      P.pinchD0 = 0; P.pinchAcc = 0; P.pinchSent = 0;       // R14: pinch over
      P.pinchPeak = 0; P.gSummarized = false; P.gDX = 0; P.gDY = 0;   // R24: audit reset
      P.swipeX0 = 0; P.swipeY0 = 0; P.swipeDX = 0; P.swipeDY = 0; P.swipeFired = false;   // R27: swipe over
      if (state.gestureMode) {
        // R13.7: last finger lifted — fire the drawn gesture (no taps, no clicks).
        // R13.19+: three shapes today — O (circle), V (vee) and the letter n (notepad);
        // each recognizer guards itself and later ones are only consulted when the
        // earlier shapes already said no (circle → V → notepad).
        const pts = P.shape.pts;
        P.shape = { pts: [], on: false };
        P.mode = 'idle';
        P.tap = { count: 0, max: 0, start: 0, anyMove: false };
        if (pts.length >= 14) {
          // R28: built-ins FIRST (circle → V → notepad, unchanged order and
          // short-circuit). The learned-template check runs LAST and only when
          // all three already declined — a custom shape can never outvote them.
          // R28.2 FIX: a shape the user TRAINED wins over the three built-ins.
          // It used to be consulted last, so a custom zigzag that faintly
          // resembled "n" fired Notepad every time and could never run at all.
          let tpl = recognizeTemplate(pts, customGestureList());
          let act = (tpl && tpl.action) ? tpl.action : null;
          if (!act) act = recognizeCircle(pts) ? gestureFor('circle') : recognizeV(pts) ? gestureFor('vee') : recognizeNotepad(pts) ? gestureFor('notepad') : null;
          logGestureTrace(pts, !!act);                // R13.20: PC sees every gesture-mode draw
          // R24 RECORDER: drawn-shape line — what the pad classified. runAction
          // sends the click/combo/launch half; this beacon is the page half.
          const shapeName = (tpl && tpl.action) ? 'draw-custom:' + tpl.name
            : recognizeCircle(pts) ? 'draw-O'
            : recognizeV(pts) ? 'draw-V'
            : recognizeNotepad(pts) ? 'draw-letter-n'
            : 'draw-unrecognized';
          glogBeacon(1, shapeName, pts.length + ' dots drawn',
            'none',
            act ? ('fires on PC as: ' + (act.click ? act.click + '-click'
              : act.keys ? act.keys.join(' + ')
              : act.launch ? 'launch ' + act.launch
              : act.text ? 'type "' + act.text + '"' : 'custom action'))
              : 'nothing fires on the PC (no shape matched)');
          if (act) runAction(act);
        } else if (pts.length >= 2) {
          // R24 RECORDER: too-short draw — evidence it was a wiggle, not a
          // shape the recognizer could ever fire on.
          glogBeacon(1, 'draw-too-short', pts.length + ' dots drawn',
            'none', 'nothing fires on the PC (needs at least 14 dots of trace)');
        }
        return;
      }
      if (state.autoScroll.on) {
        // a quick tap (no scroll gesture) while autoscrolling = stop; otherwise
        // keep flowing in the latched direction on its own
        if (!P.autoSet && performance.now() - P.autoStart < TAP_MS) toggleAutoScroll();
        P.mode = 'idle';
        P.tap = { count: 0, max: 0, start: 0, anyMove: false };
        P.autoAnchor = null;
        return;
      }
      if (P.dragHeld) {
        send({ type: 'click', button: 'left', action: 'up' });
        P.dragHeld = false;
      } else if (!twoFired && !P.tap.anyMove && performance.now() - P.tap.start < TAP_MS) {
        // R27: 3-finger tap fires the Windows key, 4-finger tap fires Win+N
        // (Notification center) — BEFORE the shared path below, because
        // gestureFor() only knows oneTap/twoTap/threeTap and threeTap still
        // means middle-click (the Customize default, used elsewhere). Queued
        // AFTER the map-size-0 beacon above, so the log line lands first.
        // GUARD: a swipe that already fired (P.swipeFired) must never ALSO fire
        // a tap — with staggered lifts the swipe branch above fires at the
        // first lift and the tap window may still look "quick" at the last.
        if (!P.swipeFired) {
          if (P.tap.max === 3) { try { send({ type: 'combo', keys: ['win'] }); } catch (err) {} }
          else if (P.tap.max >= 4) { try { send({ type: 'combo', keys: ['win', 'n'] }); } catch (err) {} }
          else {
            const act = gestureFor(P.tap.max);
            // RC-TRACE tap-fire app.js:endPointer — tapMax 2 here = twoTap right-click
            if (act) { if (P.tap.max === 2) console.log('[RC-TRACE] app.js:endPointer tap-fire tapMax=2 right-click, dt=' + Math.round(performance.now() - P.tap.start) + 'ms'); runAction(act); }
          }
        }
      }
      // R13.17: last finger up — tell the server to drop the glide backlog NOW
      // so the cursor stops the instant you lift (no skid after the finger is
      // gone).
      send({ type: 'stop' });
      P.shape = { pts: [], on: false };
      P.mode = 'idle';
      P.tap = { count: 0, max: 0, start: 0, anyMove: false };
    } else {
      // R13.33: the SECOND finger lifted while the first is still down — if that
      // tap was quick (< TAP_MS), it's a right-click at the cursor's current
      // spot, anywhere on the pad. The old 2-tap only fired when NO finger had
      // moved; this fires mid-move, which is what replaces the L/R edge buttons.
      if (!P.twoFired && P.twoLand && e.pointerId === P.twoPid && P.map.size === 1 &&
          P.tap.max === 2 &&   // exactly two fingers this gesture — never steal a 3-finger middle-click
          performance.now() - P.twoLand < TAP_MS) {
        // RC-TRACE twofinger-fire app.js:endPointer — the R13.33 mid-move right-click
        console.log('[RC-TRACE] app.js:endPointer twofinger-fire right-click, dt=' + Math.round(performance.now() - P.twoLand) + 'ms tapMax=' + P.tap.max);
        P.twoFired = true;
        P.pendSX = P.pendSY = 0;   // drop any tiny scroll the brief 2-finger state queued
        const act = gestureFor(2);
        if (act) runAction(act);
      }
      if (P.twoLand && e.pointerId === P.twoPid) { P.twoLand = 0; P.twoPid = null; }
      // R27: NO swipe classification on partial lifts — the swipe/tap decision
      // fires exactly once at the map-size-0 full lift above (one gesture, one
      // decision). A partial lift only re-arms the modes below. (An earlier
      // revision fired here too and double-fired swipe-then-tap on staggered
      // lifts — removed, proven by the R27 event-replay test E3.)
      if (P.mode === 'scroll' && P.map.size === 1) {
        // R24 RECORDER: the 2-finger gesture ends here (2nd finger lifted
        // early, 1st still down): write the summary NOW — the map-size-0
        // branch above will never run for this gesture. A tap that already
        // fired marks summarized; anything else gets the true scroll/pinch
        // classification.
        if (P.tap.max === 2 && P.pinchD0) {
          if (P.twoFired) { P.gSummarized = true; }
          else { glogSummarizeTwoFinger(); }
        }
        P.mode = 'move';
        const q = P.map.values().next().value;
        q.sx = q.x; q.sy = q.y; q.moved = false;
        // R14: back to one finger — pinch is over, re-arm fresh next time.
        P.pinchD0 = 0; P.pinchAcc = 0; P.pinchSent = 0;
        P.pinchPeak = 0; P.gSummarized = false; P.gDX = 0; P.gDY = 0;   // R24: audit reset
      }
      // R27: a multi-finger gesture that decayed to 2 fingers then 1 (lifted one
      // at a time) must not leave a stale swipe anchor behind — BUT the anchor
      // must survive while the gesture is still classifiable. Clearing here
      // (at the FIRST staggered lift) wiped swipeDX/DY before the map-size-0
      // full lift could read them, turning every real swipe into a tap
      // (proven by event-replay E3). So: clear ONLY when the gesture is over
      // (map-size-0 full lift, handled above) or when it decayed back to a
      // mode the swipe can never resume from — mode left 'multi'. While mode
      // is still 'multi' with fingers down, the swipe is still alive.
      if (P.mode !== 'multi') {
        P.swipeX0 = 0; P.swipeY0 = 0; P.swipeDX = 0; P.swipeDY = 0;
      }
    }
  };
  tp.addEventListener('pointerup', endPointer);
  tp.addEventListener('pointercancel', endPointer);
}

/* ---------------------------------------------- finger-gate (R14) ---------- */
/* Tracks finger contact on #trackpad (the sole cursor-moving surface — the */
/* portrait pad widens to full width, so this covers BOTH trackpad + touchscreen */
/* modes). Signals the server while a finger is down so the screen stream stays */
/* relaxed (smooth) during a resting finger and only climbs to HIGH quality once */
/* the finger actually lifts. Independent of setupTrackpad (setPointerCapture */
/* coexists). Heartbeat every 0.4s while active = safety net for missed pointerup. */
(function fingerGate() {
  const tp = $('trackpad');
  if (!tp) return;
  const down = new Set();   // captured pointerIds currently engaged on the pad
  let hb = null;             // heartbeat interval
  const beat = () => { if (down.size > 0) send({ type: 'touch', active: 1 }); };
  const onDown = (e) => {
    // capture the pointer so move/up/cancel keep flowing to the pad even when
    // the finger physically slides OFF the pad bounds — a drag is a
    // pointer-DOWN-TO-LIFT lifecycle, not an "is it inside the rectangle" test.
    try { tp.setPointerCapture(e.pointerId); } catch (err) {}
    if (down.size === 0) {
      send({ type: 'touch', active: 1 });
      if (hb) clearInterval(hb);
      hb = setInterval(beat, 400);
    }
    down.add(e.pointerId);
  };
  const onUp = (e) => {
    if (!down.has(e.pointerId)) return;   // ignore events for pointers we never saw go down
    down.delete(e.pointerId);
    // release the capture so the pointer is free again
    try { tp.releasePointerCapture(e.pointerId); } catch (err) {}
    if (down.size === 0) {
      if (hb) { clearInterval(hb); hb = null; }
      send({ type: 'touch', active: 0 });
    }
  };
  // lostpointercapture = the browser canceled capture (e.g. the finger slid out
  // of the active capture region). This is NOT a lift — keep active=1 so a
  // drag that leaves the pad bounds stays smooth until the REAL pointerup.
  const onLostCapture = (e) => {
    // lostpointercapture = the browser canceled capture (e.g. the finger slid
    // out of the active capture region). This is NOT a lift — keep active=1 so a
    // drag that leaves the pad bounds stays smooth until the REAL pointerup.
    // Remove it from the down set (so we don't wait on it) but do NOT send
    // active=0; the server's 2.0s silence timeout recovers HIGH if the lift
    // never arrives.
    down.delete(e.pointerId);
  };
  tp.addEventListener('pointerdown', onDown);
  tp.addEventListener('pointerup', onUp);
  tp.addEventListener('pointercancel', onUp);
  tp.addEventListener('lostpointercapture', onLostCapture);
  // page hidden (backgrounded tab / lock screen) == finger effectively gone
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && down.size > 0) {
      down.clear();
      if (hb) { clearInterval(hb); hb = null; }
      send({ type: 'touch', active: 0 });
    }
  });
})();

function gestureName(g) {
  if (!g) return 'off';
  if (g.click) return g.click + ' click';
  if (g.scroll) return g.scroll[1] > 0 ? 'scroll up' : 'scroll down';
  if (g.zoom) return g.zoom > 0 ? 'zoom in' : 'zoom out';
  if (g.drag) return 'drag';
  if (g.text) return 'type';
  return 'off';
}
function updateTpHint() {
  const g = (state.profile && state.profile.gestures) || DEFAULT_GESTURES;
  if (state.gestureMode) {
    $('tp-hint').textContent = 'gesture mode — draw O, V or an n (Notepad) on the pad · fires on lift (no cursor move)';
    return;
  }
  if (state.autoScroll.on) {
    $('tp-hint').textContent = 'autoscroll — move up/down, then it flows · tap M or the pad to stop';
    return;
  }
  if (state.panMode.on) {
    $('tp-hint').textContent = 'pan — drag to move the preview · tap M to release';
    return;
  }
  if (state.scrollMode) {
    $('tp-hint').textContent = 'scroll mode — drag to scroll · tap ↕ to move again';
    return;
  }
  const parts = [
    'move',
    'tap=' + gestureName(g.oneTap),
    '2-tap=' + gestureName(g.twoTap),
    '3-tap=Win key',
    '4-tap=notifications',
    '3-swipe=Task View/desktop/switch',
    'pinch=zoom',   // R14: two-finger spread/pinch → zoom in/out (Ctrl+wheel); R27 Zoom slider scales it
  ];
  if (g.hold === 'drag') parts.push('hold=drag');
  $('tp-hint').textContent = parts.join(' · ');
}

function sizeTrackpad() {
  // R13 (restored R12 flanking): the L·M·R hold column shares the pad's height
  // and sits on the pad's LEFT (landscape) / RIGHT edge (portrait), so it does
  // not shrink the pad — only the arrow cluster + sens row take vertical space.
  // The pad height is capped at a 4:5 (w:h) shape so it doesn't eat the whole
  // column in portrait; the height it frees goes to #rail-btns (flex:1) — that's
  // where the bigger buttons come from. Landscape is already under the cap.
  // IMPORTANT: computed from the rail's FIXED geometry (arrow cluster + sens
  // row + padding/gaps + a floor for the buttons), NOT from rail-btns' live
  // height — rail-btns is flex:1 and would otherwise grab every pixel and
  // collapse the pad to nothing.
  const tp = $('trackpad');
  const pa = $('pad-area');
  const pw = $('pad-wrap');
  // R13.42: on narrow stacked layouts (<=560px the bank sits ABOVE the rail)
  // the rail is short — relax the floors so the pad fits instead of forcing
  // scroll. Wide tablet/desktop behavior unchanged.
  const narrow = window.matchMedia('(max-width: 560px)').matches;
  const MIN = narrow ? 96 : 140;
  const portrait = window.matchMedia('(max-aspect-ratio: 3/4)').matches;
  // R13.30: portrait pad is now HALF as tall — capped at a 8:5 (w:h) shape, i.e.
  // about as tall as the L·M·R trio in the hold column ("limitation to R"), so
  // the massive full-height pad shrinks to a compact thumb-area. Landscape
  // keeps the old 4:5 cap (0.8).
  const MAX_RATIO = portrait ? 1.6 : 0.8;
  const rail = $('rail');
  const cs = getComputedStyle(rail);
  const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.gap || cs.rowGap) || 8;
  // the buttons must always get at least this much height (portrait needs more
  // room than landscape because the pad shrinks so much)
  const buttonsFloor = narrow ? 96 : portrait ? 240 : 140;
  // R13 (restored R12 flanking): the hold COLUMN shares the pad's height, so it
  // is NOT part of the fixed vertical stack — only arrow cluster + sens row +
  // rail padding + two gaps between them count against the pad's height.
  const fixedH = padV + gap * 2 + buttonsFloor
    + $('arrowrow').getBoundingClientRect().height
    + $('senswrap').getBoundingClientRect().height;
  const w = Math.max(MIN, pw.clientWidth);
  // R13.29: in portrait the trackpad WIDENS to the screen's left edge (pad-wrap
  // is absolutely stretched), but its HEIGHT must stay exactly as the in-rail
  // pad was — cap it by the ORIGINAL pad width (rail content minus the hold
  // column + its gap), never the extended full width, or every button above
  // would shrink. Landscape keeps the in-flow width (capW = w).
  const capW = portrait ? Math.max(MIN, rail.clientWidth - padH - 44 - gap) : w;
  // R13.27: when the PC-screen stream is visible it eats vertical space at the
  // top; count that bar back in so the pad keeps its no-stream size and the
  // RAIL scrolls instead of clipping (see body.stream-on in the CSS). No stream
  // visible → barH is 0 and behavior is exactly as before.
  const bar = $('streambar');
  const barH = (bar && !bar.classList.contains('off')) ? bar.getBoundingClientRect().height : 0;
  // R13.42k: the stream splitter sits OUTSIDE #streambar (sibling, below it) —
  // count its box too while visible or the pad sizes ~30px too tall. Hidden =
  // zero (computed display is ground truth).
  const _ss = $('streamsplit');
  const splitH = (_ss && window.getComputedStyle(_ss).display !== 'none')
    ? _ss.getBoundingClientRect().height : 0;
  const railH = rail.getBoundingClientRect().height + barH + splitH;
  const h = Math.max(MIN, Math.min(railH - fixedH, capW / MAX_RATIO));
  tp.style.width = w + 'px';
  tp.style.height = h + 'px';
  pa.style.height = h + 'px';   // hold column flanks at the pad's exact height
  const holdCol = $('hold-col');
  if (holdCol) holdCol.style.height = h + 'px';   // R13.29: pinned hold column shares the pad's height
  // R13.42d/j: the mobile strip OWNS stacked ≤450px — kill the in-pad rows'
  // inline geometry there (the CSS hides them; stale inline width/left would
  // fight it on resize back and forth). Side-by-side tablets (wide aspect,
  // even at ≤450px CSS width) keep R13.29 behavior — same gate as the CSS.
  const mobile = window.matchMedia('(max-width: 450px) and (max-aspect-ratio: 3/4)').matches;
  if (portrait && !mobile) {
    // R13.29: the L·↕·R click rows (top + bottom) must NOT spread across the
    // now-full-width pad — keep them at their ORIGINAL width and right-anchored
    // (the user's right-hand layout), so the three buttons stay the compact size
    // they always were instead of turning into full-screen bars.
    const rowW = Math.max(MIN, capW - 20);   // original row width (10px each side)
    for (const id of ['pad-clickrow', 'pad-clickrow-b']) {
      const row = $(id);
      if (row) { row.style.left = 'auto'; row.style.right = '10px'; row.style.width = rowW + 'px'; }
    }
    // R13.29: the extended trackpad OVERLAYS the bottom of the left bank — pad
    // the bank's scroll CONTENT (never the bank box) so every bank button keeps
    // its original size AND stays reachable by scrolling above the pad.
    const bankBody = $('bank-body');
    if (bankBody) bankBody.style.paddingBottom = h + 'px';
  } else if (mobile) {
    // mobile strip mode: the pad does NOT extend (no overlay) — drop the bank
    // padding and clear any stale inline row geometry from wider widths
    const bankBody = $('bank-body');
    if (bankBody) bankBody.style.paddingBottom = '';
    for (const id of ['pad-clickrow', 'pad-clickrow-b']) {
      const row = $(id);
      if (row) { row.style.left = ''; row.style.right = ''; row.style.width = ''; }
    }
  }
}

/* -------------------------------------------------- customize (modal) ----- */
let czTab = 'gestures';

const GESTURE_PRESETS = [
  { label: 'Left click',   value: { click: 'left' } },
  { label: 'Right click',  value: { click: 'right' } },
  { label: 'Middle click', value: { click: 'middle' } },
  { label: 'Scroll up',    value: { scroll: [0, 1] } },
  { label: 'Scroll down',  value: { scroll: [0, -1] } },
  { label: 'None',         value: null },
];

function sameAction(a, b) {
  if (!a || !b) return a === b;
  if (a.seq || b.seq) return JSON.stringify(a.seq || null) === JSON.stringify(b.seq || null);
  if (a.keys) return JSON.stringify(a.keys) === JSON.stringify(b.keys);
  if (a.click) return a.click === b.click;
  if (a.scroll) return a.scroll[0] === b.scroll[0] && a.scroll[1] === b.scroll[1];
  if (a.text) return a.text === b.text;
  if (a.drag) return !!b.drag;
  if (a.hold) return a.hold === b.hold;
  if (a.auto) return !!b.auto;
  if (a.launch) return a.launch === b.launch;
  return false;
}

function actionType(a) {
  if (!a) return 'none';
  if (a.keys) return 'keys';
  if (a.click) return 'click';
  if (a.scroll) return 'scroll';
  if (a.text) return 'text';
  if (a.drag) return 'drag';
  if (a.hold) return 'hold-' + a.hold;
  if (a.auto) return 'autoscroll';
  if (a.launch) return 'launch';
  return 'none';
}
function actionFrom(selType, val) {
  switch (selType) {
    case 'keys': {
      const ks = String(val || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
      return ks.length ? { keys: ks } : null;
    }
    case 'click': return val ? { click: val } : null;
    case 'scroll': return val === 'up' ? { scroll: [0, 1] } : val === 'down' ? { scroll: [0, -1] } : null;
    case 'text': return val ? { text: val } : null;
    case 'drag': return { drag: true };
    case 'hold-left': return { hold: 'left' };
    case 'hold-right': return { hold: 'right' };
    case 'autoscroll': return { auto: true };
    case 'launch': return val ? { launch: val } : null;
    default: return null;
  }
}

function openCustomize() { renderCustomize(); $('customize-modal').classList.remove('hidden'); }
function closeCustomize() { $('customize-modal').classList.add('hidden'); renderAll(); }
function setCzTab(t) {
  czTab = t;
  document.querySelectorAll('.cztab').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.cz-pane').forEach((p) => p.classList.toggle('hidden', p.id !== 'cz-' + t));
}
function renderCustomize() {
  $('cz-profile-name').textContent = 'Profile: ' + state.profile.name;
  renderGesturesPane();
  renderRailPane();
  renderArrowsPane();
  renderBankPane();
  renderProfilesPane();
  document.querySelectorAll('.cztab').forEach((b) => { b.onclick = () => setCzTab(b.dataset.tab); });
  setCzTab(czTab);
}

function renderGesturesPane() {
  const host = $('cz-gestures');
  host.innerHTML = '';
  const rows = [
    ['oneTap', '1-finger tap'],
    ['twoTap', '2-finger tap'],
    ['threeTap', '3-finger tap'],
  ];
  for (const [key, label] of rows) {
    const row = document.createElement('div');
    row.className = 'cz-row';
    const lab = document.createElement('span');
    lab.className = 'cz-label';
    lab.textContent = label;
    row.appendChild(lab);
    const sel = document.createElement('select');
    sel.className = 'cz-select';
    for (const p of GESTURE_PRESETS) {
      const o = document.createElement('option');
      o.value = p.label;
      o.textContent = p.label;
      sel.appendChild(o);
    }
    const cur = state.profile.gestures[key];
    const match = GESTURE_PRESETS.find((p) => sameAction(p.value, cur));
    sel.value = (match || GESTURE_PRESETS[GESTURE_PRESETS.length - 1]).label;
    sel.addEventListener('change', () => {
      const p = GESTURE_PRESETS.find((x) => x.label === sel.value);
      state.profile.gestures[key] = p.value ? JSON.parse(JSON.stringify(p.value)) : null;
      persistProfile();
    });
    row.appendChild(sel);
    host.appendChild(row);
  }
  const crow = document.createElement('div');
  crow.className = 'cz-row';
  const clab = document.createElement('span');
  clab.className = 'cz-label';
  clab.textContent = 'Draw a circle ⭕ (one-finger loop)';
  crow.appendChild(clab);
  crow.appendChild(makeActionEditor(state.profile.gestures.circle || null, (act) => {
    state.profile.gestures.circle = act ? JSON.parse(JSON.stringify(act)) : null;
    persistProfile();
  }));
  host.appendChild(crow);
  const vrow = document.createElement('div');
  vrow.className = 'cz-row';
  const vlab = document.createElement('span');
  vlab.className = 'cz-label';
  vlab.textContent = 'Draw a V (letter V — down, then up)';
  vrow.appendChild(vlab);
  vrow.appendChild(makeActionEditor(state.profile.gestures.vee || null, (act) => {
    state.profile.gestures.vee = act ? JSON.parse(JSON.stringify(act)) : null;
    persistProfile();
  }));
  host.appendChild(vrow);
  const nrow = document.createElement('div');
  nrow.className = 'cz-row';
  const nlab = document.createElement('span');
  nlab.className = 'cz-label';
  nlab.textContent = 'Draw the letter n — launch Notepad';
  nrow.appendChild(nlab);
  nrow.appendChild(makeActionEditor(state.profile.gestures.notepad || null, (act) => {
    state.profile.gestures.notepad = act ? JSON.parse(JSON.stringify(act)) : null;
    persistProfile();
  }));
  host.appendChild(nrow);
  const hrow = document.createElement('div');
  hrow.className = 'cz-row';
  const hlab = document.createElement('span');
  hlab.className = 'cz-label';
  hlab.innerHTML = 'Press &amp; hold';
  hrow.appendChild(hlab);
  const hsel = document.createElement('select');
  hsel.className = 'cz-select';
  hsel.innerHTML = '<option value="drag">Start drag (hold mouse down)</option><option value="none">Nothing</option>';
  hsel.value = state.profile.gestures.hold === 'drag' ? 'drag' : 'none';
  hsel.addEventListener('change', () => { state.profile.gestures.hold = hsel.value; persistProfile(); });
  hrow.appendChild(hsel);
  host.appendChild(hrow);
}

/* action editor: <select type> + contextual input, calls cb(action) on change */
function makeActionEditor(a, cb) {
  const wrap = document.createElement('span');
  wrap.className = 'action-ed';
  const sel = document.createElement('select');
  sel.className = 'cz-select';
  const opts = [
    ['none', 'None'], ['keys', 'Key combo'], ['click', 'Click'],
    ['scroll', 'Scroll'], ['text', 'Type text'], ['drag', 'Drag toggle'],
    ['hold-left', 'Hold left'], ['hold-right', 'Hold right'], ['autoscroll', 'Autoscroll'],
    ['launch', 'Launch app'],
  ];
  for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
  sel.value = actionType(a);
  const ctx = document.createElement('span');
  ctx.className = 'action-ctx';
  const rebuild = () => {
    ctx.innerHTML = '';
    const t = sel.value;
    if (t === 'keys') {
      const inp = document.createElement('input');
      inp.className = 'cz-input';
      inp.placeholder = 'e.g. ctrl s';
      inp.value = (a && a.keys ? a.keys : []).join(' ');
      inp.addEventListener('input', () => cb(actionFrom('keys', inp.value)));
      ctx.appendChild(inp);
    } else if (t === 'click') {
      const s2 = document.createElement('select');
      s2.className = 'cz-select';
      s2.innerHTML = '<option value="left">Left</option><option value="right">Right</option><option value="middle">Middle</option>';
      s2.value = (a && a.click) || 'left';
      s2.addEventListener('change', () => cb(actionFrom('click', s2.value)));
      ctx.appendChild(s2);
    } else if (t === 'scroll') {
      const s2 = document.createElement('select');
      s2.className = 'cz-select';
      s2.innerHTML = '<option value="up">Up</option><option value="down">Down</option>';
      s2.value = (a && a.scroll && a.scroll[1] > 0) ? 'up' : 'down';
      s2.addEventListener('change', () => cb(actionFrom('scroll', s2.value)));
      ctx.appendChild(s2);
    } else if (t === 'text') {
      const inp = document.createElement('input');
      inp.className = 'cz-input';
      inp.placeholder = 'text to type';
      inp.value = (a && a.text) || '';
      inp.addEventListener('input', () => cb(actionFrom('text', inp.value)));
      ctx.appendChild(inp);
    } else if (t === 'drag') {
      ctx.textContent = '(toggle left-click hold)';
    } else if (t === 'hold-left' || t === 'hold-right') {
      ctx.textContent = '(toggle ' + t.replace('hold-', '') + ' button held)';
    } else if (t === 'autoscroll') {
      ctx.textContent = '(middle-click autoscroll)';
    } else if (t === 'launch') {
      const inp = document.createElement('input');
      inp.className = 'cz-input';
      inp.placeholder = 'app name set up on the PC (or use the list above)';
      inp.value = (a && a.launch) || '';
      inp.addEventListener('input', () => cb(actionFrom('launch', inp.value)));
      ctx.appendChild(inp);
    }
  };
  sel.addEventListener('change', () => {
    const t = sel.value;
    cb(actionFrom(t, t === 'scroll' ? 'down' : t === 'click' ? 'left' : ''));
    rebuild();
  });
  rebuild();
  wrap.appendChild(sel);
  wrap.appendChild(ctx);
  return wrap;
}

/* ---------------------------------------------------- gesture trainer (R28)
 * ✋ Train → #train-modal. Plain-language wizard for a NON-TECHNICAL user:
 *   name → draw the shape AS OFTEN AS YOU LIKE (3 minimum, live count, ✓ Done
 *   button — 20/50/100 samples are fine, accuracy comes from volume) → pick
 *   the action → optional TEST → Save / Cancel. The strokes are normalised to
 *   unit space, condensed (clustered) to ≤16 exemplars, and stored in
 *   profile.gestures.custom (same store as circle/vee/notepad) via
 *   persistProfile() → localStorage rc_profiles. The list at the bottom can
 *   delete any saved gesture; 🔬 hands off to gesture-lab.html for bulk
 *   recording + ⚡ Implement.
 */
let trState = null;    // { strokes: [], action, testing, lastDrawn }

function openTrainPanel() {
  trState = { strokes: [], action: null, testing: false, lastDrawn: null };
  $('tr-name').value = '';
  $('tr-msg').textContent = '';
  $('tr-testout').textContent = 'Record at least 1 drawing first.';
  const modal = $('train-modal');
  modal.classList.remove('hidden');
  try {
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
  } catch (e) {}
  try { document.body.style.overflow = 'hidden'; } catch (e) {}
  const ed = $('tr-action');
  ed.innerHTML = '';
  // R29 — step 3 needs NO technical knowledge: friendly pick-and-choose menu
  // (offline, no config.json, no key names) + optional plain-language "describe
  // it" AI bridge. The old type-a-combo editor still exists, collapsed under
  // "Other ways (advanced)". config.json / exact hotkey = fully OPTIONAL here.
  if (window.RCActionPicker) {
    RCActionPicker.mount(ed, {
      onPick: (act) => { if (trState) trState.action = act || null; trProgress(); },
      advanced: (host, pick) => {
        host.appendChild(makeActionEditor(null, (act) => pick(act)));
      },
    });
  } else {
    ed.appendChild(makeActionEditor(null, (act) => { if (trState) trState.action = act; }));
  }
  trSizeCanvas();
  trRedraw();
  trProgress();
  trRenderList();
}
function closeTrainPanel() {
  $('train-modal').classList.add('hidden');
  try { document.body.style.overflow = ''; } catch (e) {}
  trState = null;
}

function trSizeCanvas() {
  const cv = $('tr-canvas');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(120, cv.clientWidth || 640);
  const h = Math.max(120, cv.clientHeight || 220);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function trStrokePath(ctx, pts, color, width) {
  if (!pts || pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function trRedraw(live) {
  const cv = $('tr-canvas');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr, h = cv.height / dpr;
  ctx.clearRect(0, 0, w, h);
  // dotted guide box so it reads as "draw here"
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.restore();
  if (!trState) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#22d3ee';
  // many samples overlay — thin lines so 50/100 recordings stay readable
  const n = trState.strokes.length;
  const lw = n > 30 ? 1.5 : n > 10 ? 2.5 : 4;
  trState.strokes.forEach((s) => trStrokePath(ctx, s, accent, lw));
  if (live && live.length > 1) trStrokePath(ctx, live, '#e2e8f0', 4);
}

function trProgress() {
  const el = $('tr-progress');
  if (!trState) return;
  const n = trState.strokes.length;
  // LIVE COUNT — always front and centre; the user decides when to stop (no cap)
  if (trState.testing || n >= 3) {
    el.textContent = '● ' + n + ' sample' + (n === 1 ? '' : 's') +
      ' recorded ✓ — keep drawing for better accuracy (20 / 50 / 100 all fine), or tap Done / Test / Save.';
  } else {
    el.textContent = 'Draw your shape — ' + n + ' of 3 minimum (record as many as you like: 20, 50, 100…)';
  }
  const save = $('tr-save');
  // R29: an action from the friendly menu or the plain-language AI path always
  // counts — the user never has to type a key name or touch config.json.
  if (save) save.disabled = !(n >= 3 && trState.action);
  const done = $('tr-done');
  if (done) done.textContent = n ? '✓ Done (' + n + ')' : '✓ Done';
}

function trValidStroke(pts) {
  if (!pts || pts.length < 8) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }
  return Math.max(maxX - minX, maxY - minY) >= 24;
}

function trTestStroke() {
  const st = trState;
  const out = $('tr-testout');
  if (!st || !st.strokes.length) { out.textContent = 'Record at least 1 drawing first.'; return; }
  const last = st.lastDrawn;
  if (!last) { out.textContent = 'Draw the shape once in the box, then tap Test.'; return; }
  // TEST uses the SAME normalisation AND clustering as Save — raw strokes aren't
  // fixed-length, and condensing first keeps a 100-sample test as fast as a 3-sample one
  const samples = condenseSamples(st.strokes.map((s) => normalizeGesture(s)).filter(Boolean));
  if (!samples.length) { out.textContent = 'The recordings were too small — Clear all and redraw bigger.'; return; }
  const hit = recognizeTemplate(last, [{ name: 'test', action: st.action, samples }]);
  if (hit) out.textContent = '✓ Recognised! It would do: ' + actionTitle(hit.action || st.action);
  else {
    const near = bestTemplateMatch(last, [{ name: 'test', action: st.action, samples }]);
    out.textContent = '✗ Not recognised yet' + (near
      ? ' (closest distance ' + near.dist.toFixed(3) + ', needs ≤ ' + TR_THRESH + ')' : '') +
      ' — draw it a bit more like your other samples.';
  }
}

function trRenderList() {
  const host = $('tr-list');
  host.innerHTML = '';
  const list = customGestureList();
  if (!list.length) {
    host.innerHTML = '<span class="muted">None yet. Gestures you Implement from the 🔬 Gesture Lab appear here too.</span>';
    return;
  }
  for (const g of list) {
    const row = document.createElement('div');
    row.className = 'tr-item';
    const lab = document.createElement('span');
    lab.textContent = g.name + ' → ' + actionTitle(g.action) +
      (g.count ? ' · ' + g.count + ' samples' : ' · ' + g.samples.length + ' templates');
    const del = document.createElement('button');
    del.className = 'chip danger';
    del.textContent = '✕';
    del.title = 'Delete this gesture';
    del.addEventListener('click', () => {
      const c = state.profile.gestures.custom;
      if (!c) return;
      if (!window.confirm('Delete the gesture "' + g.name + '"?')) return;
      delete c[g.id];
      persistProfile();
      trRenderList();
    });
    row.appendChild(lab);
    row.appendChild(del);
    host.appendChild(row);
  }
}

function trSave() {
  const st = trState;
  const msg = $('tr-msg');
  if (!st) return;
  const name = ($('tr-name').value || '').trim() || 'My gesture';
  if (st.strokes.length < 3) { msg.textContent = 'Draw the shape at least 3 times first (more samples = better accuracy).'; return; }
  if (!st.action) { msg.textContent = 'Choose what it should do in step 3 — just tap one from the list (no setup needed).'; return; }
  // R29: accept any validated action (menu pick, plain-language AI result, or a
  // hand-typed combo from the advanced box). config.json / exact hotkey = optional.
  let savedAction;
  try {
    savedAction = (window.RCActionPicker && st.action && typeof st.action === 'object')
      ? RCActionPicker.validateAction(st.action)
      : JSON.parse(JSON.stringify(st.action));
  } catch (e) {
    msg.textContent = 'That action could not be saved (' + (e && e.message ? e.message : 'invalid') + ') — pick another from the list.';
    return;
  }
  if (!savedAction) { msg.textContent = 'Choose what it should do in step 3 — just tap one from the list (no setup needed).'; return; }
  const raw = [];
  for (const s of st.strokes) { const n = normalizeGesture(s); if (n) raw.push(n); }
  if (raw.length < 1) { msg.textContent = 'The drawings were too small — clear all and draw bigger.'; return; }
  // cluster 20/50/100 recordings down to ≤16 exemplars — recognition stays fast
  const samples = condenseSamples(raw);
  if (!state.profile.gestures.custom || typeof state.profile.gestures.custom !== 'object') {
    state.profile.gestures.custom = {};
  }
  const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  state.profile.gestures.custom[id] = {
    name,
    action: JSON.parse(JSON.stringify(st.action)),
    samples,
    count: raw.length,          // how many samples the user actually recorded
    from: 'trainer',
  };
  persistProfile();          // same store as built-ins: profile.gestures → rc_profiles
  setStatus('Gesture "' + name + '" saved ✓ · ' + raw.length + ' samples → ' + samples.length + ' templates', 'good');
  trRenderList();
  closeTrainPanel();
}

function setupTrainer() {
  const btn = $('btn-train');
  if (!btn) return;
  btn.addEventListener('click', openTrainPanel);
  $('tr-cancel').addEventListener('click', closeTrainPanel);
  $('tr-save').addEventListener('click', trSave);
  $('tr-test').addEventListener('click', trTestStroke);
  // ✓ Done — the user stops recording whenever THEY choose (no fixed 3-count)
  const doneBtn = $('tr-done');
  if (doneBtn) doneBtn.addEventListener('click', () => {
    if (!trState) return;
    if (!trState.strokes.length) { $('tr-msg').textContent = 'Draw at least 1 sample first.'; return; }
    trState.testing = true;
    $('tr-msg').textContent = trState.strokes.length +
      ' samples recorded ✓ — pick an action (step 3), then Test or Save.';
    trProgress();
  });
  // 🔬 hand off to the Gesture Data-Lab (bulk recording + ⚡ Implement)
  const labBtn = $('tr-lab');
  if (labBtn) labBtn.addEventListener('click', () => { location.href = 'gesture-lab.html?from=train'; });
  $('tr-clear').addEventListener('click', () => {
    if (!trState) return;
    trState.strokes = []; trState.testing = false; trState.lastDrawn = null;
    $('tr-msg').textContent = '';
    $('tr-testout').textContent = 'Record at least 1 drawing first.';
    trRedraw(); trProgress();
  });
  $('tr-redo').addEventListener('click', () => {
    if (!trState) return;
    trState.strokes.pop(); trState.testing = trState.strokes.length >= 3; trState.lastDrawn = null;
    $('tr-msg').textContent = '';
    trRedraw(); trProgress();
  });
  // click the dim backdrop (not the box) = Cancel, like the other modals
  $('train-modal').addEventListener('click', (e) => { if (e.target === $('train-modal')) closeTrainPanel(); });

  // one-finger draw into the canvas — collects raw [x,y] like P.shape.pts
  const cv = $('tr-canvas');
  let drawing = null;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!trState) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    drawing = [pos(e)];
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    drawing.push(pos(e));
    trRedraw(drawing);
  });
  const finish = (e) => {
    if (!drawing || !trState) return;
    e.preventDefault();
    const pts = drawing;
    drawing = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!trValidStroke(pts)) { trRedraw(); $('tr-msg').textContent = 'Too small — draw a bigger shape, then lift.'; return; }
    const st = trState;
    st.lastDrawn = pts;
    st.strokes.push(pts);                    // NO cap — record 3, 20, 50, 100…
    const n = st.strokes.length;
    st.testing = n >= 3;
    $('tr-msg').textContent = n < 3
      ? 'Recorded ' + n + ' of 3 minimum — draw it again.'
      : 'Recorded ' + n + ' sample' + (n === 1 ? '' : 's') +
        ' ✓ — keep drawing for better accuracy, or tap Done / Save.';
    trRedraw(); trProgress();
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
  window.addEventListener('resize', () => { if (trState && !$('train-modal').classList.contains('hidden')) { trSizeCanvas(); trRedraw(); } });
  // keyboard / visualViewport shrink (phone typebar open) strands canvas size — re-fit while open
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => { if (trState && !$('train-modal').classList.contains('hidden')) { trSizeCanvas(); trRedraw(); } });
  }
}

/* ------------------------------------------------ gesture TEST (R28.1) -----
 * 🧪 Test (chip beside ✋ Train) → #test-modal. SEPARATE from Train: draw the
 * shape ONCE and get a clear plain-language verdict — built-ins first (O / V /
 * n, exactly like the pad), then the nearest SAVED custom gesture, always with
 * the distance and what the gesture WOULD DO. Nothing is recorded or saved. */
let teState = null;    // { drawing: [] } while a test stroke is in progress

function openTestPanel() {
  teState = { drawing: null };
  $('te-out').textContent = 'Draw the shape once — the verdict appears here.';
  $('te-out').className = 'tr-testout';
  const modal = $('test-modal');
  modal.classList.remove('hidden');
  try {
    const box = modal.querySelector('.modal-box');
    if (box) box.scrollTop = 0;
  } catch (e) {}
  try { document.body.style.overflow = 'hidden'; } catch (e) {}
  teSizeCanvas();
  teRedraw();
}
function closeTestPanel() {
  $('test-modal').classList.add('hidden');
  try { document.body.style.overflow = ''; } catch (e) {}
  teState = null;
}

function teSizeCanvas() {
  const cv = $('te-canvas');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(120, cv.clientWidth || 640);
  const h = Math.max(120, cv.clientHeight || 220);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function teRedraw(live) {
  const cv = $('te-canvas');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.width / dpr, h = cv.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.strokeStyle = 'rgba(148,163,184,.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 6]);
  ctx.strokeRect(8, 8, w - 16, h - 16);
  ctx.restore();
  const pts = teState && teState.lastDrawn;
  if (pts && pts.length > 1) trStrokePath(ctx, pts, '#22d3ee', 4);
  if (live && live.length > 1) trStrokePath(ctx, live, '#e2e8f0', 4);
}

function teVerdict(text, cls) {
  const out = $('te-out');
  out.textContent = text;
  out.className = 'tr-testout te-' + (cls || 'no');
}

/* ONE drawing → clear yes/no + what it would do. Built-ins win first (same
 * order as the live pad: circle → V → notepad), then custom templates. */
function teEvaluate(pts) {
  const saved = customGestureList();
  // R28.2: SAME priority as the live pad — a trained shape is checked first,
  // because that is the gesture the user deliberately taught the app.
  if (saved.length) {
    const best = bestTemplateMatch(pts, saved);
    if (best && best.dist <= TR_THRESH) {
      teVerdict('✓ MATCH — saved gesture "' + best.name + '" → ' + actionTitle(best.action) +
        ' (distance ' + best.dist.toFixed(3) + ' ≤ ' + TR_THRESH + '). That is what would fire.', 'ok');
      return;
    }
  }
  if (recognizeCircle(pts)) {
    teVerdict('✓ MATCH — built-in "Circle (O)" → ' + actionTitle(gestureFor('circle')) +
      '. It would do that on the PC right now.', 'ok');
    return;
  }
  if (recognizeV(pts)) {
    teVerdict('✓ MATCH — built-in "Vee (V)" → ' + actionTitle(gestureFor('vee')) +
      '. It would do that on the PC right now.', 'ok');
    return;
  }
  if (recognizeNotepad(pts)) {
    teVerdict('✓ MATCH — built-in "Notepad (n)" → ' + actionTitle(gestureFor('notepad')) +
      '. It would do that on the PC right now.', 'ok');
    return;
  }
  if (!saved.length) {
    teVerdict('✗ NO MATCH — it is not O/V/n, and you have no saved gestures yet. Tap ✋ Train to teach it one.', 'no');
    return;
  }
  const best = bestTemplateMatch(pts, saved);
  if (best) {
    teVerdict('✗ NO MATCH — closest saved gesture is "' + best.name +
      '" but the distance is ' + best.dist.toFixed(3) + ' (needs ≤ ' + TR_THRESH +
      '), and it is not O/V/n. Draw it more like your training samples.', 'no');
  } else {
    teVerdict('✗ NO MATCH — not O/V/n and no usable saved gesture matched.', 'no');
  }
}

function setupTester() {
  const btn = $('btn-test');
  if (!btn) return;
  btn.addEventListener('click', openTestPanel);
  $('te-close').addEventListener('click', closeTestPanel);
  $('te-clear').addEventListener('click', () => {
    if (teState) teState.lastDrawn = null;
    teRedraw();
    teVerdict('Draw the shape once — the verdict appears here.');
  });
  $('test-modal').addEventListener('click', (e) => { if (e.target === $('test-modal')) closeTestPanel(); });
  window.addEventListener('resize', () => {
    if (teState && !$('test-modal').classList.contains('hidden')) { teSizeCanvas(); teRedraw(); }
  });
  // keyboard / visualViewport shrink (phone typebar open) strands canvas size — re-fit while open
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (teState && !$('test-modal').classList.contains('hidden')) { teSizeCanvas(); teRedraw(); }
    });
  }

  const cv = $('te-canvas');
  let drawing = null;
  const pos = (e) => {
    const r = cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  cv.addEventListener('pointerdown', (e) => {
    if (!teState) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    drawing = [pos(e)];
    teRedraw(drawing);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    drawing.push(pos(e));
    teRedraw(drawing);
  });
  const finish = (e) => {
    if (!drawing || !teState) return;
    e.preventDefault();
    const pts = drawing;
    drawing = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
    if (!trValidStroke(pts)) {
      teRedraw();
      teVerdict('Too small — draw a bigger shape, then lift.');
      return;
    }
    teState.lastDrawn = pts;
    teRedraw();
    teEvaluate(pts);
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);
}

function renderRailPane() {
  const host = $('cz-rail');
  host.innerHTML = '';
  const groups = [
    ['Major row (above trackpad)', 'majorRow'],
    ['Pad buttons (below major row)', 'padButtons'],
  ];
  for (const [gtitle, gkey] of groups) {
    const h = document.createElement('h4');
    h.textContent = gtitle;
    host.appendChild(h);
    const list = state.profile[gkey];
    list.forEach((slot) => {
      const row = document.createElement('div');
      row.className = 'cz-row';
      const lab = document.createElement('input');
      lab.className = 'cz-input cz-lab';
      lab.placeholder = 'Label';
      lab.value = slot.label || '';
      lab.addEventListener('input', () => { slot.label = lab.value; persistProfile(); });
      row.appendChild(lab);
      row.appendChild(makeActionEditor(slot.action, (a) => { slot.action = a; persistProfile(); }));
      host.appendChild(row);
    });
  }
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Key combos are space-separated names:  ctrl s  ·  ctrl alt delete  ·  shift f5';
  host.appendChild(note);
}

function renderArrowsPane() {
  // R13.1: "absolute" customization — the arrow cluster AND the flanking hold
  // column are fully remappable (label + action), same as the rail/bank.
  const host = $('cz-arrows');
  host.innerHTML = '';
  const groups = [
    ['Arrow cluster (← → ↑ ↓ · DEL ⌫ SPC ⏎ · V · Z) — every key remappable', 'arrows'],
    ['Hold buttons flanking the trackpad (L R hold · M autoscroll)', 'holds'],
  ];
  for (const [gtitle, gkey] of groups) {
    const h = document.createElement('h4');
    h.textContent = gtitle;
    host.appendChild(h);
    (state.profile[gkey] || []).forEach((slot) => {
      const row = document.createElement('div');
      row.className = 'cz-row';
      const lab = document.createElement('input');
      lab.className = 'cz-input cz-lab';
      lab.placeholder = 'Label';
      lab.value = slot.label || '';
      lab.addEventListener('input', () => { slot.label = lab.value; persistProfile(); renderAll(); });
      row.appendChild(lab);
      row.appendChild(makeActionEditor(slot.action, (a) => { slot.action = a; persistProfile(); renderAll(); }));
      host.appendChild(row);
    });
  }
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Any slot can hold a key combo, click, scroll, text, drag toggle, or a hold-button action. Combos are space-separated:  ctrl s  ·  ctrl alt delete  ·  shift f5';
  host.appendChild(note);
}

function renderBankPane() {
  const host = $('cz-bank');
  host.innerHTML = '';
  const bank = state.profile.bank || (state.profile.bank = []);
  if (!bank.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No sections yet — add one below.';
    host.appendChild(p);
  }
  bank.forEach((sec, si) => {
    const box = document.createElement('div');
    box.className = 'bank-sec';
    const head = document.createElement('div');
    head.className = 'bank-sec-head';
    const nameInput = document.createElement('input');
    nameInput.className = 'cz-input';
    nameInput.placeholder = 'Section name';
    nameInput.value = sec.name || '';
    nameInput.addEventListener('input', () => { sec.name = nameInput.value; persistProfile(); });
    const delSec = document.createElement('button');
    delSec.className = 'chip danger';
    delSec.textContent = '✕';
    delSec.title = 'Delete section';
    delSec.addEventListener('click', () => { bank.splice(si, 1); persistProfile(); renderBankPane(); });
    head.appendChild(nameInput);
    head.appendChild(delSec);
    box.appendChild(head);

    (sec.buttons || []).forEach((btn, bi) => {
      const row = document.createElement('div');
      row.className = 'cz-row';
      const lab = document.createElement('input');
      lab.className = 'cz-input cz-lab';
      lab.placeholder = 'Label';
      lab.value = btn.label || '';
      lab.addEventListener('input', () => { btn.label = lab.value; persistProfile(); });
      const delB = document.createElement('button');
      delB.className = 'chip danger';
      delB.textContent = '✕';
      delB.title = 'Delete button';
      delB.addEventListener('click', () => { sec.buttons.splice(bi, 1); persistProfile(); renderBankPane(); });
      row.appendChild(lab);
      row.appendChild(makeActionEditor(btn.action, (a) => { btn.action = a; persistProfile(); }));
      row.appendChild(delB);
      box.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.className = 'chip';
    addBtn.textContent = '＋ button';
    addBtn.addEventListener('click', () => {
      (sec.buttons = sec.buttons || []).push({ label: 'New', action: { keys: ['enter'] } });
      persistProfile(); renderBankPane();
    });
    box.appendChild(addBtn);
    host.appendChild(box);
  });

  const row = document.createElement('div');
  row.className = 'cz-foot-btns';
  const addSec = document.createElement('button');
  addSec.className = 'chip primary';
  addSec.textContent = '＋ section';
  addSec.addEventListener('click', () => {
    state.profile.bank.push({ name: 'New section', buttons: [{ label: 'New', action: { keys: ['enter'] } }] });
    persistProfile(); renderBankPane();
  });
  // R13.6: "Restore defaults" brings back ANY of the predefined sections
  // (buttons.json + Editing + Clipboard) that were accidentally ✕-ed — it only
  // adds what's missing, never removes your custom sections.
  const reset = document.createElement('button');
  reset.className = 'chip';
  reset.textContent = 'Restore defaults';
  reset.title = 'Re-add any predefined section (Editing / Clipboard / buttons.json) that was deleted';
  reset.addEventListener('click', async () => {
    try {
      if (!JSON_SECTIONS) {
        const r = await fetch('buttons.json', { cache: 'no-store' });
        JSON_SECTIONS = (await r.json()).sections || [];
      }
    } catch (e) { /* keep going with what we have */ }
    state.profile.bank = ensureDefaultSections(state.profile.bank);
    persistProfile(); renderBankPane();
  });
  row.appendChild(addSec);
  row.appendChild(reset);
  host.appendChild(row);
}

function renderProfilesPane() {
  const host = $('cz-profiles');
  host.innerHTML = '';
  const h = document.createElement('h4');
  h.textContent = 'Profiles — auto-saved on this tablet, exportable as .json';
  host.appendChild(h);

  const nameRow = document.createElement('div');
  nameRow.className = 'cz-row';
  const nameInput = document.createElement('input');
  nameInput.className = 'cz-input';
  nameInput.placeholder = 'Profile name';
  nameInput.value = state.profile.name;
  nameRow.appendChild(nameInput);
  const save = document.createElement('button');
  save.className = 'chip primary';
  save.textContent = 'Save';
  save.addEventListener('click', () => {
    const nn = nameInput.value.trim() || 'Profile';
    if (nn !== state.profile.name) {
      delete state.profiles[state.profile.name];
      state.profile.name = nn;
      persistProfile();
    }
    renderProfilesPane();
  });
  nameRow.appendChild(save);
  const saveAs = document.createElement('button');
  saveAs.className = 'chip';
  saveAs.textContent = 'Save as new';
  saveAs.addEventListener('click', () => {
    const nn = (nameInput.value.trim() || 'Profile') + ' copy';
    const copy = JSON.parse(JSON.stringify(state.profile));
    copy.name = nn;
    state.profiles[nn] = copy;
    state.activeName = nn; state.profile = copy;
    persistProfile(); renderProfilesPane();
  });
  nameRow.appendChild(saveAs);
  host.appendChild(nameRow);

  const list = document.createElement('div');
  list.className = 'prof-list';
  for (const name of Object.keys(state.profiles).sort()) {
    const row = document.createElement('div');
    row.className = 'prof-row' + (name === state.activeName ? ' on' : '');
    const lab = document.createElement('span');
    lab.textContent = name + (name === state.activeName ? '  ← active' : '');
    const load = document.createElement('button');
    load.className = 'chip';
    load.textContent = 'Load';
    load.addEventListener('click', () => { activateProfile(name); renderProfilesPane(); });
    const del = document.createElement('button');
    del.className = 'chip danger';
    del.textContent = '✕';
    del.title = 'Delete profile';
    del.addEventListener('click', () => {
      delete state.profiles[name];
      if (state.activeName === name) {
        state.activeName = 'Default';
        if (!state.profiles.Default) state.profiles.Default = defaultProfile('Default');
        state.profile = state.profiles.Default;
      }
      localStorage.setItem('rc_profiles', JSON.stringify(state.profiles));
      persistProfile(); renderProfilesPane();
    });
    row.appendChild(lab);
    row.appendChild(load);
    row.appendChild(del);
    list.appendChild(row);
  }
  host.appendChild(list);

  const io = document.createElement('div');
  io.className = 'cz-foot-btns';
  const exp = document.createElement('button');
  exp.className = 'chip';
  exp.textContent = '⬇ Export current profile (.json)';
  exp.addEventListener('click', exportProfile);
  const imp = document.createElement('button');
  imp.className = 'chip';
  imp.textContent = '⬆ Import profile (.json)';
  imp.addEventListener('click', () => $('cz-import').click());
  io.appendChild(exp);
  io.appendChild(imp);
  const file = document.createElement('input');
  file.type = 'file';
  file.id = 'cz-import';
  file.accept = 'application/json,.json';
  file.hidden = true;
  file.addEventListener('change', importProfile);
  io.appendChild(file);
  host.appendChild(io);
}

function exportProfile() {
  const blob = new Blob([JSON.stringify(state.profile, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rc-profile-' + (state.profile.name || 'profile').replace(/[^\w-]+/g, '-') + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importProfile(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(reader.result);
      if (!p || typeof p !== 'object') throw new Error('not a JSON profile');
      const name = p.name || 'Imported';
      const clean = {
        name,
        gestures: Object.assign(JSON.parse(JSON.stringify(DEFAULT_GESTURES)), p.gestures || {}),
        majorRow: Array.isArray(p.majorRow) ? p.majorRow : defaultMajorRow(),
        padButtons: Array.isArray(p.padButtons) ? p.padButtons : defaultPadButtons(),
        arrows: Array.isArray(p.arrows) && p.arrows.length ? p.arrows : defaultArrows(),
        holds: Array.isArray(p.holds) && p.holds.length ? p.holds : defaultHolds(),
        bank: Array.isArray(p.bank) ? p.bank : [],
      };
      state.profiles[name] = clean;
      state.activeName = name;
      state.profile = clean;
      persistProfile();
      renderProfilesPane();
      renderAll();
    } catch (e) {
      alert('Could not import profile: ' + e.message);
    }
  };
  reader.readAsText(f);
}

/* ------------------------------------------------------ guided tour ------- */
const TOUR = [
  {
    sel: '#trackpad',
    title: 'Trackpad — this is your mouse',
    text: 'Drag your finger to move the cursor. Tap = left click · 2-finger tap = right click · 3-finger tap = middle click · 2-finger slide = scroll · TWO-finger pinch (spread = zoom in, squeeze = zoom out — works in any app, e.g. a video-editor timeline) · press & hold still = drag. Two little circles sit on the pad\'s right edge: the ↕ at MIDDLE-right toggles SCROLL MODE (drag = mouse wheel), and the ◯ at TOP-right toggles GESTURE MODE (draw an O, a V or an n and it fires your gesture WITHOUT moving the cursor — nothing gets hovered/triggered in the app). In PORTRAIT the pad now spans the FULL width — its left edge reaches the screen\'s left edge, so two-finger gestures work anywhere on the pad; the button bank scrolls behind it.',
  },
  {
    sel: '#hotkeys',
    title: 'Editing hotkeys (top-right strip)',
    text: 'A strip of editing shortcuts at the TOP of the right side, for DaVinci Resolve & more. The small tabs switch categories — Play · Edit · Clip · Pages (switch Resolve pages: Media/Cut/Edit/Fusion/Color/Fairlight/Deliver + Project settings) · Trim (Trim L/R, Split, Ripple delete, Hide/Show, Bookmark). Each tab shows its keys as compact tiles, TWO per column (scroll sideways for more). The 🔍 box above searches every hotkey AND every left-side button together — type "chroma", "trim", "bookmark" or "resolution" and it finds them. The ✎ on any tile/button edits its keywords so you can find it by YOUR names (e.g. "alight motion", "capcut").',
  },
  {
    sel: '#hold-col',
    title: 'Hold L · M · R (beside the pad)',
    text: 'The hold column flanks the trackpad — on its RIGHT edge in portrait. Six buttons: L / R tap to HOLD that mouse button (drag files / context menus), tap again to release; M toggles AUTOSCROLL (tap it, move up or down on the pad, and it keeps scrolling by itself — tap M or the pad to stop); DOUBLE-TAP M instead for PAN MODE (the button glows GREEN — the middle mouse button is held, so dragging the pad moves a zoomed preview around, e.g. DaVinci Resolve; any tap on M releases it); then SPC (play/pause), ⏎ (confirm) and ⌫ (backspace) send a real keypress for editing. All six are remappable in ⚙ Customize → Arrows & holds.',
  },
  {
    sel: '#senswrap',
    title: 'Sensitivity + precision',
    text: 'The Sens slider sets cursor speed — out of the box it sits at the MAX (150%, the fastest); drag it down to slow the cursor, or keep it cranked for fast flicks. The round ◈ button turns on precision mode: slow, fine-grained movement for detailed adjustments.',
  },
  {
    sel: '#arrowrow',
    title: 'Arrows · V · Z · Vol · CTRL',
    text: 'Real-keyboard arrows in an inverted T. DEL and Z form the left column — tap CTRL (right of →) then Z for Ctrl+Z (Undo). V (your Vibe shortcut — Ctrl+Alt+S) sits right of Vol+. Vol+ / Vol- (above → and ←) step the PC volume and HOLD TO REPEAT. CTRL (right of →) is a toggle modifier. R13.6: SPC/⏎/⌫ moved OUT into the hold column beside the trackpad. R13.8: DG left the cluster — it lives in the mod row now, left of M. Every key is remappable in ⚙ Customize → Arrows & holds.',
  },
  {
    sel: '#modrow, #majorrow, #padbtns',
    title: 'Buttons (above the trackpad)',
    text: 'Two clean rows (same in both orientations): the top major row is ESC · TAB · WIN · ALT · L, the mod row below is DG · M · SHIFT · Z · R. ALT and SHIFT are toggles — tap ALT then a letter → Alt+letter. M = middle click, R = right click, Z types z. DG (left of M) toggles drag. CTRL lives in the arrow cluster (right of →). Scrolling lives in the pad\'s scroll dial.',
  },
  {
    sel: '#bank',
    title: 'Custom buttons (left side)',
    text: 'Your shortcut buttons — scroll down for more. Add, edit and delete them in ⚙ Customize.',
  },
  {
    sel: '#typeInput',
    title: 'Type using your own keyboard',
    text: 'Tap here and your Android keyboard (Gboard etc.) opens. "⌨ Live" types instantly on the PC as you type. Switch to "💬 Send" to compose first, then press Send.',
  },
  {
    sel: '#btn-customize',
    title: 'Customize & save',
    text: 'Remap gestures, rail buttons and the button bank. Everything auto-saves as a profile — export as a .json file to keep or share it.',
  },
  {
    sel: '#btn-release',
    title: 'Release all',
    text: 'If a key ever feels stuck on the PC, tap this — it lets go of every key and mouse button.',
  },
];
let tourIdx = 0;

/* searchable guide — type in the box inside the ? tour to look up any button */
const BUTTON_GUIDE = [
  { k: 'trackpad touchpad', d: 'Drag to move the cursor. Tap = left click · 2-finger tap = right click · 3-finger tap = Windows key (Start) · 4-finger tap = notifications · 3-finger swipe = Task View (up) / desktop (down) / switch apps (left-right) · 2-finger slide = scroll · two-finger PINCH (spread = zoom in, squeeze = zoom out, in any app — Zoom slider sets the punch) · press & hold = drag. Two circles on the pad\'s right edge: ↕ (middle) = scroll mode, ◯ (top) = gesture mode.' },
  { k: 'scroll dial wheel scroll mode scroll', d: 'The round ↕ circle at the pad\'s MIDDLE-RIGHT edge toggles SCROLL MODE — the old ▲▼ chips are gone. While it is on, dragging anywhere on the pad scrolls like a mouse wheel (finger down = scroll down); tap ↕ again to move the cursor normally.' },
  { k: 'gesture mode circle gesture o dial gesture-dial', d: 'R13.7: the round ◯ circle at the pad\'s TOP-RIGHT edge toggles GESTURE MODE. While it is on, the pad captures one-finger shapes and fires them on lift WITHOUT moving the cursor — so nothing in your app gets hovered/triggered while you draw. Draw an O (circle) → the circle gesture fires (default Ctrl+I — your Import shortcut); draw a V (letter V — down, then up) → the V gesture fires (default Ctrl+Alt+S — your Vibe shortcut); draw an n (letter n — tall, two arches) → the notepad gesture fires (default: launch a new Notepad window on the PC). Tap ◯ again to move the cursor normally. Exclusive with scroll mode / autoscroll.' },
  { k: 'left hold click-and-hold l', d: 'The L button in the hold column beside the trackpad (right edge in portrait): tap to HOLD the left mouse button down (grab & drag files anywhere), tap again to release. Remappable in ⚙ → Arrows & holds.' },
  { k: 'middle hold click-and-hold m autoscroll scroll', d: 'The M button — 2nd in the hold column beside the trackpad: tap it to start AUTOSCROLL (it also sends a real middle click). Then move your finger up or down on the pad and it keeps scrolling by itself in that direction, like a mouse dial — center the finger to pause, tap M or the pad again to stop.' },
  { k: 'pan preview move around davinci resolve', d: 'DOUBLE-TAP M (the hold column, 2nd button) = PAN MODE — the button glows GREEN and the middle mouse button is held, like pressing the physical scroll-dial button. Now drag the pad to MOVE A ZOOMED PREVIEW AROUND (DaVinci Resolve: zoom in with the scroll dial, then pan). Any tap on M releases. Single tap M stays autoscroll.' },
  { k: 'right hold click-and-hold r', d: 'The R button in the hold column beside the trackpad (right edge in portrait): tap to HOLD the right mouse button down, tap again to release. Remappable in ⚙ → Arrows & holds.' },
  { k: 'l m r quick click middle right', d: 'Quick clicks: L (left click) at the far right of the major row, M (middle click) and R (right click) flanking SHIFT in the mod row below — DG · M · SHIFT · Z · R.' },
  { k: 'ctrl shift alt win modifier windows', d: 'Modifier toggles — tap one, then a letter → that shortcut (Ctrl+C…); tap again to release. ALT (major row), SHIFT (mod row DG·M·SHIFT·Z·R), CTRL (arrow cluster, right of →), WIN (major row).' },
  { k: 'esc tab win enter spc space backspace delete del', d: 'Major row: ESC · TAB · WIN · ALT · L. SPC / ⏎ / ⌫ moved OUT into the hold column beside the trackpad (L·M·R · SPC·⏎·⌫) — DEL stays far-left in the arrow cluster, V sits right of Vol+.' },
  { k: 'volume vol up down', d: 'Vol+ and Vol- (arrow cluster, directly ABOVE → and ←) step the PC system volume, and HOLD TO REPEAT — hold and it keeps stepping, like a physical volume key.' },
  { k: 'v vibe ctrl alt s', d: 'The V button — right of Vol+ (top-right of the arrow cluster) — sends Ctrl+Alt+S on the PC: your Vibe software shortcut. You can also draw a V on the pad in gesture mode (◯ dial) to fire the same Ctrl+Alt+S.' },
  { k: 'notepad n letter launch new note', d: 'Draw the LETTER n — a tall, open, elongated two-arch stroke (up-down-up-down), horizontal or vertical — on the pad in gesture mode (◯ dial) to fire the notepad gesture (default: launch a new Notepad window on the PC). It must be open-ended with 4+ bends, so a straight drag or a V never triggers it.' },
  { k: 'enter return', d: 'Enter ⏎ — the 5th hold-column button beside the trackpad (below M): sends Enter on the PC (confirm, play/pause in Resolve).' },
  { k: 'backspace delete', d: 'Backspace ⌫ — the 6th hold-column button beside the trackpad (bottom): sends Backspace. DEL stays in the arrow cluster far-left.' },
  { k: 'arrows up down left right', d: 'Real-keyboard arrow keys (inverted T in the arrow cluster). R13: every arrow key is remappable — ⚙ Customize → Arrows & holds.' },
  { k: 'scroll up down arrows', d: 'Scrolling lives in the pad\'s ↕ scroll dial (middle-right edge of the trackpad). Toggle it on, then drag to scroll. Its speed follows the Sens slider — higher sens = faster wheel.' },
  { k: 'dg drag', d: 'The DG button in the mod row, LEFT of M, toggles drag: tap once to keep the left button held while you move the cursor, tap again to release.' },
  { k: 'z ctrl z undo', d: 'Two Z keys now: the mod row Z (right of SHIFT) types the letter z — tap ALT / SHIFT / CTRL then it for shortcuts. The arrow cluster Z (bottom-left, under DEL — DG\'s old spot) does the same: tap CTRL (right of →) then Z for Ctrl+Z (Undo in DaVinci Resolve).' },
  { k: 'sensitivity sens slider speed', d: 'The Sens slider (above the trackpad) sets cursor speed. R13: out of the box it sits at the MAX (150%, the fastest) and the range was extended above the old 100 cap; drag down to slow the cursor. R13.6: it ALSO scales the ↕ scroll-dial wheel — high sens = fast scroll, low sens = slow. R27: the Zoom slider beside it sets pinch punch (0% = gentle 1-notch steps like before, 100% = 3 notches, 200% = 5 notches) and is remembered across reloads. Precision ◈ handles fine, slow work.' },
  { k: 'precision fine detailed', d: 'The round ◈ button before "Sens" turns on precision mode — the cursor moves slowly for fine, detailed adjustments. Tap again to switch back.' },
  { k: 'button bank custom buttons', d: 'The whole left panel is your shortcut bank — scroll for more. Edit them in ⚙ Customize.' },
  { k: 'type text keyboard gboard', d: 'Bottom bar: tap the box and your Android keyboard opens. ⌨ Live types instantly, 💬 Send composes first, ⏎ adds Enter, ✕ clears.' },
  { k: 'release all', d: 'Release all lets go of every key and mouse button on the PC if something feels stuck.' },
  { k: 'customize profile gestures', d: '⚙ Customize: remap gestures, rail buttons and the bank; save profiles and export/import .json.' },
  { k: 'pinch zoom in out spread squeeze two finger timeline', d: 'R14: put TWO fingers on the pad and spread them apart = zoom IN, squeeze them together = zoom OUT — sent as Ctrl+wheel, so it works in every app (browser, editor, video timeline). Needs ~54px of separation change before anything fires, so normal 2-finger scrolls never zoom by accident. R27: the Zoom slider (next to Sens) sets how much zoom each step gives — turn it up if zoom feels weak. Also works in the / full-screen touch mode.' },
  { k: 'pin password', d: 'If the PC asks for a PIN, it is set in config.json on the PC.' },
];

function onTourSearch() {
  const q = $('tour-search').value.trim().toLowerCase();
  const res = $('tour-results');
  const step = $('tour-step');
  const ctl = $('tour-controls');
  if (!q) { clearTourSearch(); return; }
  res.classList.remove('hidden');
  step.classList.add('hidden');
  ctl.classList.add('hidden');
  const hits = BUTTON_GUIDE.filter((g) => (g.k + ' ' + g.d).toLowerCase().includes(q));
  res.innerHTML = hits.length
    ? hits.map((g) => '<div class="tr-item"><b>' + g.k.split(' ')[0] + '</b><div class="tr-desc">' + g.d + '</div></div>').join('')
    : '<div class="tr-none">No match for "' + $('tour-search').value + '"</div>';
  layoutTour();  // bubble grew/shrunk — re-aim the connector
}
function clearTourSearch() {
  $('tour-search').value = '';
  $('tour-results').classList.add('hidden');
  $('tour-step').classList.remove('hidden');
  $('tour-controls').classList.remove('hidden');
  layoutTour();
}

function rectUnion(sel) {
  let rect = null;
  document.querySelectorAll(sel).forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    rect = rect ? {
      left: Math.min(rect.left, r.left), top: Math.min(rect.top, r.top),
      right: Math.max(rect.right, r.right), bottom: Math.max(rect.bottom, r.bottom),
    } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  return rect;
}

function openTour() {
  if (!$('customize-modal').classList.contains('hidden')) closeCustomize();
  tourIdx = 0;
  clearTourSearch();
  $('tour').classList.remove('hidden');
  renderTour();
}
function closeTour() { $('tour').classList.add('hidden'); }
function tourNext() { if (tourIdx < TOUR.length - 1) { tourIdx++; renderTour(); } else closeTour(); }
function tourPrev() { if (tourIdx > 0) { tourIdx--; renderTour(); } }

function layoutTour() {
  const step = TOUR[tourIdx];
  const spot = $('tour-spot');
  const bubble = $('tour-bubble');
  const rect = rectUnion(step.sel);
  if (!rect) { spot.style.display = 'none'; $('tour-conn').innerHTML = ''; return; }
  const pad = 8;
  spot.style.display = 'block';
  spot.style.left = (rect.left - pad) + 'px';
  spot.style.top = (rect.top - pad) + 'px';
  spot.style.width = (rect.right - rect.left + pad * 2) + 'px';
  spot.style.height = (rect.bottom - rect.top + pad * 2) + 'px';

  // Place the bubble clear of the highlighted element — never overlapping it —
  // and draw a dashed connector line from the bubble into the highlight.
  const bh = bubble.offsetHeight || 150;
  const bw = bubble.offsetWidth || 480;
  const GAP = 16, M = 8;
  const cx = rect.left + (rect.right - rect.left) / 2;
  const cy = rect.top + (rect.bottom - rect.top) / 2;
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let bx, by, side;
  if (rect.top - GAP - bh >= M)                          { side = 'top';    bx = cl(cx - bw / 2, M, innerWidth - bw - M); by = rect.top - GAP - bh; }
  else if (rect.bottom + GAP + bh <= innerHeight - M)    { side = 'bottom'; bx = cl(cx - bw / 2, M, innerWidth - bw - M); by = rect.bottom + GAP; }
  else if (rect.left - GAP - bw >= M)                    { side = 'left';   bx = rect.left - GAP - bw; by = cl(cy - bh / 2, M, innerHeight - bh - M); }
  else if (rect.right + GAP + bw <= innerWidth - M)      { side = 'right';  bx = rect.right + GAP; by = cl(cy - bh / 2, M, innerHeight - bh - M); }
  else { side = 'none'; bx = cl(cx - bw / 2, M, innerWidth - bw - M); by = cl(cy - bh / 2, M, innerHeight - bh - M); }
  bubble.style.left = bx + 'px';
  bubble.style.top = by + 'px';

  const c = $('tour-conn');
  c.setAttribute('viewBox', `0 0 ${innerWidth} ${innerHeight}`);
  if (!side || side === 'none') { c.innerHTML = ''; return; }
  let p1, p2;
  if (side === 'top')         { p1 = { x: cl(cx, bx, bx + bw), y: by + bh }; p2 = { x: cx, y: rect.top }; }
  else if (side === 'bottom') { p1 = { x: cl(cx, bx, bx + bw), y: by };       p2 = { x: cx, y: rect.bottom }; }
  else if (side === 'left')   { p1 = { x: bx + bw, y: cl(cy, by, by + bh) };  p2 = { x: rect.left, y: cy }; }
  else                        { p1 = { x: bx,       y: cl(cy, by, by + bh) }; p2 = { x: rect.right, y: cy }; }
  c.innerHTML = `<line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${p2.x.toFixed(1)}" y2="${p2.y.toFixed(1)}"/>`;
}

function renderTour() {
  const step = TOUR[tourIdx];
  $('tour-title').textContent = step.title;
  $('tour-text').textContent = step.text;
  $('tour-progress').textContent = (tourIdx + 1) + ' / ' + TOUR.length;
  $('tourNext').textContent = tourIdx === TOUR.length - 1 ? 'Done ✓' : 'Next ›';
  $('tourPrev').disabled = tourIdx === 0;
  layoutTour();
}

/* -------------------------------------------------------------- misc ------ */
function setupUi() {
  // R13: the Sens slider reads 0–150 (the range was extended above the old 100
  // cap) and the DEFAULT is the MAX — out of the box it sits at 150% = 5.0×,
  // the fastest, because every earlier cap felt too slow. Drag down to slow it;
  // Precision ◈ is for slow, fine work.
  // R11: panel adjustments (sens + precision) persist in localStorage so a
  // refresh — including after an update — keeps the values the user set.
  const savedSens = localStorage.getItem('rc_sens');
  if (savedSens !== null) $('sens').value = savedSens;
  $('sens').addEventListener('input', (e) => {
    state.sens = 2 + (Number(e.target.value) / 100) * 2;
    $('sens-val').textContent = e.target.value + '%';
    localStorage.setItem('rc_sens', e.target.value);
  });
  state.sens = 2 + (Number($('sens').value) / 100) * 2;   // 0 → 2.0×, 150 → 5.0×
  $('sens-val').textContent = $('sens').value + '%';
  // R27: Zoom slider — same look/feel/persistence as Sens (rc_zoomsens in
  // localStorage, survives reload). 0% = 1 notch/step (the old feel),
  // 100% = 3 notches (default — noticeably punchier than today),
  // 200% = 5 notches. Wired beside Sens; the pinch loop reads it live.
  const zSens = $('zoom-sens'), zVal = $('zoom-sens-val');
  if (zSens) {
    const savedZoom = localStorage.getItem('rc_zoomsens');
    if (savedZoom !== null && savedZoom !== '' && isFinite(Number(savedZoom))) {
      zSens.value = Math.max(0, Math.min(200, Number(savedZoom)));
    }
    const applyZoom = () => {
      state.zoomSens = Number(zSens.value);
      if (zVal) zVal.textContent = zSens.value + '%';
      try { localStorage.setItem('rc_zoomsens', zSens.value); } catch (err) {}
    };
    zSens.addEventListener('input', applyZoom);
    applyZoom();
  }
  // R13.42c: the mobile strip's mini sens slider + ◈ mirror the real ones —
  // same state.sens / state.prec / localStorage, two-way synced.
  const mSens = $('m-sens'), mPrec = $('m-prec');
  if (mSens) {
    mSens.value = $('sens').value;
    mSens.addEventListener('input', (e) => {
      $('sens').value = e.target.value;
      $('sens').dispatchEvent(new Event('input'));
      mSens.value = e.target.value;
    });
    // main slider moves (e.g. on load) → mirror into the mini one
    $('sens').addEventListener('input', () => { if (mSens.value !== $('sens').value) mSens.value = $('sens').value; });
  }
  if (mPrec) {
    mPrec.classList.toggle('on', state.prec);
    mPrec.addEventListener('click', () => { $('prec').click(); mPrec.classList.toggle('on', state.prec); });
    // main ◈ toggled elsewhere → mirror
    new MutationObserver(() => mPrec.classList.toggle('on', $('prec').classList.contains('on')))
      .observe($('prec'), { attributes: true, attributeFilter: ['class'] });
  }

  // precision mode — the round ◈ before "Sens"
  if (localStorage.getItem('rc_prec') === '1') { state.prec = true; $('prec').classList.add('on'); }
  $('prec').addEventListener('click', () => {
    state.prec = !state.prec;
    $('prec').classList.toggle('on', state.prec);
    localStorage.setItem('rc_prec', state.prec ? '1' : '0');
    setStatus(state.prec ? 'Precision on — fine control' : 'Precision off', state.prec ? 'good' : '');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });

  // scroll-mode dial — the round ↕ circle at the pad's top-right edge. R13.31:
  // quick tap toggles scroll mode (then drag to scroll); HOLD it and the PC
  // scrolls continuously until you let go — the button works on its own too.
  wireScrollDial('scroll-dial');
  // R13.42c (mobile ≤450px): the one-thumb utility strip — sens on the LEFT,
  // ◯ · L · ↕ · R on its RIGHT, above the pad. Real buttons, same actions.
  wireMobileStrip();

  // R13.7: gesture-mode dial — the round ◯ at the pad's top-right corner
  $('gesture-dial').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  $('gesture-dial').addEventListener('click', toggleGestureMode);

  // bkp2: the top button ROW on the pad — L · ↕ · R. The two pad-click buttons
  // send a real left/right click; pointerdown must NOT leak into the pad's
  // move/gesture machinery (same stopPropagation the dials use).
  $('btn-pad-left').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  $('btn-pad-left').addEventListener('click', () => {
    runAction({ click: 'left' });
    setStatus('Left click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  $('btn-pad-right').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  $('btn-pad-right').addEventListener('click', () => {
    runAction({ click: 'right' });
    setStatus('Right click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });

  // R13.26 (bkp2): the MIRRORED BOTTOM row (L · ↕ · R) — identical buttons,
  // identical actions, so either edge of the pad is comfortably reachable.
  // pointerdown is stopped the same way so it never leaks into the pad's
  // move/gesture machinery.
  $('btn-pad-left-b').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  $('btn-pad-left-b').addEventListener('click', () => {
    runAction({ click: 'left' });
    setStatus('Left click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  $('btn-pad-right-b').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  $('btn-pad-right-b').addEventListener('click', () => {
    runAction({ click: 'right' });
    setStatus('Right click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  $('scroll-dial-b').addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  wireScrollDial('scroll-dial-b');

  /* R13.42k: the panel splitter is wired HERE, directly — it used to be called
     only at the tail of syncMobileStrip(), so when the strip lookup missed the
     bar had zero listeners and dragging did nothing. Direct wiring + the
     dataset.wired guard = exactly one set of listeners, always. */
  wireBankSplitter();
  wireStreamSplitter();
}

/* --------------------------------- R13.42c mobile utility strip ----------- */
/* ≤450px phones get a REAL one-thumb strip: sens-slider on the LEFT, four action
 * buttons (◯ gesture · L left-click · ↕ scroll · R right-click) on its RIGHT,
 * sitting ABOVE the trackpad. Every button reuses the EXISTING action — the
 * strip calls the same toggleScrollMode/toggleGestureMode/runAction the pad-row
 * buttons call, so behavior (incl. the ↕ hold-to-scroll and ◯/↕ exclusivity) is
 * identical. The strip exists in the DOM at all widths but is display:none
 * unless the 450px media query shows it — tablet/desktop never see it.
 * State-mirror: the pad-row dials toggle `.on` on THEMSELVES
 * (toggleScrollMode/toggleGestureMode touch only their own ids), so after any
 * toggle we mirror `.on` onto the strip twins. */
function wireMobileStrip() {
  // R13.42k: the element is id="mutil" (index.html) — the old "mstrip" lookup
  // ALWAYS missed, so this whole function early-returned and (worse) the only
  // wireBankSplitter() call at its tail never ran. Accept both ids.
  const strip = $('mutil') || $('mstrip');
  if (!strip) return;
  const on = (id, fn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
    el.addEventListener('click', (e) => { e.preventDefault(); fn(); syncMobileStrip(); });
  };
  on('m-gesture', toggleGestureMode);
  on('m-left', () => {
    runAction({ click: 'left' });
    setStatus('Left click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  on('m-right', () => {
    runAction({ click: 'right' });
    setStatus('Right click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  wireScrollDial('m-scroll');
  const mScroll = document.getElementById('m-scroll');
  if (mScroll) mScroll.addEventListener('click', syncMobileStrip);
  // keep the twins in sync no matter which surface was tapped
  const _tglS = toggleScrollMode, _tglG = toggleGestureMode;
  toggleScrollMode = function () { _tglS(); syncMobileStrip(); };
  toggleGestureMode = function () { _tglG(); syncMobileStrip(); };
  syncMobileStrip();
}
function wireBankSplitter() {
  const bar = $('banksplit'), bank = $('bank'), layout = $('layout');
  if (!bar || !bank || !layout) return;
  // R13.42k: never double-wire (the stacked-boundary path may re-call this).
  if (bar.dataset.wired) return;
  bar.dataset.wired = '1';
  const KEY = 'rc_bankpx';
  // R13.42j: stacked = the bar is ACTUALLY visible (the ≤560px query shows it).
  // A width-only matchMedia can lie (zoom,quirks); the computed display is
  // ground truth — a hidden bar can never start a drag, so side-by-side
  // tablets are safe no matter what width they report.
  const stacked = () => window.getComputedStyle(bar).display !== 'none';
  const applySaved = () => {
    try {
      const v = Number(localStorage.getItem(KEY));
      if (stacked() && v > 0) {
        // clamp against the CURRENT viewport so a stale value can never
        // collapse a panel after rotation/resize
        const maxPx = Math.round(innerHeight * 0.7), minPx = 90;
        bank.style.maxHeight = Math.max(minPx, Math.min(maxPx, v)) + 'px';
      } else {
        bank.style.maxHeight = '';
      }
    } catch (e) { /* private mode — splitter just won't persist */ }
  };
  applySaved();
  window.addEventListener('resize', applySaved);
  let dragY = null, baseH = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (!stacked()) return;   // side-by-side on tablet — nothing to split
    e.stopPropagation(); e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    dragY = e.clientY; baseH = bank.getBoundingClientRect().height;
    bar.classList.add('on');
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragY === null || !stacked()) return;
    e.preventDefault();
    const maxPx = Math.round(innerHeight * 0.7), minPx = 90;
    const h = Math.max(minPx, Math.min(maxPx, Math.round(baseH + (e.clientY - dragY))));
    bank.style.maxHeight = h + 'px';
  });
  const end = (e) => {
    if (dragY === null) return;
    dragY = null;
    bar.classList.remove('on');
    try { localStorage.setItem(KEY, String(Math.round(bank.getBoundingClientRect().height))); } catch (err) {}
    sizeTrackpad();   // the rail's room changed — re-fit the pad
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => {   // double-tap = back to the default
    try { localStorage.removeItem(KEY); } catch (err) {}
    bank.style.maxHeight = '';
    sizeTrackpad();
  });
}
/* ------------------------- R13.42k stream splitter ------------------------ */
/* Second grab bar: between the PC-screen section and the content below, so the
 * stream stage height is as freely adjustable as the button panel. Mirrors
 * wireBankSplitter exactly: computed-display ground truth, continuous drag
 * (no snapping), localStorage persist (rc_streamhpx), double-tap reset.
 * The height goes on #stream-stage (the layout box) — NEVER #stream-img (the
 * zoom transform lives there) and NEVER #streambar (the toolbar would move).
 * The .fixed class switches the stage to a clipped box with a contained image
 * (see style.css); clearing it restores the aspect-driven default. Off-state
 * collapses to zero via the CSS gate (body.stream-on required to show). */
function wireStreamSplitter() {
  const bar = $('streamsplit'), stage = $('stream-stage'), sbar = $('streambar');
  if (!bar || !stage || !sbar) return;
  if (bar.dataset.wired) return;
  bar.dataset.wired = '1';
  const KEY = 'rc_streamhpx';
  // visible ONLY when stacked-mobile CSS shows the bar AND the stream is on
  const active = () => window.getComputedStyle(bar).display !== 'none'
    && !sbar.classList.contains('off');
  const clampH = (v) => Math.max(80, Math.min(Math.round(innerHeight * 0.5), Math.round(v)));
  const applySaved = () => {
    try {
      const v = Number(localStorage.getItem(KEY));
      if (active() && v > 0) {
        stage.style.height = clampH(v) + 'px';
        stage.classList.add('fixed');
      } else if (!v) {
        stage.style.height = '';
        stage.classList.remove('fixed');
      }
    } catch (e) { /* private mode — splitter just won't persist */ }
  };
  applySavedStreamH = applySaved;   // applyStream() re-applies after toggling
  window.addEventListener('resize', applySaved);
  let dragY = null, baseH = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (!active()) return;
    e.stopPropagation(); e.preventDefault();
    try { bar.setPointerCapture(e.pointerId); } catch (err) {}
    dragY = e.clientY; baseH = stage.getBoundingClientRect().height;
    bar.classList.add('on');
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragY === null || !active()) return;
    e.preventDefault();
    stage.style.height = clampH(baseH + (e.clientY - dragY)) + 'px';
    stage.classList.add('fixed');
  });
  const end = () => {
    if (dragY === null) return;
    dragY = null;
    bar.classList.remove('on');
    try { localStorage.setItem(KEY, String(Math.round(stage.getBoundingClientRect().height))); } catch (err) {}
    sizeTrackpad();   // the stream's room changed — re-fit the pad
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => {   // double-tap = back to the default
    try { localStorage.removeItem(KEY); } catch (err) {}
    stage.style.height = '';
    stage.classList.remove('fixed');
    sizeTrackpad();
  });
}
let applySavedStreamH = null;   // set by wireStreamSplitter; called by applyStream
function syncMobileStrip() {
  try {
    const g = document.getElementById('m-gesture'), s = document.getElementById('m-scroll');
    const gd = document.getElementById('gesture-dial'), sd = document.getElementById('scroll-dial');
    if (g && gd) g.classList.toggle('on', gd.classList.contains('on'));
    if (s && sd) s.classList.toggle('on', sd.classList.contains('on'));
  } catch (e) { /* strip hidden on tablet — never break the real toggles */ }

  // R13.26 (bkp2): SEARCH — the box on EACH side. They are SYNCED: typing in
  // either one filters BOTH the left bank and the right hotkey strip live, and
  // shows recently-used tools on top. Clearing either box restores the tabs.
  // R13.43: pass the box as source so the overlay anchors to the right side;
  // guard re-wiring (syncMobileStrip can re-run) with dataset.swired.
  const hkSearch = $('hk-search');
  if (hkSearch && !hkSearch.dataset.swired) {
    hkSearch.dataset.swired = '1';
    hkSearch.addEventListener('input', () => setSearch(hkSearch.value, hkSearch));
  }
  const bankSearch = $('bank-search');
  if (bankSearch && !bankSearch.dataset.swired) {
    bankSearch.dataset.swired = '1';
    bankSearch.addEventListener('input', () => setSearch(bankSearch.value, bankSearch));
  }
  // R13.43: overlay dismiss — ✕ button, tap-outside scrim, Escape key.
  const soClear = $('so-clear');
  if (soClear && !soClear.dataset.swired) {
    soClear.dataset.swired = '1';
    soClear.addEventListener('click', (e) => { e.preventDefault(); clearSearch(); });
  }
  const scrim = $('search-scrim');
  if (scrim && !scrim.dataset.swired) {
    scrim.dataset.swired = '1';
    scrim.addEventListener('pointerdown', () => { clearSearch(); if (document.activeElement) document.activeElement.blur(); });
  }
  if (!document.documentElement.dataset.soesc) {
    document.documentElement.dataset.soesc = '1';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && searchQuery && searchQuery.trim()) { clearSearch(); if (document.activeElement) document.activeElement.blur(); }
    });
  }
  // R13.44: search-row mode toggles — tap cycles off → this side → both → off.
  // Pin and edit are exclusive (arming one disarms the other). Persisted.
  const modeBtns = [['bank-pinmode', 'pin', 'bank'], ['hk-pinmode', 'pin', 'hk'],
    ['bank-editmode', 'edit', 'bank'], ['hk-editmode', 'edit', 'hk']];
  for (const [id, which, side] of modeBtns) {
    const el = document.getElementById(id);
    if (el && !el.dataset.mwired) {
      el.dataset.mwired = '1';
      el.addEventListener('click', (e) => { e.preventDefault(); cycleMode(which, side); });
    }
  }
  applyModes();

  // R: link mode — Wi‑Fi / Bluetooth are INDEPENDENT connections. The tiny
  // toggle in the topbar closes the old socket before opening a fresh one to
  // the other host, so the two links can never cross.
  const lmW = $('lm-wifi'), lmB = $('lm-bt');
  if (lmW && lmB) {
    lmW.addEventListener('click', () => setLinkMode('wifi'));
    lmB.addEventListener('click', () => setLinkMode('bt'));
    lmW.classList.toggle('on', state.linkMode !== 'bt');
    lmB.classList.toggle('on', state.linkMode === 'bt');
  }

  // R (right click) — far-right of the static mod row (DG · M · SHIFT · Z · R).
  // V / Z and the hold row are wired in their own render functions (R13).
  $('btn-rclick').addEventListener('click', () => {
    runAction({ click: 'right' });
    setStatus('Right click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });

  // R13.6/R13.8: the static mod row is DG · M · SHIFT · Z · R — DG (drag) and
  // M (middle click) get their own tap handlers; Z (a plain z keypress) and
  // SHIFT are data-key modifiers handled by setupKeys(). DG moved here from
  // the arrow cluster in R13.8; its old slot there is now a Z key (Ctrl+Z).
  $('btn-dg').addEventListener('click', () => { toggleDrag(); });
  $('btn-mclick').addEventListener('click', () => {
    runAction({ click: 'middle' });
    setStatus('Middle click sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });
  $('btn-z').addEventListener('click', () => {
    runAction({ keys: ['z'] });
    setStatus('Z sent', 'good');
    setTimeout(() => { if (state.connected) setStatus('Connected', 'good'); }, 2000);
  });

  $('btn-release').addEventListener('click', () => {
    send({ type: 'release_all' });
    state.toggledMods.clear();
    state.held.clear();
    state.drag = false;
    state.holdBtn = null;
    if (state.repeatTimer) { clearTimeout(state.repeatTimer); clearInterval(state.repeatTimer); state.repeatTimer = null; }
    if (state.autoScroll.on) {
      state.autoScroll.on = false;
      if (state.autoScroll.timer) { clearInterval(state.autoScroll.timer); state.autoScroll.timer = null; }
      state.autoScroll.dir = 0;
    }
    if (state.panMode.on) {
      state.panMode.on = false;
      const panBtn = document.querySelector('#hold-col [data-hold="holdM"]');
      if (panBtn) panBtn.classList.remove('pan');
    }
    if (state.dragBtn) state.dragBtn.classList.remove('on');
    document.querySelectorAll('.key.on').forEach((k) => k.classList.remove('on'));
    document.querySelectorAll('#hold-col .hold.on').forEach((b) => b.classList.remove('on'));
    updateTpHint();
  });

  $('btn-help').addEventListener('click', openTour);
  $('tourNext').addEventListener('click', tourNext);
  $('tourPrev').addEventListener('click', tourPrev);
  $('tourDone').addEventListener('click', closeTour);
  $('tour-search').addEventListener('input', onTourSearch);
  $('tour-search').addEventListener('keydown', (e) => { if (e.key === 'Escape') clearTourSearch(); });
  window.addEventListener('resize', () => { if (!$('tour').classList.contains('hidden')) renderTour(); });

  // R13.6: the rows are orientation-independent now, but the pad/stream still
  // re-layout on rotation (pad 4:5 vs 5:4, stream strip is portrait-only)
  window.matchMedia('(max-aspect-ratio: 3/4)').addEventListener('change', () => {
    renderMajorRow();
    applyStream();   // stream strip is portrait-only — start/stop on rotation
    sizeTrackpad();
  });
  // R13.42d/j: crossing the stacked-mobile boundary re-runs the pad layout so
  // the strip/in-pad rows swap cleanly (DevTools drag-resize, fold/unfold,
  // split). Same stacked gate as the CSS — side-by-side tablets never fire it.
  window.matchMedia('(max-width: 450px) and (max-aspect-ratio: 3/4)').addEventListener('change', () => {
    syncMobileStrip();
    sizeTrackpad();
  });

  /* R13.42k: splitters are wired directly in setupUi — nothing to do here.
     (The old wireBankSplitter() call lived here; it moved so a strip/toggle
     re-run can never even reach splitter wiring.) */

  $('btn-customize').addEventListener('click', openCustomize);
  $('czClose').addEventListener('click', closeCustomize);

  $('pinOk').addEventListener('click', () => {
    state.pin = $('pinInput').value.trim();
    localStorage.setItem('rc_pin', state.pin);
    $('pin-modal').classList.add('hidden');
    try { state.ws.close(); } catch (e) {}
    connect();
  });
}
function showPinModal() {
  $('pin-modal').classList.remove('hidden');
  setTimeout(() => $('pinInput').focus(), 50);
}

function showPcBanner(info) {
  const ips = info.ips || [];
  const div = document.createElement('div');
  div.id = 'pc-banner';
  let html = '<b>Open this on your tablet (same Wi-Fi):</b>&nbsp; ';
  html += ips.length
    ? ips.map((ip) => `<code>http://${ip}:${info.http_port}</code>`).join(' &nbsp; ')
    : '<span>no LAN IP detected</span>';
  if (ips[0]) {
    const url = `http://${ips[0]}:${info.http_port}`;
    html += `<span class="qrbox"><img src="api/qr?url=${encodeURIComponent(url)}" alt="QR"></span>`;
  }
  div.innerHTML = html;
  document.body.prepend(div);
}

/* --------------------------------------------------- push-update (R28.1) ---
 * Offline-safe update check: the page knows its own version (the local VERSION
 * file, falling back to APP_VERSION below) and fetches a small plain-text
 * VERSION file hosted online. If the remote version is newer, a dismissible
 * banner offers Refresh. EVERY failure (offline, blocked, file://, 404) is
 * swallowed — the check can never break the app.
 *
 * WHERE THE HOSTED VERSION FILE LIVES:
 *   Host the SAME web/VERSION file at any PUBLIC static URL — e.g. GitHub raw
 *   (https://raw.githubusercontent.com/USER/REPO/main/web/VERSION), a static
 *   host, or a LAN web server. Format: first non-comment line = the version
 *   (e.g. "2.15"); lines starting with # are comments. Put that URL in
 *   REMOTE_VERSION_URL below, or override per device with
 *   localStorage.rc_update_url = 'https://…/VERSION'. Bump the local VERSION
 *   file whenever you ship, or the check will never fire. */
const APP_VERSION = '2.15';
const REMOTE_VERSION_URL = '';   // ← set to the public URL of the hosted VERSION file

function parseVersion(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] === '#') continue;
    const m = /^v?(\d+(?:\.\d+)*)/.exec(t);
    if (m) return m[1];
  }
  return null;
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
function fetchText(url, ms) {
  const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = setTimeout(() => { try { if (ctl) ctl.abort(); } catch (e) {} }, ms || 4000);
  return fetch(url, ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' })
    .then((r) => { clearTimeout(timer); return r.ok ? r.text() : null; })
    .catch(() => { clearTimeout(timer); return null; });
}
function showUpdateBanner(local, remote) {
  if ($('update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  const txt = document.createElement('span');
  txt.textContent = '⬆ Update available: v' + remote + ' (you have v' + local + ')';
  const act = document.createElement('button');
  act.className = 'chip primary';
  act.textContent = 'Refresh';
  act.addEventListener('click', () => location.reload());
  const no = document.createElement('button');
  no.className = 'chip';
  no.textContent = '✕';
  no.title = 'Dismiss — you will be re-notified only when an even newer version appears';
  no.addEventListener('click', () => { try { localStorage.setItem('rc_update_seen', remote); } catch (e) {} el.remove(); });
  el.appendChild(txt);
  el.appendChild(act);
  el.appendChild(no);
  document.body.appendChild(el);
}
async function checkForUpdate() {
  try {
    let url = REMOTE_VERSION_URL;
    try { url = localStorage.getItem('rc_update_url') || url; } catch (e) {}
    if (!url) return;
    const [localTxt, remoteTxt] = await Promise.all([fetchText('VERSION', 3000), fetchText(url, 5000)]);
    const local = parseVersion(localTxt) || APP_VERSION;
    const remote = parseVersion(remoteTxt);
    if (!remote || cmpVersion(remote, local) <= 0) return;
    let seen = '';
    try { seen = localStorage.getItem('rc_update_seen') || ''; } catch (e) {}
    if (seen === remote) return;
    showUpdateBanner(local, remote);
  } catch (e) { /* offline / blocked — never break the app */ }
}

/* ------------------------------------------------------------- boot ------ */
  // R13.35: apply persisted theme + wire picker
  initTheme();
  wireThemePicker();
init();
// push-update: quiet background check a couple of seconds after boot
setTimeout(() => { try { checkForUpdate(); } catch (e) {} }, 2500);

/* best-effort PWA service worker (only works over https/localhost).
   R13.1 self-heal: force an update check on every load, and when a new SW
   takes control, reload ONCE — so a stale cached build (the tablet was stuck
   showing the old "R13" page) can never linger after this point. */
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.ready.then((reg) => reg.update()).catch(() => {});
  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  }
}
