'use strict';
/* Touch Tools Action Picker — the friendly "what should this gesture do?" step.
 *
 * Two paths, in preference order:
 *   (a) READY-MADE MENU — ~22 friendly actions, fully OFFLINE, no AI, no config.json.
 *       Picking one just works.
 *   (b) DESCRIBE IT — ONE scoped model call converts a
 *       plain sentence into this tool's action JSON. Optional: no setup → the menu
 *       still does everything. NOT a chatbot: no message box beyond the one-line
 *       description input, no history, no answers to unrelated questions (the model
 *       is instructed to reply NOT_AN_ACTION, and the client rejects anything that
 *       is not a valid action). Settings = base url + api key + model, saved locally
 *       (localStorage rc_ai_settings); the key is never logged or displayed back.
 *   (c) Advanced (collapsed) — the old type-a-combo editor, for power users only.
 *
 * Safety: every action (menu, AI, advanced) is validated against the PC server's
 * key whitelist — an unknown key name would kill the control WebSocket.
 */
(function () {
  const AI_STORE = 'rc_ai_settings';

  // Two ways in, side by side. Meta first: this build is Muse/Meta at heart, so
  // a new user should be able to pick it and paste one key — nothing else.
  const PRESETS = [
    { id: 'meta', label: 'Meta Model API', base: 'https://api.meta.ai', modelHint: 'e.g. a Muse model', needsUrl: false },
    { id: 'go', label: 'OpenCode Go', base: 'https://opencode.ai/zen/go', modelHint: 'the model id shown in your account', needsUrl: false },
    { id: 'own', label: 'My own endpoint', base: '', modelHint: 'the model name your endpoint expects', needsUrl: true },
  ];

  /* ------------------------- server key whitelist ------------------------- */
  // Mirrors SPECIAL_KEYS + single chars in server.py resolve_key(). Anything
  // outside this set raises ValueError server-side and drops the connection.
  const SPECIAL = new Set([
    'enter', 'return', 'tab', 'esc', 'escape', 'space', 'backspace', 'delete',
    'up', 'down', 'left', 'right', 'ctrl', 'control', 'alt', 'option',
    'win', 'cmd', 'meta', 'windows', 'home', 'end', 'pageup', 'pagedown',
    'prtsc', 'print_screen', 'capslock', 'caps', 'insert', 'ins',
    'volume_up', 'vol_up', 'volume_down', 'vol_down',
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
  ]);
  function knownKey(k) {
    if (typeof k !== 'string' || !k) return false;
    const n = k.toLowerCase();
    if (SPECIAL.has(n)) return true;
    return n.length === 1;   // a-z 0-9 and any single printable char
  }

  /* --------------------------- the ready menu ----------------------------- */
  // Friendly names only — no key combos are ever shown to the user.
  // "Open …" items use a Win → type → Enter sequence (Start-menu search), so they
  // work with NO config.json entry on the PC.
  const openApp = (label, query) => ({
    label,
    seq: [{ keys: ['win'] }, { text: query }, { keys: ['enter'] }],
    delay: 300,
  });
  const MENU = [
    {
      group: 'Play & sound',
      items: [
        { id: 'play', ico: '⏯', label: 'Play or pause', action: { keys: ['space'], label: 'Play or pause' } },
        { id: 'volup', ico: '🔊', label: 'Volume up', action: { keys: ['volume_up'], label: 'Volume up' } },
        { id: 'voldn', ico: '🔉', label: 'Volume down', action: { keys: ['volume_down'], label: 'Volume down' } },
      ],
    },
    {
      group: 'Everyday',
      items: [
        { id: 'copy', ico: '📋', label: 'Copy', action: { keys: ['ctrl', 'c'], label: 'Copy' } },
        { id: 'paste', ico: '📥', label: 'Paste', action: { keys: ['ctrl', 'v'], label: 'Paste' } },
        { id: 'cut', ico: '✂️', label: 'Cut', action: { keys: ['ctrl', 'x'], label: 'Cut' } },
        { id: 'undo', ico: '↶', label: 'Undo', action: { keys: ['ctrl', 'z'], label: 'Undo' } },
        { id: 'redo', ico: '↷', label: 'Redo', action: { keys: ['ctrl', 'shift', 'z'], label: 'Redo' } },
        { id: 'shot', ico: '📷', label: 'Take a screenshot', action: { keys: ['prtsc'], label: 'Take a screenshot' } },
        { id: 'lock', ico: '🔒', label: 'Lock the PC', action: { keys: ['win', 'l'], label: 'Lock the PC' } },
        { id: 'switch', ico: '🪟', label: 'Switch window', action: { keys: ['alt', 'tab'], label: 'Switch window' } },
        { id: 'close', ico: '❎', label: 'Close window', action: { keys: ['alt', 'f4'], label: 'Close window' } },
        { id: 'desktop', ico: '🖥', label: 'Show desktop', action: { keys: ['win', 'd'], label: 'Show desktop' } },
        { id: 'back', ico: '⬅', label: 'Browser back', action: { keys: ['alt', 'left'], label: 'Browser back' } },
        { id: 'fwd', ico: '➡', label: 'Browser forward', action: { keys: ['alt', 'right'], label: 'Browser forward' } },
        { id: 'enter', ico: '⏎', label: 'Enter / confirm', action: { keys: ['enter'], label: 'Enter / confirm' } },
        { id: 'esc', ico: '⎋', label: 'Cancel / close dialog', action: { keys: ['esc'], label: 'Cancel / close dialog' } },
      ],
    },
    {
      group: 'Open an app (no setup needed)',
      items: [
        { id: 'app-notepad', ico: '📝', label: 'Open Notepad', action: Object.assign(openApp('Open Notepad', 'notepad'), {}) },
        { id: 'app-calc', ico: '🧮', label: 'Open Calculator', action: openApp('Open Calculator', 'calc') },
        { id: 'app-chrome', ico: '🌐', label: 'Open Chrome', action: openApp('Open Chrome', 'chrome') },
        { id: 'app-explorer', ico: '📁', label: 'Open File Explorer', action: openApp('Open File Explorer', 'explorer') },
        { id: 'app-paint', ico: '🎨', label: 'Open Paint', action: openApp('Open Paint', 'mspaint') },
      ],
    },
  ];

  /* --------------------------- action validation -------------------------- */
  function stripLabel(a) {
    if (!a || typeof a !== 'object') return a;
    const o = Object.assign({}, a);
    delete o.label;
    return o;
  }
  function sameBody(a, b) {
    return JSON.stringify(stripLabel(a)) === JSON.stringify(stripLabel(b));
  }

  // Returns a cleaned copy of the action, or throws Error(why). Never accepts a
  // key the PC server does not know (that would kill the control connection).
  function validateAction(a, depth) {
    depth = depth || 0;
    if (depth > 2) throw new Error('action nested too deep');
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('not an action object');
    const out = {};
    if (typeof a.label === 'string' && a.label) out.label = a.label.slice(0, 80);

    const shapes = ['keys', 'text', 'click', 'scroll', 'zoom', 'launch', 'seq', 'drag', 'hold', 'auto'];
    const present = shapes.filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== '');
    if (!present.length) throw new Error('empty action — no thing to do');

    if (a.keys !== undefined && a.keys !== null) {
      if (!Array.isArray(a.keys) || !a.keys.length || a.keys.length > 8) throw new Error('keys must be a short list');
      const ks = [];
      for (const k of a.keys) {
        if (!knownKey(k)) throw new Error('unsupported key "' + String(k).slice(0, 20) + '"');
        ks.push(String(k).toLowerCase());
      }
      out.keys = ks;
    }
    if (a.text !== undefined && a.text !== null) {
      if (typeof a.text !== 'string' || !a.text.length) throw new Error('text is empty');
      out.text = a.text.slice(0, 300);
    }
    if (a.click !== undefined && a.click !== null) {
      if (!['left', 'right', 'middle'].includes(a.click)) throw new Error('bad click');
      out.click = a.click;
    }
    if (a.scroll !== undefined && a.scroll !== null) {
      if (!Array.isArray(a.scroll) || a.scroll.length !== 2) throw new Error('bad scroll');
      out.scroll = [Number(a.scroll[0]) || 0, Number(a.scroll[1]) || 0];
      if (!out.scroll[0] && !out.scroll[1]) throw new Error('scroll of nothing');
    }
    if (a.zoom !== undefined && a.zoom !== null) {
      const z = Number(a.zoom);
      if (!z) throw new Error('zoom of nothing');
      out.zoom = Math.max(-8, Math.min(8, Math.round(z)));
    }
    if (a.launch !== undefined && a.launch !== null) {
      const n = String(a.launch).toLowerCase().replace(/\.exe$/i, '');
      if (!/^[a-z0-9 _-]{1,32}$/.test(n)) throw new Error('bad app name');
      out.launch = n;
    }
    if (a.seq !== undefined && a.seq !== null) {
      if (!Array.isArray(a.seq) || !a.seq.length || a.seq.length > 6) throw new Error('sequence must be 1–6 steps');
      out.seq = a.seq.map((s) => {
        const c = validateAction(s, depth + 1);
        delete c.label;
        return c;
      });
      if (a.delay !== undefined) out.delay = Math.max(80, Math.min(2000, Number(a.delay) || 300));
    }
    if (a.drag) out.drag = true;
    if (a.hold) {
      if (!['left', 'right'].includes(a.hold)) throw new Error('bad hold');
      out.hold = a.hold;
    }
    if (a.auto) out.auto = true;
    return out;
  }

  /* ----------------------------- AI settings ------------------------------ */
  function loadAi() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(AI_STORE) || '{}') || {}; } catch (e) { s = {}; }
    return {
      provider: typeof s.provider === 'string' ? s.provider : '',
      baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
      model: typeof s.model === 'string' && s.model ? s.model : '',
    };
  }
  function saveAi(s) {
    localStorage.setItem(AI_STORE, JSON.stringify({
      provider: String(s.provider || ''),
      baseUrl: String(s.baseUrl || '').trim(),
      apiKey: String(s.apiKey || ''),           // stored locally only — never logged/displayed
      model: String(s.model || '').trim(),
    }));
  }
  function isLocalUrl(u) {
    return /localhost|127\.0\.0\.1|::1|192\.168\.|10\./i.test(String(u || ''));
  }
  function aiConfigured() {
    const s = loadAi();
    return !!(s.baseUrl && s.model && (s.apiKey || isLocalUrl(s.baseUrl)));
  }

  /* ------------------------- the one scoped call -------------------------- */
  // FULL context (not starved): real job + complete action schema + the ready
  // menu + examples. Scoped hard: description in → ONE action JSON out, or the
  // sentinel NOT_AN_ACTION. No chit-chat, no Q&A, ever.
  function buildSystemPrompt(menuList) {
    const menuJson = menuList.map((m) => ({ label: m.label, action: stripLabel(m.action) }));
    return [
      'You are the action mapper for "Touch Tools", a remote control app for a Windows PC.',
      'Your ONLY job: turn ONE plain-language description of what a gesture should do into EXACTLY ONE action JSON object for that PC.',
      'You are not a chat assistant. Never greet, never small-talk, never answer questions, never explain, never refuse with prose.',
      'If the text is not a request to make the PC DO something, reply with exactly this word and nothing else: NOT_AN_ACTION',
      '',
      'Reply with RAW JSON only (no markdown fences, no comments), exactly one of these shapes:',
      '- {"keys":["ctrl","shift","s"]} — press those keys in order, release in reverse.',
      '  Allowed key names: enter tab esc space backspace delete up down left right ctrl shift alt win home end pageup pagedown prtsc capslock insert volume_up volume_down f1..f12, plus any single letter a-z or digit 0-9.',
      '- {"click":"left"} or {"click":"right"} or {"click":"middle"}',
      '- {"text":"literal string to type"}',
      '- {"scroll":[0,1]} scroll up · {"scroll":[0,-1]} scroll down',
      '- {"zoom":1} zoom in · {"zoom":-1} zoom out',
      '- {"seq":[{"keys":["win"]},{"text":"chrome"},{"keys":["enter"]}]} — up to 4 timed steps (the app waits ~300ms between them). USE THIS to open any app: press Win, type the app name as it appears in the Start menu, then Enter. Also use it for any multi-step shortcut.',
      '- {"launch":"notepad"} — only for apps already configured on the PC (currently: notepad). Prefer seq for anything else.',
      'You may add {"label":"short friendly name"} so the UI can show what it does.',
      '',
      'Prefer a ready-made action when the description matches one — return its action EXACTLY:',
      JSON.stringify(menuJson),
      '',
      'Examples:',
      '"open chrome" → {"seq":[{"keys":["win"]},{"text":"chrome"},{"keys":["enter"]}],"label":"Open Chrome"}',
      '"pause the video" → {"keys":["space"],"label":"Play or pause"}',
      '"copy that" → {"keys":["ctrl","c"],"label":"Copy"}',
      '"lock my computer" → {"keys":["win","l"],"label":"Lock the PC"}',
      '"take a screenshot" → {"keys":["prtsc"],"label":"Take a screenshot"}',
      '"what is the weather?" → NOT_AN_ACTION',
      '"tell me a joke" → NOT_AN_ACTION',
      '"hello" → NOT_AN_ACTION',
    ].join('\n');
  }

  function endpointFor(baseUrl) {
    let u = String(baseUrl || '').trim().replace(/\/+$/, '');
    // A full endpoint pasted as-is is honoured untouched.
    if (/\/messages$/i.test(u) || /\/chat\/completions$/i.test(u)) return u;
    // messages-style (the Meta Model API) ends at /v1/messages;
    // chat-style ends at /v1/chat/completions.
    if (/api\.meta\.ai/i.test(u)) return u + '/v1/messages';
    if (/opencode\.ai/i.test(u)) return u + '/v1/chat/completions';
    return u + '/chat/completions';
  }

  // One call in, one action out. Never stores/prints the key.
  async function describeToAction(text) {
    const desc = String(text || '').trim().slice(0, 300);
    if (!desc) throw new Error('type what it should do first.');
    const s = loadAi();
    if (!aiConfigured()) {
      const err = new Error('AI not set up yet — open ⚙ AI setup (base url + key + model), or just pick from the list.');
      err.code = 'not-configured';
      throw err;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    const url = endpointFor(s.baseUrl);
    const sys = buildSystemPrompt(flattenMenu());
    // Two envelopes, same question: messages-style carries the system prompt as
    // its own field; chat-style carries it as the first message.
    const isMessages = /\/messages$/i.test(url);
    const reqBody = isMessages
      ? {
          model: s.model, max_tokens: 300, temperature: 0,
          system: sys,
          messages: [{ role: 'user', content: desc }],
        }
      : {
          model: s.model, temperature: 0, max_tokens: 300,
          messages: [{ role: 'system', content: sys }, { role: 'user', content: desc }],
        };
    let res;
    // The browser refuses cross-origin calls to some endpoints (OpenCode Go
    // answers without CORS headers, so a direct fetch dies as "Failed to
    // fetch"). Those go through the PC server, which is not bound by that rule.
    const needsRelay = /opencode\.ai/i.test(url);
    const target = needsRelay ? '/api/ai' : url;
    const init = needsRelay
      ? {
          method: 'POST',
          signal: ctl.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, key: s.apiKey, body: reqBody }),
        }
      : {
          method: 'POST',
          signal: ctl.signal,
          headers: Object.assign(
            { 'Content-Type': 'application/json' },
            s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {}
          ),
          body: JSON.stringify(reqBody),
        };
    try {
      res = await fetch(target, init);
    } catch (e) {
      throw new Error('Could not reach the AI (offline or wrong base url) — pick from the list instead.');
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 160); } catch (e) {}
      throw new Error('AI call failed (HTTP ' + res.status + ')' + (detail ? ': ' + detail : '') + ' — pick from the list instead.');
    }
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('AI returned junk — try again or pick from the list.'); }
    const raw = (data && data.choices && data.choices[0] && data.choices[0].message
      && String(data.choices[0].message.content || ''))
      || (data && Array.isArray(data.content)
        ? data.content.map((x) => (x && x.text) || '').join('')
        : (data && typeof data.content === 'string' ? data.content : ''));
    const body = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    if (!body) throw new Error('AI returned nothing usable — pick from the list instead.');
    if (/^NOT_AN_ACTION$/i.test(body)) {
      const err = new Error('That does not describe a PC action — nothing was bound. Pick from the list instead.');
      err.code = 'not-an-action';
      throw err;
    }
    let act;
    try { act = JSON.parse(body); } catch (e) { throw new Error('AI did not return a usable action — reword it, or pick from the list.'); }
    let clean;
    try { clean = validateAction(act); } catch (e) { throw new Error('AI suggested something this tool cannot do (' + e.message + ') — pick from the list instead.'); }
    if (!clean.label) clean.label = desc.length > 60 ? desc.slice(0, 57) + '…' : desc;
    return clean;
  }

  function flattenMenu() {
    const out = [];
    for (const g of MENU) for (const it of g.items) out.push(it);
    return out;
  }

  /* --------------------------------- UI ----------------------------------- */
  const css = `
.rc-pick{display:flex;flex-direction:column;gap:8px;width:100%;}
.rc-pick-grp{font-size:11px;font-weight:700;color:var(--dim,#94a3b8);text-transform:uppercase;letter-spacing:.4px;margin-top:2px;}
.rc-pick-grid{display:flex;flex-wrap:wrap;gap:6px;}
.rc-chip{display:inline-flex;align-items:center;gap:6px;background:var(--panel,#1e293b);
  border:1px solid var(--line,#334155);color:var(--ink,#e2e8f0);border-radius:10px;
  padding:8px 11px;font-size:13.5px;font-weight:600;cursor:pointer;min-height:40px;
  touch-action:manipulation;text-align:left;}
.rc-chip:active{transform:scale(.97);}
.rc-chip.on{border-color:var(--accent,#22d3ee);box-shadow:0 0 0 1px var(--accent,#22d3ee) inset;background:rgba(34,211,238,.12);}
.rc-chip .ico{font-size:15px;}
.rc-sep{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dim,#94a3b8);}
.rc-sep::before,.rc-sep::after{content:"";flex:1;height:1px;background:var(--line,#334155);}
.rc-desc{display:flex;gap:6px;flex-wrap:wrap;}
.rc-desc input{flex:1;min-width:160px;background:var(--panel,#1e293b);border:1px solid var(--line,#334155);
  color:var(--ink,#e2e8f0);border-radius:10px;padding:9px 10px;font-size:14px;}
.rc-desc button{background:var(--panel,#1e293b);border:1px solid var(--accent,#22d3ee);color:var(--accent,#22d3ee);
  border-radius:10px;padding:9px 12px;font-size:13px;font-weight:700;cursor:pointer;min-height:40px;}
.rc-desc button:disabled{opacity:.5;cursor:default;}
.rc-status{font-size:12.5px;min-height:16px;color:var(--dim,#94a3b8);}
.rc-status.ok{color:var(--good,#22c55e);font-weight:600;}
.rc-status.err{color:var(--bad,#ef4444);font-weight:600;}
.rc-status.warn{color:var(--amber,#f59e0b);}
.rc-top{display:flex;align-items:center;gap:8px;}
.rc-top .rc-sel{flex:1;min-width:0;font-size:13px;font-weight:700;color:var(--accent,#22d3ee);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rc-gear{background:var(--panel,#1e293b);border:1px solid var(--line,#334155);color:var(--dim,#94a3b8);
  border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer;flex:0 0 auto;}
.rc-ai{display:none;flex-direction:column;gap:6px;background:var(--panel,#1e293b);
  border:1px dashed var(--line,#334155);border-radius:10px;padding:10px;}
.rc-ai.on{display:flex;}
.rc-preset-row{display:flex;gap:6px;flex-wrap:wrap;}
.rc-preset{flex:1 1 auto;background:var(--panel,#1e293b);border:1px solid var(--line,#334155);
  color:var(--ink,#e2e8f0);border-radius:10px;padding:7px 10px;font-size:12.5px;font-weight:700;cursor:pointer;}
.rc-preset.on{border-color:var(--accent,#22d3ee);box-shadow:0 0 0 1px var(--accent,#22d3ee) inset;
  background:rgba(34,211,238,.12);color:var(--accent,#22d3ee);}
.rc-ai label{font-size:11px;color:var(--dim,#94a3b8);font-weight:700;}
.rc-ai input{width:100%;background:#0f172a;border:1px solid var(--line,#334155);color:var(--ink,#e2e8f0);
  border-radius:8px;padding:8px 9px;font-size:13px;}
.rc-ai .rc-ai-row{display:flex;gap:6px;align-items:center;}
.rc-ai .rc-ai-row button{background:#164e63;border:1px solid var(--accent,#22d3ee);color:#e0f2fe;
  border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:700;cursor:pointer;}
.rc-ai .hint{font-size:11.5px;color:var(--dim,#94a3b8);line-height:1.45;}
.rc-adv{border-top:1px solid var(--line,#334155);padding-top:6px;}
.rc-adv>summary{font-size:12px;color:var(--dim,#94a3b8);cursor:pointer;user-select:none;list-style:none;}
.rc-adv>summary::before{content:"▸ ";}
.rc-adv[open]>summary::before{content:"▾ ";}
.rc-adv-body{margin-top:6px;}
.rc-clear{background:none;border:none;color:var(--dim,#94a3b8);font-size:12px;cursor:pointer;text-decoration:underline;padding:4px;}
`;
  let cssInjected = false;
  function ensureCss() {
    if (cssInjected || document.getElementById('rc-pick-css')) return;
    const st = document.createElement('style');
    st.id = 'rc-pick-css';
    st.textContent = css;
    document.head.appendChild(st);
    cssInjected = true;
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  /* mount(container, opts)
   *   opts.onPick(actionObjectOrNull)  — called whenever the user picks/describes/clears
   *   opts.current                     — initial action (object) or string (lab free text)
   *   opts.advanced(hostEl, onAdvPick) — optional: inject the legacy editor into the
   *                                       collapsed "other ways" box
   *   opts.freeText(hostEl, onStr)     — optional: lab's raw-text field in advanced
   */
  function mount(container, opts) {
    ensureCss();
    opts = opts || {};
    const onPick = opts.onPick || function () {};
    let current = (opts.current && typeof opts.current === 'object')
      ? JSON.parse(JSON.stringify(opts.current)) : null;

    const root = el('div', 'rc-pick');
    container.innerHTML = '';
    container.appendChild(root);

    // ---- current selection bar
    const top = el('div', 'rc-top');
    const selLab = el('span', 'rc-sel', '');
    const gear = el('button', 'rc-gear', '⚙ AI setup');
    gear.type = 'button';
    gear.style.flex = '0 0 auto';
    gear.title = 'Optional: connect your model so you can describe an action in plain words (Muse Spark or Meta). Leave unset and the list below still works fully.';
    // One-tap shortcut to the plain-words box at the bottom of the panel, so it
    // is never buried under the whole action list.
    const descJump = el('button', 'rc-gear', '✨ Describe');
    descJump.type = 'button';
    descJump.style.flex = '0 0 auto';
    descJump.title = 'Skip the list — type what the gesture should do and let your model work it out.';
    descJump.addEventListener('click', () => {
      try {
        descRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        descIn.focus({ preventScroll: false });
      } catch (e) {}
    });
    top.appendChild(selLab);
    top.appendChild(descJump);
    top.appendChild(gear);
    root.appendChild(top);

    const status = el('div', 'rc-status', '');
    root.appendChild(status);

    function refreshSel() {
      selLab.textContent = current
        ? 'Selected: ' + (current.label || (current.keys ? current.keys.join(' + ') : 'action'))
        : 'Nothing selected yet — tap one below.';
      root.querySelectorAll('.rc-chip').forEach((c) => {
        c.classList.toggle('on', !!(current && c._action && sameBody(c._action, current)));
      });
    }
    function pick(act) {
      current = act;
      refreshSel();
      onPick(act);
      if (act) {
        status.className = 'rc-status ok';
        status.textContent = '✓ ' + (act.label || 'Action set') + ' — ready to save.';
      } else {
        status.className = 'rc-status';
        status.textContent = '';
      }
    }

    // ---- the ready-made menu (offline path — always works, no AI, no config)
    for (const grp of MENU) {
      root.appendChild(el('div', 'rc-pick-grp', grp.group));
      const grid = el('div', 'rc-pick-grid');
      for (const item of grp.items) {
        const b = el('button', 'rc-chip');
        b.type = 'button';
        const ic = el('span', 'ico', item.ico || '');
        b.appendChild(ic);
        b.appendChild(document.createTextNode(item.label));
        b._action = item.action;
        b.addEventListener('click', () => pick(JSON.parse(JSON.stringify(item.action))));
        grid.appendChild(b);
      }
      root.appendChild(grid);
    }

    // ---- describe it (optional AI path)
    root.appendChild(el('div', 'rc-sep', 'or describe it in plain words — your key goes just below'));
    const descRow = el('div', 'rc-desc');
    const descIn = el('input');
    descIn.type = 'text';
    descIn.placeholder = 'e.g. open the calculator';
    descIn.maxLength = 300;
    descIn.setAttribute('autocapitalize', 'off');
    descIn.setAttribute('spellcheck', 'false');
    const descBtn = el('button', '', 'Work it out →');
    descBtn.type = 'button';
    descRow.appendChild(descIn);
    descRow.appendChild(descBtn);
    root.appendChild(descRow);

    async function runDescribe() {
      const text = descIn.value.trim();
      if (!text) { status.className = 'rc-status warn'; status.textContent = 'Type what it should do first.'; return; }
      if (!aiConfigured()) {
        status.className = 'rc-status warn';
        status.textContent = 'Not set up yet — fill in the boxes below (or just pick from the list, which needs nothing).';
        showAi();
        return;
      }
      descBtn.disabled = true;
      status.className = 'rc-status';
      status.textContent = 'Working it out…';
      try {
        const act = await describeToAction(text);
        descBtn.disabled = false;
        pick(act);
      } catch (e) {
        descBtn.disabled = false;
        status.className = 'rc-status err';
        status.textContent = e && e.message ? e.message : 'Could not work that out.';
      }
    }
    descBtn.addEventListener('click', runDescribe);
    descIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runDescribe(); } });

    // ---- AI settings (stored locally; key never displayed back or logged)
    const aiBox = el('div', 'rc-ai');
    const saved = loadAi();
    function field(labelText, value, placeholder, type) {
      const wrap = el('div');
      wrap.appendChild(el('label', '', labelText));
      const i = el('input');
      i.type = type || 'text';
      i.value = value || '';
      i.placeholder = placeholder || '';
      if (type === 'password') { i.setAttribute('autocomplete', 'off'); i.setAttribute('autocapitalize', 'off'); }
      wrap.appendChild(i);
      return { wrap, i };
    }
    // Which service — chosen first, so the fields below only ask for what that
    // service actually needs. Meta is pre-selected: paste a key, name a model.
    let provider = saved.provider
      || (/api\.meta\.ai/i.test(saved.baseUrl) ? 'meta' : (saved.baseUrl ? 'own' : 'meta'));
    const presetRow = el('div', 'rc-preset-row');
    const presetBtns = {};
    for (const p of PRESETS) {
      const b = el('button', 'rc-preset', p.label);
      b.type = 'button';
      presetBtns[p.id] = b;
      b.addEventListener('click', () => applyPreset(p.id, true));
      presetRow.appendChild(b);
    }
    aiBox.appendChild(el('div', 'rc-pick-grp', 'where the model comes from'));
    aiBox.appendChild(presetRow);

    const fUrl = field('Base URL', saved.baseUrl, 'paste your model endpoint here');
    const fKey = field('API key (stored only on this device, never shown again)',
      '', saved.apiKey ? '••••••••  (saved — leave blank to keep)' : 'paste your key');
    fKey.i.type = 'password';
    const fModel = field('Model name', saved.model, 'e.g. a Muse model');
    const aiRow = el('div', 'rc-ai-row');
    aiRow.style.flexWrap = 'wrap';
    const saveBtn = el('button', '', 'Save & test');
    saveBtn.type = 'button';
    saveBtn.title = 'Saves these settings, then asks your model one tiny question to prove the key works.';
    const closeAi = el('button', '', 'Close');
    closeAi.type = 'button';
    aiRow.appendChild(saveBtn);
    aiRow.appendChild(closeAi);
    const aiHint = el('div', 'hint',
      'Pick a service, paste its key, name the model. ' +
      'Used for ONE thing only: turning your description above into the action — never chat. ' +
      'No key set = the list above still works completely offline.');

    function applyPreset(id, fillUrl) {
      provider = presetBtns[id] ? id : 'meta';
      const p = PRESETS.find((x) => x.id === provider) || PRESETS[0];
      Object.keys(presetBtns).forEach((k) => presetBtns[k].classList.toggle('on', k === provider));
      fUrl.wrap.style.display = p.needsUrl ? '' : 'none';
      fModel.i.placeholder = p.modelHint;
      if (fillUrl) {
        if (p.needsUrl) { if (/api\.meta\.ai/i.test(fUrl.i.value)) fUrl.i.value = ''; }
        else fUrl.i.value = p.base;
      }
    }

    aiBox.appendChild(fUrl.wrap);
    aiBox.appendChild(fKey.wrap);
    aiBox.appendChild(fModel.wrap);
    aiBox.appendChild(aiRow);
    aiBox.appendChild(aiHint);
    applyPreset(provider, false);
    // A fresh device should SEE where the key goes, right under the describe
    // box — not have to discover a collapsed panel first.
    if (!aiConfigured()) aiBox.classList.add('on');
    saveBtn.addEventListener('click', async () => {
      const prev = loadAi();
      const preset = PRESETS.find((x) => x.id === provider) || PRESETS[0];
      saveAi({
        provider,
        baseUrl: preset.needsUrl ? fUrl.i.value : preset.base,
        apiKey: fKey.i.value.trim() ? fKey.i.value.trim() : prev.apiKey, // blank = keep saved key
        model: fModel.i.value,
      });
      fKey.i.value = '';
      fKey.i.placeholder = loadAi().apiKey ? '••••••••  (saved — leave blank to keep)' : 'paste your key';
      if (!aiConfigured()) {
        status.className = 'rc-status warn';
        status.textContent = provider === 'meta'
          ? 'Saved — paste your Meta Model API key to enable describing.'
          : 'Saved — add an API key (or a local address) to enable describing.';
        return;
      }
      status.className = 'rc-status';
      status.textContent = 'Saved. Asking your model one tiny question…';
      saveBtn.disabled = true;
      try {
        const act = await describeToAction('press the escape key');
        status.className = 'rc-status ok';
        status.textContent = '✓ Connected — the model answered "' + (act.label || 'an action') + '". Describe anything now.';
      } catch (e) {
        status.className = 'rc-status err';
        status.textContent = (e && e.message) || 'Saved, but the test failed — check the key and model name.';
      } finally { saveBtn.disabled = false; }
    });
    closeAi.addEventListener('click', () => aiBox.classList.remove('on'));
    // The setup box lives at the BOTTOM of the panel, under the whole action
    // list — so opening it without scrolling looked like nothing happened.
    // Always bring it into view and put the cursor in the first box.
    function showAi() {
      aiBox.classList.add('on');
      try {
        aiBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        fUrl.i.focus({ preventScroll: true });
      } catch (e) { /* old browser — the box is simply visible */ }
    }
    gear.addEventListener('click', () => {
      if (aiBox.classList.contains('on')) aiBox.classList.remove('on');
      else showAi();
    });
    root.appendChild(aiBox);

    // ---- clear
    const clear = el('button', 'rc-clear', 'Clear selection');
    clear.type = 'button';
    clear.addEventListener('click', () => { descIn.value = ''; pick(null); });
    root.appendChild(clear);

    // ---- advanced (collapsed): legacy editor and/or free text
    if (opts.advanced || opts.freeText) {
      const det = document.createElement('details');
      det.className = 'rc-adv';
      det.appendChild(el('summary', '', 'Other ways (advanced — type it yourself)'));
      const host = el('div', 'rc-adv-body');
      det.appendChild(host);
      root.appendChild(det);
      if (opts.freeText) opts.freeText(host, (str) => {
        current = (str && typeof str === 'object') ? str : null;
        refreshSel();
        onPick(str);
      });
      if (opts.advanced) opts.advanced(host, (act) => {
        current = act || null;
        refreshSel();
        onPick(act);
      });
    }

    refreshSel();
    if (current) {
      status.className = 'rc-status ok';
      status.textContent = '✓ ' + (current.label || 'Action set') + ' — ready to save.';
    } else if (!aiConfigured()) {
      status.className = 'rc-status';
      status.textContent = 'Pick from the list — works with no setup, no keys, no config.';
    }
    return { clear: () => { current = null; refreshSel(); onPick(null); } };
  }

  /* ------------------------------- exports -------------------------------- */
  window.RCActionPicker = {
    MENU,
    knownKey,
    validateAction,
    sameBody,
    stripLabel,
    loadAi,
    saveAi,
    aiConfigured,
    describeToAction,
    mount,
  };
})();
