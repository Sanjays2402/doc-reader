// Doc Reader — content script
// Detects supported documentation sites and provides a keyboard-driven
// reader-mode toggle. Visual stripping/TOC come in subsequent roadmap
// items; this file owns the lifecycle, state, and shortcut.

(async () => {
  if (window.__docReaderLoaded) return;
  window.__docReaderLoaded = true;

  const NS = "doc-reader";
  const ROOT_ATTR = `data-${NS}-root`;
  const ACTIVE_CLASS = `${NS}-active`; // "doc-reader-active"

  const STORAGE_KEY = `${NS}:enabled`;
  const WIDTH_STORAGE_KEY = `${NS}:width`;
  const WIDTH_MIN = 560;
  const WIDTH_MAX = 1080;
  const WIDTH_DEFAULT = 720;
  const WIDTH_STEP = 40;
  const ARTICLE_ATTR = "data-doc-reader-article";
  const ANCESTOR_ATTR = "data-doc-reader-article-ancestor";

  // ---- Site detection ------------------------------------------------------
  let site = null;
  let commonNoise = [];
  try {
    const mod = await import(chrome.runtime.getURL("src/sites.js"));
    site = mod.detectSite(location);
    commonNoise = Array.isArray(mod.COMMON_NOISE) ? mod.COMMON_NOISE : [];
  } catch (err) {
    if (window.__docReaderDebug) console.warn("[doc-reader] detect failed", err);
  }

  const state = {
    enabled: false,
    host: location.hostname,
    href: location.href,
    site: site ? { id: site.id, label: site.label, accent: site.accent } : null,
    supported: !!site,
    width: WIDTH_DEFAULT,
  };

  function clampWidth(n) {
    n = Math.round(Number(n) || WIDTH_DEFAULT);
    if (!Number.isFinite(n)) n = WIDTH_DEFAULT;
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  }

  if (site) {
    document.documentElement.setAttribute(`data-${NS}-site`, site.id);
  }

  // ---- Shadow-root UI scaffold --------------------------------------------
  function ensureRoot() {
    let root = document.querySelector(`[${ROOT_ATTR}]`);
    if (!root) {
      root = document.createElement("div");
      root.setAttribute(ROOT_ATTR, "");
      root.setAttribute("hidden", "");
      root.attachShadow({ mode: "open" });
      (document.body || document.documentElement).appendChild(root);
      mountShell(root.shadowRoot);
    }
    return root;
  }

  function mountShell(shadow) {
    const accent = site?.accent || "#83d0f2";
    const style = document.createElement("style");
    style.textContent = `
      :host, * { box-sizing: border-box; }
      .pill {
        position: fixed;
        top: 16px;
        right: 16px;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px 8px 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro", sans-serif;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: -0.01em;
        line-height: 1.45;
        color: rgba(245, 245, 247, 0.94);
        background: linear-gradient(180deg, rgba(22,22,28,0.68), rgba(14,14,18,0.62));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        box-shadow:
          0 8px 24px rgba(0,0,0,0.32),
          inset 0 1px 0 rgba(255,255,255,0.08);
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        opacity: 0;
        transform: translateY(-6px) scale(0.98);
        transition:
          opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .pill[data-visible="1"] {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .pill .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: ${accent};
        box-shadow: 0 0 12px ${accent}88;
      }
      .pill[data-state="off"] .dot {
        background: rgba(255,255,255,0.32);
        box-shadow: none;
      }
      .pill .kbd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.10);
        color: rgba(245,245,247,0.78);
      }
    `;
    const pill = document.createElement("div");
    pill.className = "pill";
    pill.setAttribute("data-state", "off");
    pill.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span class="label">Reader off</span>
      <span class="kbd" aria-hidden="true">⇧R</span>
    `;
    shadow.appendChild(style);
    shadow.appendChild(pill);
  }

  // ---- Toggle --------------------------------------------------------------
  let pillHideTimer = 0;
  function flashPill() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const pill = root?.shadowRoot?.querySelector(".pill");
    if (!pill) return;
    pill.setAttribute("data-state", state.enabled ? "on" : "off");
    const label = pill.querySelector(".label");
    if (label) label.textContent = state.enabled ? "Reader on" : "Reader off";
    pill.setAttribute("data-visible", "1");
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(() => pill.removeAttribute("data-visible"), 1400);
  }

  function applyEnabled() {
    const root = ensureRoot();
    if (state.enabled) {
      document.documentElement.classList.add(ACTIVE_CLASS);
      applyWidth();
      root.removeAttribute("hidden");
      stripNoise();
      applySingleColumn();
    } else {
      restoreSingleColumn();
      restoreNoise();
      document.documentElement.classList.remove(ACTIVE_CLASS);
      // Keep the shadow host mounted; hide so future features can reuse it.
      root.setAttribute("hidden", "");
    }
  }

  // ---- Single-column layout ------------------------------------------------
  function applyWidth() {
    document.documentElement.style.setProperty(
      "--doc-reader-max-width",
      `${state.width}px`,
    );
  }

  function applySingleColumn() {
    if (!state.supported) return;
    restoreSingleColumn();
    let el = null;
    try { el = document.querySelector(site.article); } catch { el = null; }
    if (!el) return;
    articleEl = el;
    el.setAttribute(ARTICLE_ATTR, "1");
    ancestorEls = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      n.setAttribute(ANCESTOR_ATTR, "1");
      ancestorEls.push(n);
    }
  }

  function restoreSingleColumn() {
    if (articleEl) {
      try { articleEl.removeAttribute(ARTICLE_ATTR); } catch { /* detached */ }
      articleEl = null;
    }
    for (const n of ancestorEls) {
      try { n.removeAttribute(ANCESTOR_ATTR); } catch { /* detached */ }
    }
    ancestorEls = [];
  }

  async function setWidth(next, opts = {}) {
    const v = clampWidth(next);
    state.width = v;
    if (state.enabled) {
      applyWidth();
      flashWidth();
    }
    if (opts.persist !== false) persistWidth(v);
    return v;
  }

  function flashWidth() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const pill = root?.shadowRoot?.querySelector(".pill");
    if (!pill) return;
    const label = pill.querySelector(".label");
    if (label) label.textContent = `${state.width}px`;
    pill.setAttribute("data-state", state.enabled ? "on" : "off");
    pill.setAttribute("data-visible", "1");
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(() => pill.removeAttribute("data-visible"), 1100);
  }

  // ---- Strip noise (nav, sidebar, ads) ------------------------------------
  // Hides per-site chrome while keeping the article subtree (and code blocks
  // within it) untouched. We tag matching elements with a stable attribute
  // so the accompanying CSS rule does the actual hiding, and we remember
  // which nodes we tagged so disabling reader mode restores the page.
  const HIDE_ATTR = "data-doc-reader-hide";
  let hiddenNodes = [];
  let articleEl = null;
  let ancestorEls = [];

  function getKeepAncestors() {
    if (!site) return new Set();
    const keep = new Set();
    let article = null;
    try { article = document.querySelector(site.article); } catch { /* bad selector */ }
    if (!article) return keep;
    for (let n = article; n && n.nodeType === 1; n = n.parentElement) {
      keep.add(n);
    }
    // Also keep the article subtree itself — code blocks live there.
    keep.add(article);
    return keep;
  }

  function stripNoise() {
    if (!state.supported) return;
    restoreNoise(); // idempotent
    const selectors = [
      ...(Array.isArray(site?.noise) ? site.noise : []),
      ...commonNoise,
    ];
    if (selectors.length === 0) return;
    const keep = getKeepAncestors();
    const seen = new Set();
    for (const sel of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch { continue; }
      for (const el of nodes) {
        if (!el || seen.has(el)) continue;
        if (keep.has(el)) continue;
        // Don't hide a node that contains the article — would nuke it.
        if (el.contains && keep.size > 0) {
          let containsKeep = false;
          for (const k of keep) {
            if (el !== k && el.contains(k)) { containsKeep = true; break; }
          }
          if (containsKeep) continue;
        }
        seen.add(el);
        el.setAttribute(HIDE_ATTR, "1");
        hiddenNodes.push(el);
      }
    }
  }

  function restoreNoise() {
    for (const el of hiddenNodes) {
      try { el.removeAttribute(HIDE_ATTR); } catch { /* detached */ }
    }
    hiddenNodes = [];
  }

  function setEnabled(next, opts = {}) {
    next = !!next;
    if (next === state.enabled) {
      if (opts.flash !== false) flashPill();
      return state.enabled;
    }
    state.enabled = next;
    applyEnabled();
    if (opts.flash !== false) flashPill();
    persistEnabled(next);
    return state.enabled;
  }

  function toggleEnabled() {
    return setEnabled(!state.enabled);
  }
  // Expose for tests / debugging without polluting global typings.
  window.__docReaderToggle = toggleEnabled;

  // ---- Persistence ---------------------------------------------------------
  async function loadEnabled() {
    if (!state.supported) return false;
    try {
      const got = await chrome.storage?.local?.get?.(STORAGE_KEY);
      const map = got?.[STORAGE_KEY];
      // Per-host persistence so toggling on MDN doesn't leak to react.dev.
      if (map && typeof map === "object" && map[state.host]) return true;
    } catch {
      /* storage unavailable */
    }
    return false;
  }

  async function persistEnabled(value) {
    try {
      const got = await chrome.storage?.local?.get?.(STORAGE_KEY);
      const map = (got && got[STORAGE_KEY]) || {};
      if (value) map[state.host] = 1;
      else delete map[state.host];
      await chrome.storage?.local?.set?.({ [STORAGE_KEY]: map });
    } catch {
      /* ignore */
    }
  }

  async function loadWidth() {
    try {
      const got = await chrome.storage?.local?.get?.(WIDTH_STORAGE_KEY);
      const map = got?.[WIDTH_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) {
        return clampWidth(map[state.host]);
      }
    } catch {
      /* storage unavailable */
    }
    return WIDTH_DEFAULT;
  }

  async function persistWidth(value) {
    try {
      const got = await chrome.storage?.local?.get?.(WIDTH_STORAGE_KEY);
      const map = (got && got[WIDTH_STORAGE_KEY]) || {};
      map[state.host] = clampWidth(value);
      await chrome.storage?.local?.set?.({ [WIDTH_STORAGE_KEY]: map });
    } catch {
      /* ignore */
    }
  }

  // ---- Keyboard shortcut: Shift+R -----------------------------------------
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (!state.supported) return;

    // Shift + R toggles reader mode.
    if ((e.key === "R" || e.code === "KeyR") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleEnabled();
      return;
    }

    // [ and ] adjust max-width while reader mode is on. No shift.
    if (state.enabled && !e.shiftKey) {
      if (e.key === "[" || e.code === "BracketLeft") {
        e.preventDefault();
        e.stopPropagation();
        setWidth(state.width - WIDTH_STEP);
        return;
      }
      if (e.key === "]" || e.code === "BracketRight") {
        e.preventDefault();
        e.stopPropagation();
        setWidth(state.width + WIDTH_STEP);
        return;
      }
    }
  }
  window.addEventListener("keydown", onKeyDown, true);

  // ---- Message bridge ------------------------------------------------------
  chrome.runtime?.onMessage?.addListener?.((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "doc-reader/ping":
        sendResponse({ ok: true, host: state.host, enabled: state.enabled });
        return true;
      case "doc-reader/status":
        sendResponse({ ...state });
        return true;
      case "doc-reader/detect":
        sendResponse({ supported: state.supported, site: state.site });
        return true;
      case "doc-reader/toggle":
        sendResponse({ enabled: toggleEnabled(), supported: state.supported });
        return true;
      case "doc-reader/set":
        sendResponse({
          enabled: setEnabled(!!msg.enabled),
          supported: state.supported,
        });
        return true;
      case "doc-reader/get-width":
        sendResponse({ width: state.width, min: WIDTH_MIN, max: WIDTH_MAX });
        return true;
      case "doc-reader/set-width":
        setWidth(msg.width).then((w) => sendResponse({ width: w }));
        return true;
      default:
        return false;
    }
  });

  // ---- Boot ----------------------------------------------------------------
  ensureRoot();
  if (state.supported) {
    state.width = await loadWidth();
    applyWidth();
    const wasEnabled = await loadEnabled();
    if (wasEnabled) setEnabled(true, { flash: false });
  }
  if (window.__docReaderDebug) console.log(`[${NS}]`, "ready", state);
})();
