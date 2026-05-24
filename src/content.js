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
  const SITE_PREFS_KEY = `${NS}:site-prefs`;
  const WIDTH_STORAGE_KEY = `${NS}:width`;
  const FONT_STORAGE_KEY = `${NS}:font-size`;
  const LH_STORAGE_KEY = `${NS}:line-height`;
  const FAMILY_STORAGE_KEY = `${NS}:font-family`;
  const SYNTAX_STORAGE_KEY = `${NS}:syntax-theme`;
  const BOOKMARK_STORAGE_KEY = `${NS}:bookmarks`;
  const HISTORY_STORAGE_KEY = `${NS}:history`;
  const HISTORY_MAX = 20;
  const HIGHLIGHT_STORAGE_KEY = `${NS}:highlights`;
  const FOCUS_STORAGE_KEY = `${NS}:focus`;
  // Per-article reading-position resume. Keyed by canonical URL, capped at
  // RESUME_MAX entries (oldest pruned). Stored in local only — sync quota is
  // too small for a long-tail URL map.
  const RESUME_STORAGE_KEY = `${NS}:resume`;
  const RESUME_MAX = 200;
  const RESUME_MIN_Y = 200;
  // Keys mirrored across browsers via chrome.storage.sync. Bookmarks,
  // highlights, annotations, and history are intentionally excluded: they are
  // URL-bound content that easily blows past the per-item sync quota. Only
  // small per-host preference maps live here.
  const SYNCED_KEYS = [
    STORAGE_KEY,
    SITE_PREFS_KEY,
    WIDTH_STORAGE_KEY,
    FONT_STORAGE_KEY,
    LH_STORAGE_KEY,
    FAMILY_STORAGE_KEY,
    SYNTAX_STORAGE_KEY,
    FOCUS_STORAGE_KEY,
  ];
  const FOCUS_ATTR = `data-${NS}-focus`;
  const FOCUS_TARGET_ATTR = `data-${NS}-focus-target`;
  const HIGHLIGHT_ATTR = "data-doc-reader-hl";
  const HIGHLIGHT_ID_ATTR = "data-doc-reader-hl-id";
  const HIGHLIGHT_COLOR_ATTR = "data-doc-reader-hl-color";
  const HIGHLIGHT_NOTE_ATTR = "data-doc-reader-hl-note";
  const HIGHLIGHT_COLORS = [
    { id: "yellow", label: "Yellow", fill: "#ffd86b", ink: "#3a2e00" },
    { id: "mint",   label: "Mint",   fill: "#9be7c0", ink: "#0a3a25" },
    { id: "sky",    label: "Sky",    fill: "#9cc9ff", ink: "#0a2a55" },
    { id: "pink",   label: "Pink",   fill: "#ffb0c8", ink: "#4a0a25" },
  ];
  const HIGHLIGHT_COLOR_IDS = HIGHLIGHT_COLORS.map((c) => c.id);
  const WIDTH_MIN = 560;
  const WIDTH_MAX = 1080;
  const WIDTH_DEFAULT = 720;
  const WIDTH_STEP = 40;
  const FONT_MIN = 13;
  const FONT_MAX = 22;
  const FONT_DEFAULT = 16.5;
  const FONT_STEP = 0.5;
  const LH_MIN = 1.3;
  const LH_MAX = 2.0;
  const LH_DEFAULT = 1.7;
  const LH_STEP = 0.05;
  const FAMILIES = [
    {
      id: "sans",
      label: "Sans",
      stack: '-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", "Segoe UI", system-ui, sans-serif',
    },
    {
      id: "serif",
      label: "Serif",
      stack: '"Iowan Old Style", "Charter", "Source Serif Pro", "Georgia", "Cambria", "Times New Roman", Times, serif',
    },
    {
      id: "mono",
      label: "Mono",
      stack: 'ui-monospace, SFMono-Regular, "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
    },
  ];
  const FAMILY_IDS = FAMILIES.map((f) => f.id);
  const FAMILY_DEFAULT = "sans";
  const SYNTAX_THEMES = [
    { id: "noir",  label: "Noir"  },
    { id: "paper", label: "Paper" },
    { id: "neon",  label: "Neon"  },
  ];
  const SYNTAX_THEME_IDS = SYNTAX_THEMES.map((t) => t.id);
  const SYNTAX_THEME_DEFAULT = "noir";
  const ARTICLE_ATTR = "data-doc-reader-article";
  const ANCESTOR_ATTR = "data-doc-reader-article-ancestor";
  const HEADING_ATTR = "data-doc-reader-heading";
  const META_ATTR = "data-doc-reader-meta";
  const SECTION_ATTR = "data-doc-reader-section";
  const SECTION_HIDDEN_ATTR = "data-doc-reader-section-hidden";
  const COLLAPSED_ATTR = "data-doc-reader-collapsed";
  const TOGGLE_ATTR = "data-doc-reader-section-toggle";
  const IMG_ATTR = "data-doc-reader-img";
  const SEARCH_ATTR = "data-doc-reader-search";
  const SEARCH_ID_ATTR = "data-doc-reader-search-id";
  const SEARCH_CURRENT_ATTR = "data-current";
  const LIGHTBOX_ZOOM_MIN = 0.25;
  const LIGHTBOX_ZOOM_MAX = 6;
  const LIGHTBOX_ZOOM_STEP = 0.25;
  const READ_WPM = 230;
  const TOC_REBUILD_MS = 280;
  const PROGRESS_RAF_THROTTLE = true;

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

  // ---- Per-site enable/disable preference ----------------------------------
  // Settings panel writes `{ [siteId]: boolean }` to chrome.storage.local under
  // SITE_PREFS_KEY. Default is enabled; only an explicit `false` disables a
  // supported site. A disabled site behaves like an unsupported one: no auto
  // activation, Shift+R no-ops, but the user can still re-enable in the popup.
  let siteAllowed = true;
  async function loadSiteAllowed() {
    if (!site) return true;
    try {
      const got = await chrome.storage?.local?.get?.(SITE_PREFS_KEY);
      const map = got?.[SITE_PREFS_KEY];
      if (map && typeof map === "object" && map[site.id] === false) return false;
    } catch { /* storage unavailable */ }
    return true;
  }
  siteAllowed = await loadSiteAllowed();
  // React to live changes from the popup so toggling off immediately
  // disables reader mode in any open tabs.
  try {
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area !== "local" || !site) return;
      if (!changes[SITE_PREFS_KEY]) return;
      const next = changes[SITE_PREFS_KEY].newValue || {};
      const allowed = next[site.id] !== false;
      if (allowed === siteAllowed) return;
      siteAllowed = allowed;
      state.supported = !!site && siteAllowed;
      if (!allowed && state.enabled) setEnabled(false, { flash: false });
    });
  } catch { /* noop */ }

  const state = {
    enabled: false,
    host: location.hostname,
    href: location.href,
    site: site ? { id: site.id, label: site.label, accent: site.accent } : null,
    supported: !!site && siteAllowed,
    width: WIDTH_DEFAULT,
    fontSize: FONT_DEFAULT,
    lineHeight: LH_DEFAULT,
    fontFamily: FAMILY_DEFAULT,
    syntaxTheme: SYNTAX_THEME_DEFAULT,
    theme: "light",
    focus: false,
  };

  // ---- Auto-detect dark mode preference -----------------------------------
  // Mirror the user's OS-level `prefers-color-scheme` onto the <html> element
  // as `data-doc-reader-theme="dark|light"` while reader mode is active. The
  // attribute is the single hook the article + shadow UI use to pick palette,
  // so we never need to manually toggle classes elsewhere. The MediaQueryList
  // listener stays attached for the page lifetime so theme flips while the
  // reader is open animate cleanly.
  const THEME_ATTR = `data-${NS}-theme`;
  const darkMql = typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
  function detectPreferredTheme() {
    return darkMql && darkMql.matches ? "dark" : "light";
  }
  function applyTheme() {
    if (state.enabled) {
      document.documentElement.setAttribute(THEME_ATTR, state.theme);
    } else {
      document.documentElement.removeAttribute(THEME_ATTR);
    }
  }
  function onThemeChange() {
    const next = detectPreferredTheme();
    if (next === state.theme) return;
    state.theme = next;
    if (state.enabled) applyTheme();
  }
  state.theme = detectPreferredTheme();
  if (darkMql) {
    if (typeof darkMql.addEventListener === "function") {
      darkMql.addEventListener("change", onThemeChange);
    } else if (typeof darkMql.addListener === "function") {
      darkMql.addListener(onThemeChange);
    }
  }

  function clampWidth(n) {
    n = Math.round(Number(n) || WIDTH_DEFAULT);
    if (!Number.isFinite(n)) n = WIDTH_DEFAULT;
    return Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, n));
  }

  function clampFontSize(n) {
    n = Number(n);
    if (!Number.isFinite(n)) n = FONT_DEFAULT;
    // Snap to 0.1 to keep storage tidy.
    n = Math.round(n * 10) / 10;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, n));
  }

  function clampFamily(id) {
    if (typeof id !== "string") return FAMILY_DEFAULT;
    return FAMILY_IDS.includes(id) ? id : FAMILY_DEFAULT;
  }

  function familyStack(id) {
    const f = FAMILIES.find((x) => x.id === clampFamily(id));
    return f ? f.stack : FAMILIES[0].stack;
  }

  function familyLabel(id) {
    const f = FAMILIES.find((x) => x.id === clampFamily(id));
    return f ? f.label : FAMILIES[0].label;
  }

  function clampSyntaxTheme(id) {
    if (typeof id !== "string") return SYNTAX_THEME_DEFAULT;
    return SYNTAX_THEME_IDS.includes(id) ? id : SYNTAX_THEME_DEFAULT;
  }

  function syntaxThemeLabel(id) {
    const t = SYNTAX_THEMES.find((x) => x.id === clampSyntaxTheme(id));
    return t ? t.label : SYNTAX_THEMES[0].label;
  }

  function clampLineHeight(n) {
    n = Number(n);
    if (!Number.isFinite(n)) n = LH_DEFAULT;
    n = Math.round(n * 100) / 100;
    return Math.min(LH_MAX, Math.max(LH_MIN, n));
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
      .toc {
        position: fixed;
        top: 64px;
        left: 20px;
        width: 248px;
        max-height: calc(100vh - 96px);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro", sans-serif;
        font-size: 12.5px;
        letter-spacing: -0.01em;
        line-height: 1.45;
        color: rgba(245,245,247,0.92);
        background: linear-gradient(180deg, rgba(22,22,28,0.66), rgba(14,14,18,0.58));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 18px;
        box-shadow:
          0 18px 48px rgba(0,0,0,0.34),
          inset 0 1px 0 rgba(255,255,255,0.06);
        backdrop-filter: blur(20px) saturate(140%);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        opacity: 0;
        transform: translateX(-8px);
        transition:
          opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
      }
      .toc[data-visible="1"] {
        opacity: 1;
        transform: translateX(0);
      }
      .toc::before {
        content: "";
        position: absolute;
        inset: -40% -30% auto auto;
        width: 220px;
        height: 220px;
        background: radial-gradient(closest-side, ${accent}33, transparent 70%);
        filter: blur(28px);
        pointer-events: none;
      }
      .toc-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 16px 10px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(245,245,247,0.62);
        border-bottom: 1px solid rgba(255,255,255,0.06);
        position: relative;
      }
      .toc-head svg {
        width: 14px;
        height: 14px;
        stroke: ${accent};
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .toc-list {
        list-style: none;
        margin: 0;
        padding: 8px 8px 12px;
        overflow-y: auto;
        overflow-x: hidden;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.16) transparent;
        position: relative;
      }
      .toc-list::-webkit-scrollbar { width: 6px; }
      .toc-list::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.16);
        border-radius: 999px;
      }
      .toc-item {
        margin: 0;
        padding: 0;
      }
      .toc-link {
        display: block;
        padding: 6px 10px;
        margin: 1px 0;
        border-radius: 8px;
        color: rgba(245,245,247,0.74);
        text-decoration: none;
        cursor: pointer;
        font-weight: 450;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border: 1px solid transparent;
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .toc-link:hover {
        background: rgba(255,255,255,0.06);
        color: rgba(245,245,247,0.96);
      }
      .toc-link:focus-visible {
        outline: none;
        border-color: ${accent}99;
        box-shadow: 0 0 0 2px ${accent}55;
      }
      .toc-item[data-level="3"] .toc-link {
        padding-left: 22px;
        font-size: 12px;
        color: rgba(245,245,247,0.62);
      }
      .toc-link[data-active="1"] {
        background: linear-gradient(180deg, ${accent}22, ${accent}11);
        color: rgba(245,245,247,0.98);
        border-color: ${accent}33;
      }
      .toc-link {
        position: relative;
      }
      .toc-link[data-bookmarked="1"] {
        padding-right: 24px;
      }
      .toc-link[data-bookmarked="1"]::after {
        content: "";
        position: absolute;
        right: 10px;
        top: 50%;
        width: 10px;
        height: 12px;
        transform: translateY(-50%);
        background: ${accent};
        clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 75%, 0 100%);
        box-shadow: 0 0 6px ${accent}aa;
        transition: transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .toc-item[data-level="3"] .toc-link[data-bookmarked="1"]::after {
        right: 12px;
        width: 8px;
        height: 10px;
      }
      .toc-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        padding: 28px 20px 24px;
        color: rgba(245,245,247,0.58);
        text-align: center;
      }
      .toc-empty svg {
        width: 56px;
        height: 40px;
        stroke: ${accent};
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
        opacity: 0.72;
      }
      .toc-empty span {
        font-size: 11.5px;
        letter-spacing: 0;
      }
      @media (max-width: 1100px) {
        .toc { display: none; }
      }
      .minimap {
        position: fixed;
        top: 64px;
        right: 18px;
        width: 18px;
        max-height: calc(100vh - 96px);
        height: calc(100vh - 96px);
        pointer-events: auto;
        background: linear-gradient(180deg, rgba(22,22,28,0.42), rgba(14,14,18,0.34));
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        box-shadow:
          0 14px 36px rgba(0,0,0,0.30),
          inset 0 1px 0 rgba(255,255,255,0.05);
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        opacity: 0;
        transform: translateX(6px);
        transition:
          opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
        cursor: pointer;
        z-index: 2;
      }
      .minimap[data-visible="1"] { opacity: 1; transform: translateX(0); }
      .minimap::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(closest-side at 50% 30%, ${accent}1f, transparent 70%);
        pointer-events: none;
      }
      .minimap-track {
        position: absolute;
        inset: 6px 4px;
        pointer-events: none;
      }
      .minimap-tick {
        position: absolute;
        left: 2px;
        right: 2px;
        height: 2px;
        border-radius: 2px;
        background: rgba(245,245,247,0.34);
        pointer-events: none;
        transition: background 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .minimap-tick[data-level="2"] {
        background: rgba(245,245,247,0.62);
        left: 1px;
        right: 1px;
        height: 2px;
      }
      .minimap-tick[data-active="1"] {
        background: ${accent};
        box-shadow: 0 0 6px ${accent}99;
      }
      .minimap-hl {
        position: absolute;
        left: -1px;
        right: -1px;
        height: 3px;
        border-radius: 999px;
        opacity: 0.92;
        pointer-events: none;
      }
      .minimap-hl[data-color="yellow"] { background: #ffd86b; box-shadow: 0 0 6px rgba(255,216,107,0.6); }
      .minimap-hl[data-color="mint"]   { background: #9be7c0; box-shadow: 0 0 6px rgba(155,231,192,0.6); }
      .minimap-hl[data-color="sky"]    { background: #9cc9ff; box-shadow: 0 0 6px rgba(156,201,255,0.6); }
      .minimap-hl[data-color="pink"]   { background: #ffb0c8; box-shadow: 0 0 6px rgba(255,176,200,0.6); }
      .minimap-viewport {
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 0;
        background: rgba(255,255,255,0.10);
        border-top: 1px solid rgba(255,255,255,0.18);
        border-bottom: 1px solid rgba(255,255,255,0.18);
        border-radius: 4px;
        pointer-events: none;
        transition: top 120ms cubic-bezier(0.16, 1, 0.3, 1), height 120ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      [data-doc-reader-theme="light"] .minimap {
        background: linear-gradient(180deg, rgba(255,255,255,0.66), rgba(248,248,250,0.58));
        border-color: rgba(0,0,0,0.08);
        box-shadow:
          0 14px 36px rgba(0,0,0,0.10),
          inset 0 1px 0 rgba(255,255,255,0.6);
      }
      [data-doc-reader-theme="light"] .minimap-tick { background: rgba(20,20,24,0.32); }
      [data-doc-reader-theme="light"] .minimap-tick[data-level="2"] { background: rgba(20,20,24,0.55); }
      [data-doc-reader-theme="light"] .minimap-viewport {
        background: rgba(20,20,24,0.06);
        border-color: rgba(20,20,24,0.18);
      }
      @media (max-width: 1100px) {
        .minimap { display: none; }
      }
      @media print {
        .minimap { display: none !important; }
      }
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
      .progress {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        height: 3px;
        pointer-events: none;
        background: linear-gradient(180deg, rgba(22,22,28,0.32), rgba(14,14,18,0.18));
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        opacity: 0;
        transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
      }
      .progress[data-visible="1"] {
        opacity: 1;
      }
      .progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, ${accent}cc, ${accent});
        box-shadow: 0 0 12px ${accent}99, 0 0 2px ${accent};
        border-radius: 0 2px 2px 0;
        transform-origin: left center;
        transition: width 120ms cubic-bezier(0.16, 1, 0.3, 1);
        will-change: width;
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
      .hl-palette {
        position: fixed;
        top: 0;
        left: 0;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        background: linear-gradient(180deg, rgba(22,22,28,0.74), rgba(14,14,18,0.68));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        box-shadow:
          0 12px 32px rgba(0,0,0,0.40),
          inset 0 1px 0 rgba(255,255,255,0.08);
        backdrop-filter: blur(20px) saturate(140%);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        opacity: 0;
        transform: translateY(-4px) scale(0.96);
        transition:
          opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hl-palette[data-visible="1"] {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .hl-palette button {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 999px;
        cursor: pointer;
        transition:
          transform 180ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hl-palette button:focus-visible {
        box-shadow: 0 0 0 2px ${accent}99;
      }
      .hl-swatch {
        position: relative;
      }
      .hl-swatch-dot {
        display: block;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: var(--swatch, #ffd86b);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.30),
          inset 0 -1px 0 rgba(0,0,0,0.10),
          0 0 0 1px rgba(0,0,0,0.18);
      }
      .hl-swatch:hover { transform: scale(1.08); }
      .hl-swatch:active { transform: scale(0.96); }
      .hl-divider {
        width: 1px;
        height: 18px;
        background: rgba(255,255,255,0.12);
        margin: 0 2px;
      }
      .hl-remove svg {
        width: 14px;
        height: 14px;
        stroke: rgba(245,245,247,0.72);
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .hl-remove:hover svg { stroke: #ff9a9a; }
      .hl-remove:hover { background: rgba(255,154,154,0.10); }
      .hl-note-btn svg {
        width: 14px;
        height: 14px;
        stroke: rgba(245,245,247,0.72);
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .hl-note-btn:hover svg { stroke: ${accent}; }
      .hl-note-btn:hover { background: rgba(255,255,255,0.08); }
      .hl-note-btn[data-has-note="1"] svg { stroke: ${accent}; }
      .hl-note-btn[data-has-note="1"]::after {
        content: "";
        position: absolute;
        top: 4px;
        right: 4px;
        width: 5px;
        height: 5px;
        border-radius: 999px;
        background: ${accent};
        box-shadow: 0 0 0 1.5px rgba(20,20,24,0.85);
      }
      .hl-note-btn { position: relative; }

      .hl-note-editor {
        position: fixed;
        top: 0;
        left: 0;
        width: 280px;
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 12px;
        background: linear-gradient(180deg, rgba(22,22,28,0.78), rgba(14,14,18,0.72));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 14px;
        box-shadow:
          0 16px 40px rgba(0,0,0,0.46),
          inset 0 1px 0 rgba(255,255,255,0.08);
        backdrop-filter: blur(22px) saturate(150%);
        -webkit-backdrop-filter: blur(22px) saturate(150%);
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro", sans-serif;
        color: rgba(245,245,247,0.94);
        opacity: 0;
        transform: translateY(-4px) scale(0.98);
        transition:
          opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 2147483647;
      }
      .hl-note-editor[data-visible="1"] {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .hl-note-editor::before {
        content: "";
        position: absolute;
        inset: auto -20% -40% auto;
        width: 160px;
        height: 160px;
        background: radial-gradient(closest-side, ${accent}30, transparent 70%);
        filter: blur(28px);
        pointer-events: none;
        border-radius: inherit;
      }
      .hl-note-head {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(245,245,247,0.62);
        position: relative;
      }
      .hl-note-head svg { width: 12px; height: 12px; stroke: ${accent}; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; fill: none; }
      .hl-note-quote {
        position: relative;
        font-size: 11px;
        line-height: 1.45;
        color: rgba(245,245,247,0.72);
        padding: 6px 8px 6px 10px;
        border-left: 2px solid ${accent}aa;
        background: rgba(255,255,255,0.04);
        border-radius: 4px;
        max-height: 48px;
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .hl-note-textarea {
        all: unset;
        position: relative;
        display: block;
        box-sizing: border-box;
        width: 100%;
        min-height: 72px;
        max-height: 200px;
        padding: 8px 10px;
        font-family: inherit;
        font-size: 12.5px;
        line-height: 1.45;
        letter-spacing: -0.01em;
        color: rgba(245,245,247,0.96);
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 8px;
        resize: vertical;
        transition:
          border-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hl-note-textarea::placeholder { color: rgba(245,245,247,0.38); }
      .hl-note-textarea:focus { border-color: ${accent}aa; box-shadow: 0 0 0 2px ${accent}55; }
      .hl-note-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        position: relative;
      }
      .hl-note-btn-action {
        all: unset;
        cursor: pointer;
        font-family: inherit;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: -0.01em;
        padding: 6px 12px;
        border-radius: 8px;
        color: rgba(245,245,247,0.78);
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .hl-note-btn-action:hover { background: rgba(255,255,255,0.10); color: rgba(245,245,247,0.96); }
      .hl-note-btn-action:focus-visible { box-shadow: 0 0 0 2px ${accent}99; }
      .hl-note-btn-action[data-variant="primary"] {
        background: ${accent};
        border-color: transparent;
        color: #0c0c10;
        font-weight: 600;
      }
      .hl-note-btn-action[data-variant="primary"]:hover { transform: translateY(-1px); filter: brightness(1.06); }
      .hl-note-btn-action[data-variant="danger"]:hover { color: #ff9a9a; background: rgba(255,154,154,0.10); }

      /* ---- Liquid-glass control panel ------------------------------ */
      .pill .gear {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin-left: 2px;
        border-radius: 999px;
        cursor: pointer;
        color: rgba(245,245,247,0.78);
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .pill .gear:hover { background: rgba(255,255,255,0.10); color: rgba(245,245,247,0.98); transform: rotate(22deg); }
      .pill .gear:focus-visible { background: rgba(255,255,255,0.10); box-shadow: 0 0 0 2px ${accent}99; }
      .pill .gear svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; fill: none; }
      .pill[data-panel-open="1"] .gear { color: ${accent}; background: rgba(255,255,255,0.08); }

      .panel {
        position: fixed;
        top: 60px;
        right: 16px;
        width: 296px;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro", sans-serif;
        font-size: 12px;
        letter-spacing: -0.01em;
        line-height: 1.45;
        color: rgba(245,245,247,0.94);
        background: linear-gradient(180deg, rgba(22,22,28,0.72), rgba(14,14,18,0.64));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 18px;
        box-shadow:
          0 24px 56px rgba(0,0,0,0.42),
          inset 0 1px 0 rgba(255,255,255,0.08);
        backdrop-filter: blur(24px) saturate(150%);
        -webkit-backdrop-filter: blur(24px) saturate(150%);
        overflow: hidden;
        opacity: 0;
        transform: translateY(-6px) scale(0.98);
        transform-origin: top right;
        transition:
          opacity 220ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 2147483646;
      }
      .panel[data-visible="1"] {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
      .panel::before {
        content: "";
        position: absolute;
        inset: auto -30% -40% auto;
        width: 260px;
        height: 260px;
        background: radial-gradient(closest-side, ${accent}30, transparent 70%);
        filter: blur(36px);
        pointer-events: none;
      }
      .panel-head {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 14px 16px 10px;
        font-size: 10.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: rgba(245,245,247,0.62);
        border-bottom: 1px solid rgba(255,255,255,0.06);
        position: relative;
      }
      .panel-head svg { width: 14px; height: 14px; stroke: ${accent}; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; fill: none; }
      .panel-head .panel-title { flex: 1; }
      .panel-head .panel-close {
        all: unset;
        cursor: pointer;
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        color: rgba(245,245,247,0.62);
        transition: background 180ms cubic-bezier(0.16, 1, 0.3, 1), color 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .panel-close:hover { background: rgba(255,255,255,0.08); color: rgba(245,245,247,0.94); }
      .panel-close:focus-visible { box-shadow: 0 0 0 2px ${accent}99; }
      .panel-close svg { width: 12px; height: 12px; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; fill: none; }

      .panel-body { padding: 12px 16px 16px; position: relative; }
      .panel-section { padding: 8px 0; }
      .panel-section + .panel-section { border-top: 1px solid rgba(255,255,255,0.05); }
      .panel-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .panel-label { font-size: 11px; color: rgba(245,245,247,0.62); font-weight: 500; }
      .panel-value {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10.5px;
        padding: 2px 8px;
        border-radius: 999px;
        color: rgba(245,245,247,0.86);
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        min-width: 52px;
        text-align: center;
      }

      .panel input[type="range"] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 22px;
        background: transparent;
        margin: 0;
        cursor: pointer;
      }
      .panel input[type="range"]::-webkit-slider-runnable-track {
        height: 4px;
        border-radius: 999px;
        background: linear-gradient(90deg, ${accent}cc 0%, ${accent}cc var(--p, 0%), rgba(255,255,255,0.10) var(--p, 0%), rgba(255,255,255,0.10) 100%);
      }
      .panel input[type="range"]::-moz-range-track {
        height: 4px;
        border-radius: 999px;
        background: rgba(255,255,255,0.10);
      }
      .panel input[type="range"]::-moz-range-progress {
        height: 4px;
        border-radius: 999px;
        background: ${accent}cc;
      }
      .panel input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #fff;
        margin-top: -5px;
        box-shadow: 0 2px 6px rgba(0,0,0,0.40), 0 0 0 1px rgba(0,0,0,0.20);
        transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .panel input[type="range"]::-moz-range-thumb {
        width: 14px;
        height: 14px;
        border: none;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.40), 0 0 0 1px rgba(0,0,0,0.20);
      }
      .panel input[type="range"]:hover::-webkit-slider-thumb { transform: scale(1.12); }
      .panel input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px ${accent}66; }

      .panel .segmented {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        gap: 0;
        padding: 3px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.06);
        border-radius: 10px;
      }
      .panel .segmented button {
        all: unset;
        cursor: pointer;
        padding: 6px 0;
        text-align: center;
        font-size: 11.5px;
        font-weight: 500;
        color: rgba(245,245,247,0.66);
        border-radius: 8px;
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          box-shadow 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .panel .segmented button:hover { color: rgba(245,245,247,0.92); }
      .panel .segmented button:focus-visible { box-shadow: 0 0 0 2px ${accent}99; }
      .panel .segmented button[data-active="1"] {
        background: linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05));
        color: rgba(245,245,247,0.98);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.12),
          0 1px 2px rgba(0,0,0,0.30);
      }
      .seg-sans { font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
      .seg-serif { font-family: "Iowan Old Style", Charter, Georgia, serif; }
      .seg-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
      .seg-syntax-noir,
      .seg-syntax-paper,
      .seg-syntax-neon { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; letter-spacing: 0; }
      .seg-syntax-noir::before,
      .seg-syntax-paper::before,
      .seg-syntax-neon::before {
        content: "";
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 2px;
        margin-right: 6px;
        vertical-align: -1px;
        box-shadow: 0 0 0 1px rgba(255,255,255,0.18) inset;
      }
      .seg-syntax-noir::before  { background: linear-gradient(135deg, #1d1f2a 40%, #6c7cff 100%); }
      .seg-syntax-paper::before { background: linear-gradient(135deg, #f6f1e6 40%, #b76b2c 100%); }
      .seg-syntax-neon::before  { background: linear-gradient(135deg, #0b0f1a 40%, #00ffd0 100%); box-shadow: 0 0 6px rgba(0,255,208,0.55), 0 0 0 1px rgba(255,255,255,0.18) inset; }

      .panel-actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      .panel-actions button {
        all: unset;
        flex: 1;
        cursor: pointer;
        padding: 9px 10px;
        text-align: center;
        font-size: 11.5px;
        font-weight: 500;
        color: rgba(245,245,247,0.86);
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .panel-actions button:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.14); }
      .panel-actions button .btn-icon {
        width: 13px;
        height: 13px;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
        vertical-align: -2px;
        margin-right: 6px;
      }
      .panel-actions button:focus-visible { box-shadow: 0 0 0 2px ${accent}99; }
      .panel-actions .primary {
        background: linear-gradient(180deg, ${accent}33, ${accent}1c);
        border-color: ${accent}55;
        color: rgba(245,245,247,0.98);
      }
      .panel-actions .primary:hover { background: linear-gradient(180deg, ${accent}44, ${accent}22); border-color: ${accent}88; }

      .panel-foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-top: 12px;
        padding-top: 10px;
        border-top: 1px solid rgba(255,255,255,0.05);
        color: rgba(245,245,247,0.52);
        font-size: 10.5px;
      }
      .panel-foot .kbd {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.08);
        color: rgba(245,245,247,0.74);
      }
      @media (prefers-reduced-motion: reduce) {
        .panel, .panel input[type="range"]::-webkit-slider-thumb,
        .panel .segmented button, .panel-actions button, .pill .gear {
          transition: none !important;
        }
      }
      @media (max-width: 720px) {
        .panel { width: calc(100vw - 32px); right: 16px; left: 16px; }
      }
      /* Inline image lightbox with zoom + pan. Liquid-glass chrome,
         frosted backdrop, accent-tinted ambient blob. */
      .lightbox {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        pointer-events: none;
        opacity: 0;
        transition: opacity 200ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .lightbox[data-visible="1"] {
        opacity: 1;
        pointer-events: auto;
      }
      .lightbox-backdrop {
        position: absolute;
        inset: 0;
        background: radial-gradient(120% 80% at 50% 40%, rgba(8,8,12,0.78), rgba(0,0,0,0.92));
        backdrop-filter: blur(28px) saturate(140%);
        -webkit-backdrop-filter: blur(28px) saturate(140%);
        cursor: zoom-out;
      }
      .lightbox-backdrop::before {
        content: "";
        position: absolute;
        inset: -10% -20% auto auto;
        width: 60vmax;
        height: 60vmax;
        background: radial-gradient(closest-side, ${accent}33, transparent 70%);
        filter: blur(48px);
        pointer-events: none;
      }
      .lightbox-stage {
        position: absolute;
        inset: 56px 56px 96px;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        user-select: none;
        touch-action: none;
      }
      .lightbox-img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 10px;
        box-shadow: 0 30px 80px rgba(0,0,0,0.55);
        transform: translate(0px, 0px) scale(1);
        transform-origin: center center;
        transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
        cursor: zoom-in;
        will-change: transform;
      }
      .lightbox-img[data-zoom-gt-one="1"] {
        cursor: grab;
        max-width: none;
        max-height: none;
      }
      .lightbox-img[data-dragging="1"] {
        cursor: grabbing;
        transition: none;
      }
      .lightbox-bar {
        position: absolute;
        bottom: 24px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        background: linear-gradient(180deg, rgba(22,22,28,0.72), rgba(14,14,18,0.62));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        box-shadow:
          0 18px 48px rgba(0,0,0,0.45),
          inset 0 1px 0 rgba(255,255,255,0.06);
        backdrop-filter: blur(20px) saturate(140%);
        -webkit-backdrop-filter: blur(20px) saturate(140%);
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
        font-size: 12px;
        letter-spacing: -0.01em;
        color: rgba(245,245,247,0.92);
      }
      .lb-sep {
        width: 1px;
        height: 18px;
        background: rgba(255,255,255,0.12);
        margin: 0 2px;
      }
      .lb-zoom {
        min-width: 52px;
        text-align: center;
        font-variant-numeric: tabular-nums;
        color: rgba(245,245,247,0.72);
      }
      .lb-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 999px;
        color: rgba(245,245,247,0.92);
        cursor: pointer;
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .lb-btn svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .lb-btn:hover { background: rgba(255,255,255,0.08); }
      .lb-btn:focus-visible {
        outline: none;
        border-color: ${accent}99;
        box-shadow: 0 0 0 2px ${accent}55;
      }
      .lb-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .lightbox-caption {
        position: absolute;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        max-width: min(720px, calc(100vw - 96px));
        padding: 8px 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif;
        font-size: 12.5px;
        letter-spacing: -0.01em;
        line-height: 1.45;
        color: rgba(245,245,247,0.82);
        background: linear-gradient(180deg, rgba(22,22,28,0.66), rgba(14,14,18,0.56));
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        text-align: center;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .lightbox-caption[data-empty="1"] { display: none; }
      @media (max-width: 720px) {
        .lightbox-stage { inset: 40px 16px 88px; }
        .lightbox-caption { top: 10px; max-width: calc(100vw - 32px); }
      }

      /* ---- Search-in-page overlay -------------------------------------- */
      .search {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translate(-50%, -10px);
        z-index: 2147483646;
        opacity: 0;
        pointer-events: none;
        transition:
          opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
          transform 200ms cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif;
      }
      .search[data-visible="1"] {
        opacity: 1;
        transform: translate(-50%, 0);
        pointer-events: auto;
      }
      .search-glass {
        position: relative;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px 8px 14px;
        min-width: 420px;
        max-width: min(560px, calc(100vw - 48px));
        background: linear-gradient(180deg, rgba(22,22,28,0.72), rgba(14,14,18,0.62));
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 999px;
        box-shadow:
          0 20px 56px rgba(0,0,0,0.42),
          inset 0 1px 0 rgba(255,255,255,0.06);
        backdrop-filter: blur(22px) saturate(150%);
        -webkit-backdrop-filter: blur(22px) saturate(150%);
        overflow: hidden;
        color: rgba(245,245,247,0.92);
        font-size: 13px;
        letter-spacing: -0.01em;
      }
      .search-blob {
        position: absolute;
        inset: -50% -20% auto auto;
        width: 220px;
        height: 220px;
        background: radial-gradient(closest-side, ${accent}40, transparent 70%);
        filter: blur(28px);
        pointer-events: none;
      }
      .search-icon {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        stroke: ${accent};
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .search-input {
        flex: 1 1 auto;
        min-width: 0;
        padding: 4px 0;
        background: transparent;
        border: 0;
        outline: none;
        color: rgba(245,245,247,0.96);
        font: inherit;
        letter-spacing: -0.01em;
        line-height: 1.4;
      }
      .search-input::placeholder { color: rgba(245,245,247,0.46); }
      .search-input::-webkit-search-cancel-button { display: none; }
      .search-count {
        flex: 0 0 auto;
        min-width: 46px;
        text-align: right;
        font-variant-numeric: tabular-nums;
        color: rgba(245,245,247,0.66);
        font-size: 12px;
      }
      .search-count[data-empty="1"] { color: rgba(255,140,140,0.78); }
      .search-sep {
        flex: 0 0 auto;
        width: 1px;
        height: 18px;
        background: rgba(255,255,255,0.12);
      }
      .search-btn {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 999px;
        color: rgba(245,245,247,0.88);
        cursor: pointer;
        transition:
          background 180ms cubic-bezier(0.16, 1, 0.3, 1),
          border-color 180ms cubic-bezier(0.16, 1, 0.3, 1),
          color 180ms cubic-bezier(0.16, 1, 0.3, 1);
      }
      .search-btn svg {
        width: 14px;
        height: 14px;
        stroke: currentColor;
        stroke-width: 1.6;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      .search-btn:hover { background: rgba(255,255,255,0.08); color: rgba(245,245,247,0.98); }
      .search-btn:focus-visible {
        outline: none;
        border-color: ${accent}99;
        box-shadow: 0 0 0 2px ${accent}55;
      }
      .search-btn:disabled { opacity: 0.36; cursor: not-allowed; }
      [data-doc-reader-theme="light"] .search-glass {
        background: linear-gradient(180deg, rgba(255,255,255,0.86), rgba(248,248,250,0.78));
        border-color: rgba(0,0,0,0.08);
        color: rgba(20,20,24,0.92);
        box-shadow:
          0 18px 48px rgba(0,0,0,0.18),
          inset 0 1px 0 rgba(255,255,255,0.7);
      }
      [data-doc-reader-theme="light"] .search-input { color: rgba(20,20,24,0.96); }
      [data-doc-reader-theme="light"] .search-input::placeholder { color: rgba(20,20,24,0.42); }
      [data-doc-reader-theme="light"] .search-count { color: rgba(20,20,24,0.6); }
      [data-doc-reader-theme="light"] .search-sep { background: rgba(0,0,0,0.10); }
      [data-doc-reader-theme="light"] .search-btn { color: rgba(20,20,24,0.84); }
      [data-doc-reader-theme="light"] .search-btn:hover { background: rgba(0,0,0,0.06); }
      @media (max-width: 720px) {
        .search-glass { min-width: 0; width: calc(100vw - 32px); }
      }
    `;
    const progress = document.createElement("div");
    progress.className = "progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Reading progress");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.setAttribute("aria-valuenow", "0");
    progress.innerHTML = `<div class="progress-fill"></div>`;

    const pill = document.createElement("div");
    pill.className = "pill";
    pill.setAttribute("data-state", "off");
    pill.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span class="label">Reader off</span>
      <span class="kbd" aria-hidden="true">⇧R</span>
      <button type="button" class="gear" aria-label="Reader settings" aria-expanded="false" title="Settings (C)">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9 1.7 1.7 0 0 0 4.26 7.13l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15z" />
        </svg>
      </button>
    `;

    const toc = document.createElement("nav");
    toc.className = "toc";
    toc.setAttribute("aria-label", "Document outline");
    toc.innerHTML = `
      <div class="toc-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h10" />
          <path d="M4 12h16" />
          <path d="M4 18h7" />
          <circle cx="18" cy="6" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="15" cy="18" r="1.2" fill="currentColor" stroke="none" />
        </svg>
        <span>On this page</span>
      </div>
      <ul class="toc-list" role="list"></ul>
    `;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Reader settings");
    panel.setAttribute("aria-hidden", "true");
    panel.innerHTML = `
      <header class="panel-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 5h11" />
          <path d="M4 10h11" />
          <path d="M4 15h7" />
          <path d="M16 17l2.5 2.5L22 16" />
        </svg>
        <span class="panel-title">Reader settings</span>
        <button type="button" class="panel-close" aria-label="Close settings" title="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12" />
            <path d="M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div class="panel-body">
        <div class="panel-section" data-pane="width">
          <div class="panel-row">
            <span class="panel-label">Width</span>
            <span class="panel-value" data-out="width">${WIDTH_DEFAULT}px</span>
          </div>
          <input type="range" class="panel-slider" data-ctl="width"
            min="${WIDTH_MIN}" max="${WIDTH_MAX}" step="${WIDTH_STEP}" value="${WIDTH_DEFAULT}"
            aria-label="Maximum column width" />
        </div>
        <div class="panel-section" data-pane="font-size">
          <div class="panel-row">
            <span class="panel-label">Font size</span>
            <span class="panel-value" data-out="font-size">${FONT_DEFAULT}px</span>
          </div>
          <input type="range" class="panel-slider" data-ctl="font-size"
            min="${FONT_MIN}" max="${FONT_MAX}" step="${FONT_STEP}" value="${FONT_DEFAULT}"
            aria-label="Font size" />
        </div>
        <div class="panel-section" data-pane="line-height">
          <div class="panel-row">
            <span class="panel-label">Line height</span>
            <span class="panel-value" data-out="line-height">${LH_DEFAULT.toFixed(2)}</span>
          </div>
          <input type="range" class="panel-slider" data-ctl="line-height"
            min="${LH_MIN}" max="${LH_MAX}" step="${LH_STEP}" value="${LH_DEFAULT}"
            aria-label="Line height" />
        </div>
        <div class="panel-section" data-pane="family">
          <div class="panel-row">
            <span class="panel-label">Typeface</span>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Typeface">
            ${FAMILIES.map((f) => `
              <button type="button" class="seg-${f.id}" role="radio" aria-checked="false" data-family="${f.id}">${f.label}</button>
            `).join("")}
          </div>
        </div>
        <div class="panel-section" data-pane="syntax">
          <div class="panel-row">
            <span class="panel-label">Syntax theme</span>
          </div>
          <div class="segmented" role="radiogroup" aria-label="Syntax theme">
            ${SYNTAX_THEMES.map((t) => `
              <button type="button" class="seg-syntax-${t.id}" role="radio" aria-checked="false" data-syntax="${t.id}">${t.label}</button>
            `).join("")}
          </div>
        </div>
        <div class="panel-actions">
          <button type="button" data-action="reset">Reset</button>
          <button type="button" data-action="export-md" title="Export to Markdown (Shift+M)">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon">
              <path d="M12 4v11" />
              <path d="M7 11l5 5 5-5" />
              <path d="M5 20h14" />
            </svg>
            <span>Markdown</span>
          </button>
          <button type="button" data-action="export-highlights" title="Export highlights + notes (Shift+H)">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon">
              <path d="M14 3l7 7-9 9H5v-7l9-9z" />
              <path d="M11 6l7 7" />
              <path d="M5 19l-2 2" />
            </svg>
            <span>Highlights</span>
          </button>
          <button type="button" data-action="toggle-focus" title="Focus mode (Shift+F)" aria-pressed="false">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="btn-icon">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 4v2" />
              <path d="M12 18v2" />
              <path d="M4 12h2" />
              <path d="M18 12h2" />
            </svg>
            <span>Focus</span>
          </button>
          <button type="button" class="primary" data-action="close">Done</button>
        </div>
        <div class="panel-foot">
          <span>Toggle panel</span>
          <span class="kbd">C</span>
        </div>
        <div class="panel-foot">
          <span>Focus mode</span>
          <span class="kbd">⇧ F</span>
        </div>
        <div class="panel-foot">
          <span>Export Markdown</span>
          <span class="kbd">⇧ M</span>
        </div>
        <div class="panel-foot">
          <span>Export Highlights</span>
          <span class="kbd">⇧ H</span>
        </div>
      </div>
    `;

    const search = document.createElement("section");
    search.className = "search";
    search.setAttribute("role", "search");
    search.setAttribute("aria-label", "Search in page");
    search.setAttribute("aria-hidden", "true");
    search.innerHTML = `
      <div class="search-glass">
        <span class="search-blob" aria-hidden="true"></span>
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4-4" />
        </svg>
        <input type="search" class="search-input" autocomplete="off" autocorrect="off" spellcheck="false"
          aria-label="Search in page" placeholder="Search in page" />
        <span class="search-count" data-search-count aria-live="polite">0/0</span>
        <span class="search-sep" aria-hidden="true"></span>
        <button type="button" class="search-btn" data-search="prev" aria-label="Previous match" title="Previous (⇧ Enter)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button type="button" class="search-btn" data-search="next" aria-label="Next match" title="Next (Enter)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        <span class="search-sep" aria-hidden="true"></span>
        <button type="button" class="search-btn" data-search="close" aria-label="Close search" title="Close (Esc)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12" /><path d="M18 6L6 18" /></svg>
        </button>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(progress);
    shadow.appendChild(toc);
    shadow.appendChild(pill);
    shadow.appendChild(panel);
    shadow.appendChild(search);

    const lightbox = document.createElement("div");
    lightbox.className = "lightbox";
    lightbox.setAttribute("role", "dialog");
    lightbox.setAttribute("aria-modal", "true");
    lightbox.setAttribute("aria-label", "Image viewer");
    lightbox.setAttribute("aria-hidden", "true");
    lightbox.innerHTML = `
      <div class="lightbox-backdrop" data-lightbox-close="1"></div>
      <div class="lightbox-stage" data-lightbox-stage>
        <img class="lightbox-img" alt="" draggable="false" />
      </div>
      <div class="lightbox-bar">
        <button type="button" class="lb-btn" data-lb="zoom-out" aria-label="Zoom out" title="Zoom out (-)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M8 11h6"/><path d="M20 20l-4-4"/></svg>
        </button>
        <span class="lb-zoom" data-lb-zoom>100%</span>
        <button type="button" class="lb-btn" data-lb="zoom-in" aria-label="Zoom in" title="Zoom in (+)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6"/><path d="M8 11h6"/><path d="M11 8v6"/><path d="M20 20l-4-4"/></svg>
        </button>
        <span class="lb-sep" aria-hidden="true"></span>
        <button type="button" class="lb-btn" data-lb="reset" aria-label="Reset zoom" title="Reset (0)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.34-5.66"/><path d="M4 4v4h4"/></svg>
        </button>
        <button type="button" class="lb-btn" data-lb="close" aria-label="Close" title="Close (Esc)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="lightbox-caption" data-lb-caption data-empty="1"></div>
    `;
    shadow.appendChild(lightbox);

    const minimap = document.createElement("aside");
    minimap.className = "minimap";
    minimap.setAttribute("aria-label", "Document mini-map");
    minimap.setAttribute("role", "navigation");
    minimap.innerHTML = `
      <div class="minimap-track" data-mm-track></div>
      <div class="minimap-viewport" data-mm-viewport></div>
    `;
    shadow.appendChild(minimap);
    wireMinimap(shadow);

    wirePanel(shadow);
    wireLightbox(shadow);
    wireSearch(shadow);
  }

  // ---- Control panel wiring ----------------------------------------------
  let panelDocClickAttached = false;
  function wirePanel(shadow) {
    const panel = shadow.querySelector(".panel");
    const pill = shadow.querySelector(".pill");
    if (!panel || !pill) return;
    const gear = pill.querySelector(".gear");
    gear?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    panel.querySelector(".panel-close")?.addEventListener("click", (e) => {
      e.preventDefault();
      hidePanel();
    });
    panel.querySelector('[data-action="close"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      hidePanel();
    });
    panel.querySelector('[data-action="reset"]')?.addEventListener("click", async (e) => {
      e.preventDefault();
      await Promise.all([
        setWidth(WIDTH_DEFAULT),
        setFontSize(FONT_DEFAULT),
        setLineHeight(LH_DEFAULT),
        setFontFamily(FAMILY_DEFAULT),
        setSyntaxTheme(SYNTAX_THEME_DEFAULT),
      ]);
      syncPanel();
    });
    panel.querySelector('[data-action="toggle-focus"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      toggleFocusMode();
    });
    panel.querySelector('[data-action="export-md"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      exportArticleToMarkdown();
    });
    panel.querySelector('[data-action="export-highlights"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      exportHighlightsToMarkdown();
    });
    panel.querySelectorAll(".panel-slider").forEach((slider) => {
      slider.addEventListener("input", () => {
        const ctl = slider.getAttribute("data-ctl");
        const v = parseFloat(slider.value);
        if (!Number.isFinite(v)) return;
        if (ctl === "width") setWidth(v);
        else if (ctl === "font-size") setFontSize(v);
        else if (ctl === "line-height") setLineHeight(v);
        syncPanel();
      });
    });
    panel.querySelectorAll('.segmented button[data-family]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = btn.getAttribute("data-family");
        if (id) setFontFamily(id).then(syncPanel);
      });
    });
    panel.querySelectorAll('.segmented button[data-syntax]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const id = btn.getAttribute("data-syntax");
        if (id) setSyntaxTheme(id).then(syncPanel);
      });
    });
    // Click-outside closes the panel.
    if (!panelDocClickAttached) {
      document.addEventListener("mousedown", onPanelOutsideClick, true);
      panelDocClickAttached = true;
    }
  }

  function onPanelOutsideClick(e) {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    const panel = shadow?.querySelector(".panel");
    if (!panel || panel.getAttribute("data-visible") !== "1") return;
    // The composed path crosses the shadow boundary so we can check both
    // the panel and the gear button without leaking selectors.
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const node of path) {
      if (node === panel) return;
      if (node instanceof Element && node.classList?.contains("gear")) return;
    }
    hidePanel();
  }

  function showPanel() {
    if (!state.enabled) return;
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    const panel = shadow?.querySelector(".panel");
    const pill = shadow?.querySelector(".pill");
    const gear = pill?.querySelector(".gear");
    if (!panel) return;
    syncPanel();
    panel.setAttribute("data-visible", "1");
    panel.setAttribute("aria-hidden", "false");
    pill?.setAttribute("data-panel-open", "1");
    gear?.setAttribute("aria-expanded", "true");
    // Keep pill visible while panel is open.
    pill?.setAttribute("data-visible", "1");
    clearTimeout(pillHideTimer);
  }

  function hidePanel() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    const panel = shadow?.querySelector(".panel");
    const pill = shadow?.querySelector(".pill");
    const gear = pill?.querySelector(".gear");
    if (!panel) return;
    panel.removeAttribute("data-visible");
    panel.setAttribute("aria-hidden", "true");
    pill?.removeAttribute("data-panel-open");
    gear?.setAttribute("aria-expanded", "false");
    // Let the pill auto-hide on its usual timer.
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(() => pill?.removeAttribute("data-visible"), 900);
  }

  function togglePanel() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const panel = root?.shadowRoot?.querySelector(".panel");
    if (!panel) return;
    if (panel.getAttribute("data-visible") === "1") hidePanel();
    else showPanel();
  }

  function syncPanel() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    const panel = shadow?.querySelector(".panel");
    if (!panel) return;

    const setSlider = (ctl, value, format) => {
      const slider = panel.querySelector(`.panel-slider[data-ctl="${ctl}"]`);
      const out = panel.querySelector(`.panel-value[data-out="${ctl}"]`);
      if (slider) {
        if (parseFloat(slider.value) !== value) slider.value = String(value);
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
        slider.style.setProperty("--p", `${pct.toFixed(2)}%`);
      }
      if (out) out.textContent = format(value);
    };

    setSlider("width", state.width, (v) => `${Math.round(v)}px`);
    setSlider("font-size", state.fontSize, (v) => `${v}px`);
    setSlider("line-height", state.lineHeight, (v) => v.toFixed(2));

    panel.querySelectorAll('.segmented button[data-family]').forEach((btn) => {
      const active = btn.getAttribute("data-family") === state.fontFamily;
      btn.setAttribute("aria-checked", active ? "true" : "false");
      if (active) btn.setAttribute("data-active", "1");
      else btn.removeAttribute("data-active");
    });
    panel.querySelectorAll('.segmented button[data-syntax]').forEach((btn) => {
      const active = btn.getAttribute("data-syntax") === state.syntaxTheme;
      btn.setAttribute("aria-checked", active ? "true" : "false");
      if (active) btn.setAttribute("data-active", "1");
      else btn.removeAttribute("data-active");
    });
    const focusBtn = panel.querySelector('[data-action="toggle-focus"]');
    if (focusBtn) {
      focusBtn.setAttribute("aria-pressed", state.focus ? "true" : "false");
      if (state.focus) focusBtn.setAttribute("data-active", "1");
      else focusBtn.removeAttribute("data-active");
    }
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
      state.theme = detectPreferredTheme();
      applyTheme();
      applyWidth();
      applyTypography();
      root.removeAttribute("hidden");
      stripNoise();
      applySingleColumn();
      syncPanel();
      buildToc();
      watchArticleForToc();
      startProgress();
      scheduleHighlightRestore();
      if (state.focus) startFocusMode();
      startResumeTracking();
      tryResumePosition();
    } else {
      stopResumeTracking();
      stopProgress();
      stopFocusMode();
      hidePanel();
      hideToc();
      hidePalette();
      closeSearch();
      clearAllHighlightMarks();
      restoreSingleColumn();
      restoreNoise();
      document.documentElement.classList.remove(ACTIVE_CLASS);
      applyTheme();
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

  // ---- Typography (font size + line-height) -------------------------------
  function applyTypography() {
    const root = document.documentElement;
    root.style.setProperty("--doc-reader-font-size", `${state.fontSize}px`);
    root.style.setProperty("--doc-reader-line-height", String(state.lineHeight));
    root.style.setProperty("--doc-reader-font-family", familyStack(state.fontFamily));
    root.setAttribute("data-doc-reader-family", clampFamily(state.fontFamily));
    root.setAttribute("data-doc-reader-syntax", clampSyntaxTheme(state.syntaxTheme));
  }

  function applySingleColumn() {
    if (!state.supported) return;
    restoreSingleColumn();
    let el = null;
    try { el = document.querySelector(site.article); } catch { el = null; }
    if (!el) return;
    articleEl = el;
    // Refresh progress bar bindings if it's already running.
    if (state.enabled && progressScrollAttached) {
      if (progressResizeObs) { try { progressResizeObs.disconnect(); } catch {} progressResizeObs = null; }
      if (typeof ResizeObserver !== "undefined") {
        try {
          progressResizeObs = new ResizeObserver(() => scheduleProgress());
          progressResizeObs.observe(el);
        } catch { progressResizeObs = null; }
      }
      scheduleProgress();
    }
    el.setAttribute(ARTICLE_ATTR, "1");
    ancestorEls = [];
    for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
      n.setAttribute(ANCESTOR_ATTR, "1");
      ancestorEls.push(n);
    }
    ensureReadingMeta();
    ensureCopyButtons();
    ensureImageEnhancements();
    ensureSectionToggles();
  }

  function restoreSingleColumn() {
    removeReadingMeta();
    removeCopyButtons();
    removeSectionToggles();
    if (articleEl) {
      try { articleEl.removeAttribute(ARTICLE_ATTR); } catch { /* detached */ }
      articleEl = null;
    }
    for (const n of ancestorEls) {
      try { n.removeAttribute(ANCESTOR_ATTR); } catch { /* detached */ }
    }
    ancestorEls = [];
  }

  // ---- Estimated reading time --------------------------------------------
  // Renders a small liquid-glass meta strip at the top of the article showing
  // word count + minutes-to-read estimate. Idempotent: re-rendering only
  // touches the DOM when the numbers actually change, so the article-level
  // MutationObserver doesn't loop on itself.
  function countArticleWords() {
    if (!articleEl) return 0;
    let text = "";
    const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest(`[${META_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
        if (p.closest(`[${HIDE_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
        if (p.closest("pre, code, script, style, noscript")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      text += " " + (n.nodeValue || "");
      n = walker.nextNode();
    }
    const matches = text.match(/[\p{L}\p{N}][\p{L}\p{N}'\-]*/gu);
    return matches ? matches.length : 0;
  }

  function readingMinutes(words) {
    if (!Number.isFinite(words) || words <= 0) return 0;
    return Math.max(1, Math.round(words / READ_WPM));
  }

  function ensureReadingMeta() {
    if (!state.enabled || !articleEl || !articleEl.isConnected) return;
    const words = countArticleWords();
    const minutes = readingMinutes(words);
    let meta = articleEl.querySelector(`:scope > [${META_ATTR}="1"]`);
    if (!meta) {
      meta = document.createElement("div");
      meta.setAttribute(META_ATTR, "1");
      meta.setAttribute("role", "note");
      meta.setAttribute("aria-label", "Estimated reading time");
      // Phosphor-style inline SVGs, stroke-width 1.5, no emoji.
      meta.innerHTML = `
        <span class="doc-reader-meta-chip" data-doc-reader-meta-chip="time">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span data-doc-reader-meta-time>1 min read</span>
        </span>
        <span class="doc-reader-meta-sep" aria-hidden="true"></span>
        <span class="doc-reader-meta-chip" data-doc-reader-meta-chip="words">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 6h14" />
            <path d="M5 12h14" />
            <path d="M5 18h9" />
          </svg>
          <span data-doc-reader-meta-words>0 words</span>
        </span>
      `;
      articleEl.insertBefore(meta, articleEl.firstChild);
    }
    const timeEl = meta.querySelector("[data-doc-reader-meta-time]");
    const wordsEl = meta.querySelector("[data-doc-reader-meta-words]");
    const minLabel = `${minutes} min read`;
    const wordsLabel = `${words.toLocaleString()} word${words === 1 ? "" : "s"}`;
    if (timeEl && timeEl.textContent !== minLabel) timeEl.textContent = minLabel;
    if (wordsEl && wordsEl.textContent !== wordsLabel) wordsEl.textContent = wordsLabel;
    if (words === 0) meta.setAttribute("data-empty", "1");
    else meta.removeAttribute("data-empty");
  }

  function removeReadingMeta() {
    if (!articleEl) return;
    const meta = articleEl.querySelector(`:scope > [${META_ATTR}="1"]`);
    if (meta) meta.remove();
  }

  // ---- Copy code button --------------------------------------------------
  // Decorates every <pre> inside the article with a small liquid-glass
  // "Copy" button. Idempotent: re-running won't double-mount the buttons,
  // and re-mounts are no-ops so the article MutationObserver doesn't loop.
  const PRE_ATTR = "data-doc-reader-pre";
  const COPY_ATTR = "data-doc-reader-copy";

  function getPreText(pre) {
    // Read the actual code text, excluding our injected button.
    const codeNode = pre.querySelector("code");
    const src = codeNode || pre;
    let text = "";
    for (const child of src.childNodes) {
      if (child.nodeType === 1 && child.hasAttribute && child.hasAttribute(COPY_ATTR)) continue;
      text += child.textContent || "";
    }
    // Trim trailing newline-only content but keep internal whitespace.
    return text.replace(/\u00a0/g, " ").replace(/\s+$/g, "");
  }

  function flashCopyButton(btn, ok) {
    const label = btn.querySelector("[data-doc-reader-copy-label]");
    const prev = label ? label.textContent : "";
    btn.setAttribute("data-state", ok ? "copied" : "failed");
    if (label) label.textContent = ok ? "Copied" : "Failed";
    setTimeout(() => {
      btn.removeAttribute("data-state");
      if (label) label.textContent = prev || "Copy";
    }, 1400);
  }

  async function copyPreText(pre, btn) {
    const text = getPreText(pre);
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { ok = false; }
    if (!ok) {
      // Fallback for restricted clipboard contexts.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("aria-hidden", "true");
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand && document.execCommand("copy");
        ta.remove();
      } catch { ok = false; }
    }
    flashCopyButton(btn, !!ok);
  }

  function buildCopyButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-reader-copy";
    btn.setAttribute(COPY_ATTR, "1");
    btn.setAttribute("aria-label", "Copy code to clipboard");
    btn.setAttribute("title", "Copy code");
    // Phosphor-style inline SVG: two stacked rounded rects. stroke-width 1.5.
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="8" y="8" width="12" height="12" rx="2.5" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
        <path class="doc-reader-copy-check" d="M11 14l2 2 4-4" />
      </svg>
      <span data-doc-reader-copy-label>Copy</span>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pre = btn.closest("pre");
      if (pre) copyPreText(pre, btn);
    });
    // Don't let inadvertent text selection inside the button bubble up.
    btn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    return btn;
  }

  function ensureCopyButtons() {
    if (!state.enabled || !articleEl || !articleEl.isConnected) return;
    let pres;
    try { pres = articleEl.querySelectorAll("pre"); } catch { return; }
    for (const pre of pres) {
      // Skip pres that are too small (e.g. inline single-token snippets):
      // any pre with non-empty text qualifies.
      const text = (pre.textContent || "").trim();
      if (!text) continue;
      if (pre.getAttribute(PRE_ATTR) === "1" && pre.querySelector(`:scope > [${COPY_ATTR}="1"]`)) continue;
      pre.setAttribute(PRE_ATTR, "1");
      // Remove any stale button (defensive) before mounting a fresh one.
      const stale = pre.querySelector(`:scope > [${COPY_ATTR}="1"]`);
      if (stale) stale.remove();
      pre.appendChild(buildCopyButton());
    }
  }

  function removeCopyButtons() {
    if (!articleEl) return;
    let pres;
    try { pres = articleEl.querySelectorAll(`pre[${PRE_ATTR}="1"]`); } catch { return; }
    for (const pre of pres) {
      const btn = pre.querySelector(`:scope > [${COPY_ATTR}="1"]`);
      if (btn) btn.remove();
      try { pre.removeAttribute(PRE_ATTR); } catch { /* detached */ }
    }
  }

  async function setWidth(next, opts = {}) {
    const v = clampWidth(next);
    state.width = v;
    if (state.enabled) {
      applyWidth();
      flashWidth();
      syncPanel();
    }
    if (opts.persist !== false) persistWidth(v);
    return v;
  }

  async function setFontSize(next, opts = {}) {
    const v = clampFontSize(next);
    state.fontSize = v;
    if (state.enabled) {
      applyTypography();
      flashTypography(`${v}px`);
      syncPanel();
    }
    if (opts.persist !== false) persistFontSize(v);
    return v;
  }

  async function setLineHeight(next, opts = {}) {
    const v = clampLineHeight(next);
    state.lineHeight = v;
    if (state.enabled) {
      applyTypography();
      flashTypography(`line ${v.toFixed(2)}`);
      syncPanel();
    }
    if (opts.persist !== false) persistLineHeight(v);
    return v;
  }

  async function setFontFamily(next, opts = {}) {
    const v = clampFamily(next);
    state.fontFamily = v;
    if (state.enabled) {
      applyTypography();
      flashTypography(familyLabel(v));
      syncPanel();
    }
    if (opts.persist !== false) persistFontFamily(v);
    return v;
  }

  async function setSyntaxTheme(next, opts = {}) {
    const v = clampSyntaxTheme(next);
    state.syntaxTheme = v;
    if (state.enabled) {
      applyTypography();
      flashTypography(`Syntax ${syntaxThemeLabel(v)}`);
      syncPanel();
    }
    if (opts.persist !== false) persistSyntaxTheme(v);
    return v;
  }

  function cycleFontFamily(dir = 1) {
    const i = FAMILY_IDS.indexOf(clampFamily(state.fontFamily));
    const next = FAMILY_IDS[(i + (dir > 0 ? 1 : FAMILY_IDS.length - 1)) % FAMILY_IDS.length];
    return setFontFamily(next);
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

  function flashTypography(text) {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const pill = root?.shadowRoot?.querySelector(".pill");
    if (!pill) return;
    const label = pill.querySelector(".label");
    if (label) label.textContent = text;
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

  // ---- Reading progress indicator ----------------------------------------
  // Thin liquid-glass bar pinned to the top of the viewport. Tracks scroll
  // position from the article's first visible pixel to its last, so the
  // indicator hits 100% when the reader actually finishes the article (not
  // when the host page has more footer below it).
  let progressRafPending = false;
  let progressScrollAttached = false;
  let progressResizeObs = null;
  let progressLastPct = -1;

  function updateProgress() {
    progressRafPending = false;
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const bar = root?.shadowRoot?.querySelector(".progress");
    const fill = root?.shadowRoot?.querySelector(".progress-fill");
    if (!bar || !fill) return;
    if (!state.enabled) {
      bar.removeAttribute("data-visible");
      return;
    }
    const target = articleEl || document.scrollingElement || document.documentElement;
    if (!target) return;
    let pct = 0;
    if (articleEl && articleEl.isConnected) {
      const rect = articleEl.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      // Distance scrolled past the article's top, normalised over the
      // article height minus one viewport (so reaching the bottom of the
      // article in view = 100%).
      const total = Math.max(1, rect.height - vh);
      const passed = Math.min(total, Math.max(0, -rect.top));
      pct = (passed / total) * 100;
    } else {
      const doc = document.documentElement;
      const total = Math.max(1, doc.scrollHeight - window.innerHeight);
      pct = (window.scrollY / total) * 100;
    }
    if (!Number.isFinite(pct)) pct = 0;
    pct = Math.max(0, Math.min(100, pct));
    const rounded = Math.round(pct * 10) / 10; // 0.1% steps — avoids thrash
    if (rounded === progressLastPct) return;
    progressLastPct = rounded;
    fill.style.width = `${rounded}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(rounded)));
    bar.setAttribute("data-visible", "1");
    updateMinimapViewport();
  }

  function scheduleProgress() {
    if (progressRafPending) return;
    progressRafPending = true;
    if (PROGRESS_RAF_THROTTLE && typeof requestAnimationFrame === "function") {
      requestAnimationFrame(updateProgress);
    } else {
      setTimeout(updateProgress, 16);
    }
  }

  function startProgress() {
    if (!progressScrollAttached) {
      window.addEventListener("scroll", scheduleProgress, { passive: true });
      window.addEventListener("resize", scheduleProgress, { passive: true });
      progressScrollAttached = true;
    }
    if (!progressResizeObs && typeof ResizeObserver !== "undefined" && articleEl) {
      try {
        progressResizeObs = new ResizeObserver(() => scheduleProgress());
        progressResizeObs.observe(articleEl);
      } catch { progressResizeObs = null; }
    }
    progressLastPct = -1;
    scheduleProgress();
  }

  function stopProgress() {
    if (progressScrollAttached) {
      window.removeEventListener("scroll", scheduleProgress);
      window.removeEventListener("resize", scheduleProgress);
      progressScrollAttached = false;
    }
    if (progressResizeObs) {
      try { progressResizeObs.disconnect(); } catch {}
      progressResizeObs = null;
    }
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const bar = root?.shadowRoot?.querySelector(".progress");
    const fill = root?.shadowRoot?.querySelector(".progress-fill");
    if (bar) bar.removeAttribute("data-visible");
    if (fill) fill.style.width = "0%";
    progressLastPct = -1;
  }

  // ---- Persistent TOC sidebar (h2/h3) -------------------------------------
  let tocEntries = [];      // [{ id, text, level, el }]
  let tocIO = null;          // IntersectionObserver
  let tocMO = null;          // MutationObserver on article
  let tocRebuildTimer = 0;
  let tocActiveId = null;
  let tocClickGuardUntil = 0;

  function slugify(text, taken) {
    const base = (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 64) || "section";
    let id = `doc-reader-${base}`;
    let i = 2;
    while (taken.has(id)) id = `doc-reader-${base}-${i++}`;
    taken.add(id);
    return id;
  }

  function buildToc() {
    if (!state.supported || !state.enabled) {
      hideToc();
      return;
    }
    const tocSel = site?.toc || "article h2, article h3";
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(tocSel)); } catch { nodes = []; }
    // Visible heading only — skip hidden chrome.
    nodes = nodes.filter((h) => {
      if (!(h instanceof HTMLElement)) return false;
      if (h.closest(`[${HIDE_ATTR}="1"]`)) return false;
      const text = (h.textContent || "").trim();
      return text.length > 0;
    });

    // Tag entries with stable ids; reuse existing id if present.
    const taken = new Set();
    for (const h of nodes) if (h.id) taken.add(h.id);
    const entries = nodes.map((h) => {
      if (!h.id) h.id = slugify(h.textContent.trim(), taken);
      h.setAttribute(HEADING_ATTR, "1");
      return {
        id: h.id,
        text: h.textContent.trim().replace(/\s+/g, " "),
        level: h.tagName === "H3" ? 3 : 2,
        el: h,
      };
    });
    tocEntries = entries;
    renderToc(entries);
    wireTocObserver(entries);
    scheduleMinimapBuild();
    ensureReadingMeta();
    ensureCopyButtons();
    ensureImageEnhancements();
    ensureSectionToggles();
  }

  // ---- Section-collapse toggles on h2 headings ---------------------------
  // Each h2 in the article gets a small liquid-glass chevron button that
  // hides every sibling element until the next h2. Idempotent: re-running
  // skips headings that already have a button mounted. TOC click on an item
  // inside a collapsed section auto-expands its parent.
  function getSectionSiblings(h2) {
    if (!h2 || !h2.parentElement) return [];
    const out = [];
    let n = h2.nextElementSibling;
    while (n) {
      if (n.tagName === "H2") break;
      out.push(n);
      n = n.nextElementSibling;
    }
    return out;
  }

  function buildSectionToggle() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "doc-reader-section-toggle";
    btn.setAttribute(TOGGLE_ATTR, "1");
    btn.setAttribute("aria-label", "Collapse section");
    btn.setAttribute("aria-expanded", "true");
    btn.setAttribute("title", "Collapse section");
    // Phosphor-style chevron, stroke-width 1.5, round caps.
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 9l6 6 6-6" />
      </svg>
    `;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const h2 = btn.closest("h2");
      if (h2) toggleSection(h2);
    });
    btn.addEventListener("mousedown", (e) => { e.stopPropagation(); });
    return btn;
  }

  function toggleSection(h2, force) {
    if (!h2) return;
    const currentlyCollapsed = h2.getAttribute(COLLAPSED_ATTR) === "1";
    const next = typeof force === "boolean" ? force : !currentlyCollapsed;
    if (next === currentlyCollapsed) return;
    const siblings = getSectionSiblings(h2);
    for (const s of siblings) {
      if (next) s.setAttribute(SECTION_HIDDEN_ATTR, "1");
      else s.removeAttribute(SECTION_HIDDEN_ATTR);
    }
    if (next) h2.setAttribute(COLLAPSED_ATTR, "1");
    else h2.removeAttribute(COLLAPSED_ATTR);
    const btn = h2.querySelector(`:scope > [${TOGGLE_ATTR}="1"]`);
    if (btn) {
      btn.setAttribute("aria-expanded", String(!next));
      btn.setAttribute("aria-label", next ? "Expand section" : "Collapse section");
      btn.setAttribute("title", next ? "Expand section" : "Collapse section");
    }
  }

  function ensureSectionToggles() {
    if (!state.enabled || !articleEl || !articleEl.isConnected) return;
    let h2s;
    try { h2s = articleEl.querySelectorAll("h2"); } catch { return; }
    for (const h2 of h2s) {
      if (h2.closest(`[${HIDE_ATTR}="1"]`)) continue;
      if (h2.closest(`[${META_ATTR}="1"]`)) continue;
      if (h2.querySelector(`:scope > [${TOGGLE_ATTR}="1"]`)) continue;
      h2.setAttribute(SECTION_ATTR, "1");
      h2.appendChild(buildSectionToggle());
    }
  }

  function removeSectionToggles() {
    if (!articleEl) return;
    let h2s;
    try { h2s = articleEl.querySelectorAll(`h2[${SECTION_ATTR}="1"]`); } catch { return; }
    for (const h2 of h2s) {
      // Restore any siblings we had hidden.
      if (h2.getAttribute(COLLAPSED_ATTR) === "1") {
        for (const s of getSectionSiblings(h2)) s.removeAttribute(SECTION_HIDDEN_ATTR);
      }
      const btn = h2.querySelector(`:scope > [${TOGGLE_ATTR}="1"]`);
      if (btn) btn.remove();
      h2.removeAttribute(SECTION_ATTR);
      h2.removeAttribute(COLLAPSED_ATTR);
    }
  }

  function expandSectionContaining(target) {
    if (!target || !articleEl) return;
    if (target.tagName === "H2" && target.getAttribute(COLLAPSED_ATTR) === "1") {
      toggleSection(target, false);
      return;
    }
    const hidden = target.closest ? target.closest(`[${SECTION_HIDDEN_ATTR}="1"]`) : null;
    if (!hidden) return;
    // Walk back through previous siblings of the hidden node (and its
    // ancestors at the same level) to find the owning h2.
    let cursor = hidden;
    while (cursor) {
      let prev = cursor.previousElementSibling;
      while (prev) {
        if (prev.tagName === "H2" && prev.getAttribute(COLLAPSED_ATTR) === "1") {
          toggleSection(prev, false);
          return;
        }
        prev = prev.previousElementSibling;
      }
      cursor = cursor.parentElement && articleEl.contains(cursor.parentElement)
        ? cursor.parentElement
        : null;
      if (cursor === articleEl) cursor = null;
    }
  }

  function renderToc(entries) {
    const root = ensureRoot();
    const shadow = root.shadowRoot;
    const toc = shadow?.querySelector(".toc");
    const list = shadow?.querySelector(".toc-list");
    if (!toc || !list) return;
    list.textContent = "";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.innerHTML = `
        <svg viewBox="0 0 64 48" aria-hidden="true">
          <path d="M8 10c10-6 22-6 32 0" />
          <path d="M10 22c10-5 22-5 30 0" />
          <path d="M12 34c8-4 20-4 26 0" />
          <circle cx="52" cy="14" r="4" />
          <path d="M55 17l5 5" />
        </svg>
        <span>No headings on this page</span>
      `;
      list.appendChild(empty);
      toc.setAttribute("data-visible", "1");
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "toc-item";
      li.setAttribute("data-level", String(entry.level));
      const a = document.createElement("a");
      a.className = "toc-link";
      a.href = `#${entry.id}`;
      a.textContent = entry.text;
      a.setAttribute("data-toc-id", entry.id);
      a.addEventListener("click", onTocClick);
      li.appendChild(a);
      frag.appendChild(li);
    }
    list.appendChild(frag);
    toc.setAttribute("data-visible", "1");
    refreshBookmarkMarks();
  }

  function onTocClick(e) {
    e.preventDefault();
    const id = e.currentTarget?.getAttribute("data-toc-id");
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    expandSectionContaining(target);
    tocClickGuardUntil = Date.now() + 700;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveTocId(id);
  }

  function setActiveTocId(id) {
    if (id === tocActiveId) return;
    tocActiveId = id;
    refreshBookmarkMarks();
    refreshMinimapActive();
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const links = root?.shadowRoot?.querySelectorAll(".toc-link");
    if (!links) return;
    for (const a of links) {
      if (a.getAttribute("data-toc-id") === id) a.setAttribute("data-active", "1");
      else a.removeAttribute("data-active");
    }
    const active = root?.shadowRoot?.querySelector('.toc-link[data-active="1"]');
    if (active && typeof active.scrollIntoView === "function") {
      const list = root.shadowRoot.querySelector(".toc-list");
      const aRect = active.getBoundingClientRect();
      const lRect = list?.getBoundingClientRect();
      if (list && lRect && (aRect.top < lRect.top + 20 || aRect.bottom > lRect.bottom - 20)) {
        active.scrollIntoView({ block: "nearest" });
      }
    }
  }

  function wireTocObserver(entries) {
    if (tocIO) { try { tocIO.disconnect(); } catch {} tocIO = null; }
    if (!entries.length || typeof IntersectionObserver === "undefined") return;
    const visible = new Map();
    tocIO = new IntersectionObserver((records) => {
      if (Date.now() < tocClickGuardUntil) return;
      for (const r of records) {
        if (r.isIntersecting) visible.set(r.target.id, r.intersectionRatio);
        else visible.delete(r.target.id);
      }
      if (visible.size === 0) return;
      // Pick first entry currently visible (top-most in source order).
      for (const e of entries) {
        if (visible.has(e.id)) { setActiveTocId(e.id); break; }
      }
    }, { rootMargin: "-72px 0px -60% 0px", threshold: [0, 1] });
    for (const e of entries) {
      try { tocIO.observe(e.el); } catch {}
    }
  }

  // ---- Highlight tool (4 colors, persisted per URL) ----------------------
  // User selects text in the article, palette appears near the selection,
  // pick a color → wraps the selection in a <mark> and persists. On reader
  // re-enable / page reload we walk the article text and restore wrappers
  // using saved offsets + a context fingerprint. Click an existing mark to
  // change color or remove it. Stored under doc-reader:highlights[urlKey].
  let highlights = [];                // active list for current URL
  let highlightById = new Map();      // id -> entry
  let highlightPaletteEl = null;
  let highlightPaletteHideTimer = 0;
  let highlightSelectionRange = null; // current selection inside article
  let highlightTargetId = null;       // when palette is open over a mark
  let highlightRestoreTimer = 0;

  function clampHighlightColor(id) {
    if (typeof id !== "string") return HIGHLIGHT_COLORS[0].id;
    return HIGHLIGHT_COLOR_IDS.includes(id) ? id : HIGHLIGHT_COLORS[0].id;
  }

  function newHighlightId() {
    return `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function articleTextOffset(node, offsetInNode) {
    // Compute the character offset of (node, offsetInNode) from the start
    // of articleEl's textContent. Returns -1 if the node is not inside the
    // current article.
    if (!articleEl || !node) return -1;
    if (!articleEl.contains(node)) return -1;
    const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, null);
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return total + offsetInNode;
      total += n.nodeValue.length;
    }
    // Selection may end at the boundary right after the last text node.
    if (node.nodeType === 1 && articleEl.contains(node)) {
      // Sum textContent up to that element.
      return total;
    }
    return -1;
  }

  function pointFromOffset(targetOffset) {
    // Walk text nodes in articleEl; return {node, offset} for the given
    // character offset, or null if out of range.
    if (!articleEl) return null;
    const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, null);
    let total = 0;
    let n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (targetOffset <= total + len) {
        return { node: n, offset: Math.max(0, targetOffset - total) };
      }
      total += len;
    }
    return null;
  }

  function findOffsetByContext(entry) {
    // Last-resort: search articleEl.textContent for entry.text using the
    // saved before/after context as a fingerprint. Returns start offset or
    // -1 when no confident match exists.
    if (!articleEl) return -1;
    const haystack = articleEl.textContent || "";
    const needle = entry.text || "";
    if (!needle) return -1;
    const before = (entry.before || "").slice(-32);
    const after = (entry.after || "").slice(0, 32);
    const probe = before + needle + after;
    if (probe.length > needle.length) {
      const idx = haystack.indexOf(probe);
      if (idx >= 0) return idx + before.length;
    }
    // Fall back to a unique occurrence of the bare needle.
    const first = haystack.indexOf(needle);
    if (first < 0) return -1;
    const second = haystack.indexOf(needle, first + 1);
    return second < 0 ? first : -1; // ambiguous → bail
  }

  function wrapRangeWithMark(range, color, id) {
    // Wrap the contents of `range` (which may span multiple text nodes)
    // with one or more <mark> elements that share the same id+color.
    // Each text node intersecting the range becomes its own <mark>.
    if (range.collapsed) return false;
    const startContainer = range.startContainer;
    const endContainer = range.endContainer;
    // Collect intersecting text nodes first to avoid live-tree surprises.
    const root = range.commonAncestorContainer;
    const rootEl = root.nodeType === 1 ? root : root.parentNode;
    if (!rootEl) return false;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    if (!nodes.length) return false;
    let wrappedAny = false;
    for (const tn of nodes) {
      let from = 0;
      let to = tn.nodeValue.length;
      if (tn === startContainer) from = range.startOffset;
      if (tn === endContainer) to = range.endOffset;
      if (from >= to) continue;
      // Skip nodes already inside a doc-reader mark — avoid nesting.
      if (tn.parentElement && tn.parentElement.closest(`mark[${HIGHLIGHT_ATTR}="1"]`)) continue;
      // Skip script/style.
      const tag = tn.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      const middle = tn.splitText(from);
      middle.splitText(to - from);
      const mark = document.createElement("mark");
      mark.setAttribute(HIGHLIGHT_ATTR, "1");
      mark.setAttribute(HIGHLIGHT_ID_ATTR, id);
      mark.setAttribute(HIGHLIGHT_COLOR_ATTR, color);
      mark.textContent = middle.nodeValue;
      middle.parentNode.replaceChild(mark, middle);
      wrappedAny = true;
    }
    return wrappedAny;
  }

  function unwrapMarksForId(id) {
    if (!articleEl) return;
    const nodes = articleEl.querySelectorAll(`mark[${HIGHLIGHT_ID_ATTR}="${CSS.escape(id)}"]`);
    for (const m of nodes) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize?.();
    }
  }

  function clearAllHighlightMarks() {
    if (!articleEl) return;
    const nodes = articleEl.querySelectorAll(`mark[${HIGHLIGHT_ATTR}="1"]`);
    for (const m of nodes) {
      const parent = m.parentNode;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize?.();
    }
  }

  function recolorMarksForId(id, color) {
    if (!articleEl) return;
    const nodes = articleEl.querySelectorAll(`mark[${HIGHLIGHT_ID_ATTR}="${CSS.escape(id)}"]`);
    for (const m of nodes) m.setAttribute(HIGHLIGHT_COLOR_ATTR, color);
  }

  function refreshNoteMarksForId(id) {
    if (!articleEl) return;
    const entry = highlightById.get(id);
    const has = !!(entry && entry.note);
    const nodes = articleEl.querySelectorAll(`mark[${HIGHLIGHT_ID_ATTR}="${CSS.escape(id)}"]`);
    // Only the last mark gets the note pip so multi-line highlights show
    // a single indicator at the end of the run.
    nodes.forEach((m, i) => {
      if (has && i === nodes.length - 1) m.setAttribute(HIGHLIGHT_NOTE_ATTR, "1");
      else m.removeAttribute(HIGHLIGHT_NOTE_ATTR);
    });
  }

  function refreshAllNoteMarks() {
    if (!articleEl) return;
    for (const h of highlights) refreshNoteMarksForId(h.id);
  }

  async function loadHighlights() {
    try {
      const got = await chrome.storage?.local?.get?.(HIGHLIGHT_STORAGE_KEY);
      const map = got?.[HIGHLIGHT_STORAGE_KEY];
      const list = map && typeof map === "object" ? map[canonicalUrlKey()] : null;
      highlights = Array.isArray(list) ? list.filter((h) => h && h.id && h.text) : [];
    } catch {
      highlights = [];
    }
    highlightById = new Map(highlights.map((h) => [h.id, h]));
  }

  async function persistHighlights() {
    try {
      const got = await chrome.storage?.local?.get?.(HIGHLIGHT_STORAGE_KEY);
      const map = (got && got[HIGHLIGHT_STORAGE_KEY]) || {};
      const key = canonicalUrlKey();
      if (!highlights.length) delete map[key];
      else map[key] = highlights;
      await chrome.storage?.local?.set?.({ [HIGHLIGHT_STORAGE_KEY]: map });
    } catch {
      /* ignore */
    }
    scheduleMinimapBuild();
  }

  // ---- Note editor (annotations on highlights) --------------------------
  // Stores per-highlight free-form text in `entry.note`. The editor renders
  // a small liquid-glass panel near the target highlight; Save/Delete
  // persists through the normal highlights store.
  let highlightNoteEditorEl = null;
  let highlightNoteEditorId = null;

  function ensureNoteEditor() {
    const root = ensureRoot();
    const shadow = root.shadowRoot;
    let el = shadow.querySelector(".hl-note-editor");
    if (el) { highlightNoteEditorEl = el; return el; }
    el = document.createElement("div");
    el.className = "hl-note-editor";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Highlight note");
    el.innerHTML = `
      <div class="hl-note-head">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L13 14l-4 1 1-4 8.5-8.5z" />
        </svg>
        <span class="hl-note-title">Note</span>
      </div>
      <div class="hl-note-quote" data-quote></div>
      <textarea class="hl-note-textarea" data-note-input rows="4"
        placeholder="Add a note for this highlight…"></textarea>
      <div class="hl-note-actions">
        <button type="button" class="hl-note-btn-action" data-variant="danger" data-note-action="delete">Delete</button>
        <button type="button" class="hl-note-btn-action" data-note-action="cancel">Cancel</button>
        <button type="button" class="hl-note-btn-action" data-variant="primary" data-note-action="save">Save</button>
      </div>
    `;
    el.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    el.addEventListener("click", onNoteEditorClick);
    const ta = el.querySelector("[data-note-input]");
    ta?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeNoteEditor(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); saveNote(); }
    });
    shadow.appendChild(el);
    highlightNoteEditorEl = el;
    return el;
  }

  function openNoteEditor(id) {
    if (!id) return;
    const entry = highlightById.get(id);
    if (!entry) return;
    hidePalette();
    const el = ensureNoteEditor();
    highlightNoteEditorId = id;
    const quote = el.querySelector("[data-quote]");
    const ta = el.querySelector("[data-note-input]");
    if (quote) quote.textContent = entry.text || "";
    if (ta) ta.value = typeof entry.note === "string" ? entry.note : "";

    // Position relative to the first mark for this highlight.
    let rect = null;
    const first = articleEl?.querySelector(`mark[${HIGHLIGHT_ID_ATTR}="${CSS.escape(id)}"]`);
    if (first) rect = first.getBoundingClientRect();
    const padding = 10;
    const w = 304;
    const h = el.offsetHeight || 220;
    let left = (rect ? rect.left : 16);
    let top = rect ? rect.bottom + padding : 80;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    left = Math.max(8, Math.min(vw - w - 8, left));
    if (rect && top + h > vh - 8) top = Math.max(8, rect.top - h - padding);
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.setAttribute("data-visible", "1");
    // Defer focus until transition begins so caret lands cleanly.
    setTimeout(() => { try { ta?.focus(); ta?.select?.(); } catch {} }, 30);
  }

  function closeNoteEditor() {
    if (!highlightNoteEditorEl) return;
    highlightNoteEditorEl.removeAttribute("data-visible");
    highlightNoteEditorId = null;
  }

  function onNoteEditorClick(e) {
    const btn = e.target.closest("button[data-note-action]");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.noteAction;
    if (action === "save") saveNote();
    else if (action === "delete") deleteNote();
    else closeNoteEditor();
  }

  function saveNote() {
    const id = highlightNoteEditorId;
    if (!id) { closeNoteEditor(); return; }
    const entry = highlightById.get(id);
    if (!entry) { closeNoteEditor(); return; }
    const ta = highlightNoteEditorEl?.querySelector("[data-note-input]");
    const value = (ta?.value || "").trim();
    if (value) {
      entry.note = value;
      entry.noteUpdatedAt = Date.now();
      flashTypography("Note saved");
    } else {
      delete entry.note;
      delete entry.noteUpdatedAt;
      flashTypography("Note cleared");
    }
    refreshNoteMarksForId(id);
    persistHighlights();
    closeNoteEditor();
  }

  function deleteNote() {
    const id = highlightNoteEditorId;
    if (!id) { closeNoteEditor(); return; }
    const entry = highlightById.get(id);
    if (!entry) { closeNoteEditor(); return; }
    if (entry.note) {
      delete entry.note;
      delete entry.noteUpdatedAt;
      refreshNoteMarksForId(id);
      persistHighlights();
      flashTypography("Note deleted");
    }
    closeNoteEditor();
  }

  function restoreHighlights() {
    if (!state.enabled || !articleEl || !highlights.length) return;
    clearAllHighlightMarks();
    // Sort by start offset descending so wrapping earlier entries doesn't
    // shift later offsets in the live tree.
    const sorted = highlights.slice().sort((a, b) => (b.start || 0) - (a.start || 0));
    for (const entry of sorted) {
      let start = typeof entry.start === "number" ? entry.start : -1;
      let end = typeof entry.end === "number" ? entry.end : -1;
      const expected = entry.text || "";
      // Sanity: does the article text at [start, end) still match?
      const article = articleEl.textContent || "";
      if (start < 0 || end <= start || article.slice(start, end) !== expected) {
        const idx = findOffsetByContext(entry);
        if (idx < 0) continue;
        start = idx;
        end = idx + expected.length;
      }
      const a = pointFromOffset(start);
      const b = pointFromOffset(end);
      if (!a || !b) continue;
      const range = document.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch { continue; }
      wrapRangeWithMark(range, clampHighlightColor(entry.color), entry.id);
    }
    refreshAllNoteMarks();
  }

  function scheduleHighlightRestore() {
    clearTimeout(highlightRestoreTimer);
    highlightRestoreTimer = setTimeout(() => {
      if (state.enabled) restoreHighlights();
    }, 120);
  }

  function getArticleSelectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!articleEl || !range) return null;
    if (!articleEl.contains(range.startContainer) || !articleEl.contains(range.endContainer)) return null;
    // Reject selections that are only whitespace.
    if (!range.toString().trim()) return null;
    return range;
  }

  function ensurePalette() {
    const root = ensureRoot();
    const shadow = root.shadowRoot;
    let pal = shadow.querySelector(".hl-palette");
    if (pal) { highlightPaletteEl = pal; return pal; }
    pal = document.createElement("div");
    pal.className = "hl-palette";
    pal.setAttribute("role", "toolbar");
    pal.setAttribute("aria-label", "Highlight color");
    const swatches = HIGHLIGHT_COLORS.map((c) => `
      <button type="button" class="hl-swatch" data-hl-color="${c.id}"
        style="--swatch:${c.fill};" aria-label="${c.label}" title="${c.label}">
        <span class="hl-swatch-dot" aria-hidden="true"></span>
      </button>`).join("");
    pal.innerHTML = `
      ${swatches}
      <span class="hl-divider" aria-hidden="true"></span>
      <button type="button" class="hl-note-btn" data-hl-note="1" aria-label="Add note" title="Add note">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L13 14l-4 1 1-4 8.5-8.5z" />
        </svg>
      </button>
      <button type="button" class="hl-remove" data-hl-remove="1" aria-label="Remove highlight" title="Remove">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 7h14" />
          <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
          <path d="M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" />
        </svg>
      </button>
    `;
    pal.addEventListener("mousedown", (e) => { e.preventDefault(); }, true);
    pal.addEventListener("click", onPaletteClick);
    shadow.appendChild(pal);
    highlightPaletteEl = pal;
    return pal;
  }

  function showPaletteAt(rect, opts = {}) {
    if (!rect) return;
    const pal = ensurePalette();
    pal.setAttribute("data-mode", opts.targetId ? "edit" : "create");
    highlightTargetId = opts.targetId || null;
    // Reflect whether the target highlight already has a note so the
    // note button can render its accent state.
    const noteBtn = pal.querySelector(".hl-note-btn");
    if (noteBtn) {
      const hasNote = !!(highlightTargetId && highlightById.get(highlightTargetId)?.note);
      if (hasNote) noteBtn.setAttribute("data-has-note", "1");
      else noteBtn.removeAttribute("data-has-note");
    }
    // Position palette above selection, clamped to viewport.
    const padding = 10;
    const palW = 232;
    const palH = 40;
    let left = rect.left + rect.width / 2 - palW / 2;
    let top = rect.top - palH - padding;
    if (top < 8) top = rect.bottom + padding;
    left = Math.max(8, Math.min((window.innerWidth || 1200) - palW - 8, left));
    pal.style.left = `${Math.round(left)}px`;
    pal.style.top = `${Math.round(top)}px`;
    pal.setAttribute("data-visible", "1");
    clearTimeout(highlightPaletteHideTimer);
  }

  function hidePalette() {
    if (!highlightPaletteEl) return;
    highlightPaletteEl.removeAttribute("data-visible");
    highlightTargetId = null;
    highlightSelectionRange = null;
  }

  function onPaletteClick(e) {
    const btn = e.target.closest("button");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.dataset.hlRemove) {
      if (highlightTargetId) removeHighlightById(highlightTargetId);
      hidePalette();
      return;
    }
    if (btn.dataset.hlNote) {
      // If we're in create mode, materialize a highlight first with the
      // default color so the note can attach to a stable id.
      let id = highlightTargetId;
      if (!id && highlightSelectionRange) {
        const range = highlightSelectionRange;
        const before = highlights.length;
        applyHighlightToRange(range, clampHighlightColor());
        if (highlights.length > before) id = highlights[highlights.length - 1].id;
        try { window.getSelection()?.removeAllRanges(); } catch {}
      }
      if (!id) { hidePalette(); return; }
      openNoteEditor(id);
      return;
    }
    const color = clampHighlightColor(btn.dataset.hlColor);
    if (highlightTargetId) {
      recolorHighlight(highlightTargetId, color);
    } else if (highlightSelectionRange) {
      applyHighlightToRange(highlightSelectionRange, color);
    }
    hidePalette();
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }

  function recolorHighlight(id, color) {
    const entry = highlightById.get(id);
    if (!entry) return;
    entry.color = color;
    entry.updatedAt = Date.now();
    recolorMarksForId(id, color);
    persistHighlights();
  }

  function removeHighlightById(id) {
    if (!highlightById.has(id)) return;
    highlights = highlights.filter((h) => h.id !== id);
    highlightById.delete(id);
    unwrapMarksForId(id);
    persistHighlights();
    flashTypography("Highlight removed");
  }

  function applyHighlightToRange(range, color) {
    if (!state.enabled || !articleEl) return;
    if (!range || range.collapsed) return;
    if (!articleEl.contains(range.startContainer) || !articleEl.contains(range.endContainer)) return;
    const text = range.toString();
    if (!text.trim()) return;
    const start = articleTextOffset(range.startContainer, range.startOffset);
    const end = articleTextOffset(range.endContainer, range.endOffset);
    if (start < 0 || end <= start) return;
    const full = articleEl.textContent || "";
    const before = full.slice(Math.max(0, start - 48), start);
    const after = full.slice(end, Math.min(full.length, end + 48));
    const id = newHighlightId();
    const ok = wrapRangeWithMark(range, color, id);
    if (!ok) return;
    const entry = {
      id, color: clampHighlightColor(color),
      text, start, end, before, after,
      createdAt: Date.now(),
    };
    highlights.push(entry);
    highlightById.set(id, entry);
    persistHighlights();
    flashTypography("Highlighted");
  }

  function applyHighlightToCurrentSelection(color) {
    const range = highlightSelectionRange || getArticleSelectionRange();
    if (!range) {
      flashTypography("Select text first");
      return;
    }
    applyHighlightToRange(range, color);
    hidePalette();
    try { window.getSelection()?.removeAllRanges(); } catch {}
  }

  function onSelectionChange() {
    if (!state.enabled) return;
    if (highlightTargetId) return; // edit-mode palette open over a mark
    const range = getArticleSelectionRange();
    if (!range) {
      // Defer hiding so palette clicks register first.
      clearTimeout(highlightPaletteHideTimer);
      highlightPaletteHideTimer = setTimeout(() => {
        if (!getArticleSelectionRange()) hidePalette();
      }, 100);
      return;
    }
    highlightSelectionRange = range;
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    showPaletteAt(rect);
  }

  function onArticleClick(e) {
    if (!state.enabled) return;
    // Image click → open lightbox. Only for images inside the article and
    // not inside an <a> (links should still navigate).
    const img = e.target?.tagName === "IMG" ? e.target : null;
    if (img && articleEl && articleEl.contains(img) && !img.closest("a")) {
      const src = resolveImageSource(img);
      if (src) {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(img, src);
        return;
      }
    }
    const m = e.target.closest?.(`mark[${HIGHLIGHT_ATTR}="1"]`);
    if (!m) return;
    const id = m.getAttribute(HIGHLIGHT_ID_ATTR);
    if (!id || !highlightById.has(id)) return;
    e.stopPropagation();
    const rect = m.getBoundingClientRect();
    showPaletteAt(rect, { targetId: id });
  }

  // ---- Bookmarks ---------------------------------------------------------
  // Persist a list of bookmarked section ids per page (canonical URL =
  // origin + pathname so query strings & hashes don't fragment the list).
  // The active TOC entry is the bookmark target; falls back to topmost
  // heading currently above the viewport midline.
  let bookmarkIds = new Set();

  function canonicalUrlKey() {
    try {
      return location.origin + location.pathname;
    } catch {
      return location.href;
    }
  }

  function pickCurrentSectionId() {
    if (tocActiveId) return tocActiveId;
    if (!tocEntries.length) return null;
    // Find the last heading whose top is above the viewport's upper third.
    const cutoff = (window.innerHeight || 800) * 0.33;
    let pick = tocEntries[0].id;
    for (const e of tocEntries) {
      if (!e.el || !e.el.isConnected) continue;
      const top = e.el.getBoundingClientRect().top;
      if (top <= cutoff) pick = e.id;
      else break;
    }
    return pick;
  }

  function findEntry(id) {
    return tocEntries.find((e) => e.id === id) || null;
  }

  async function loadBookmarks() {
    try {
      const got = await chrome.storage?.local?.get?.(BOOKMARK_STORAGE_KEY);
      const map = got?.[BOOKMARK_STORAGE_KEY];
      const key = canonicalUrlKey();
      const list = map && typeof map === "object" ? map[key] : null;
      if (Array.isArray(list)) {
        bookmarkIds = new Set(list.map((b) => (b && b.id) || "").filter(Boolean));
      } else {
        bookmarkIds = new Set();
      }
    } catch {
      bookmarkIds = new Set();
    }
    refreshBookmarkMarks();
  }

  async function persistBookmarks(entries) {
    try {
      const got = await chrome.storage?.local?.get?.(BOOKMARK_STORAGE_KEY);
      const map = (got && got[BOOKMARK_STORAGE_KEY]) || {};
      const key = canonicalUrlKey();
      if (!entries.length) delete map[key];
      else map[key] = entries;
      await chrome.storage?.local?.set?.({ [BOOKMARK_STORAGE_KEY]: map });
    } catch {
      /* ignore */
    }
  }

  async function readBookmarkEntries() {
    try {
      const got = await chrome.storage?.local?.get?.(BOOKMARK_STORAGE_KEY);
      const map = got?.[BOOKMARK_STORAGE_KEY];
      const list = map && typeof map === "object" ? map[canonicalUrlKey()] : null;
      return Array.isArray(list) ? list.slice() : [];
    } catch {
      return [];
    }
  }

  function refreshBookmarkMarks() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const links = root?.shadowRoot?.querySelectorAll(".toc-link");
    if (!links) return;
    for (const a of links) {
      const id = a.getAttribute("data-toc-id");
      if (id && bookmarkIds.has(id)) a.setAttribute("data-bookmarked", "1");
      else a.removeAttribute("data-bookmarked");
    }
  }

  async function toggleBookmarkCurrentSection() {
    if (!state.enabled || !state.supported) return null;
    const id = pickCurrentSectionId();
    if (!id) {
      flashTypography("No section to bookmark");
      return null;
    }
    const entries = await readBookmarkEntries();
    const idx = entries.findIndex((b) => b && b.id === id);
    let bookmarked;
    if (idx >= 0) {
      entries.splice(idx, 1);
      bookmarkIds.delete(id);
      bookmarked = false;
    } else {
      const entry = findEntry(id);
      entries.push({
        id,
        text: entry?.text || (document.getElementById(id)?.textContent || "").trim() || id,
        level: entry?.level || 2,
        addedAt: Date.now(),
      });
      bookmarkIds.add(id);
      bookmarked = true;
    }
    await persistBookmarks(entries);
    refreshBookmarkMarks();
    flashTypography(bookmarked ? "Bookmarked" : "Bookmark removed");
    return { id, bookmarked };
  }

  function hideToc() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const toc = root?.shadowRoot?.querySelector(".toc");
    if (toc) toc.removeAttribute("data-visible");
    hideMinimap();
    if (tocIO) { try { tocIO.disconnect(); } catch {} tocIO = null; }
    if (tocMO) { try { tocMO.disconnect(); } catch {} tocMO = null; }
    tocEntries = [];
    tocActiveId = null;
  }

  function scheduleTocRebuild() {
    clearTimeout(tocRebuildTimer);
    tocRebuildTimer = setTimeout(() => {
      if (state.enabled) buildToc();
    }, TOC_REBUILD_MS);
  }

  // ---- Mini-map scrollbar (headings + highlights) ------------------------
  // A slim liquid-glass strip pinned to the right edge while reader mode is
  // active. Headings render as ticks (h2 emphasised), highlights as colored
  // dots, and the visible viewport is shown as a moving box. Click anywhere
  // on the track to scroll the article to that position. Hidden when the
  // viewport is narrow (mirrors TOC behaviour) or during print.
  let minimapBuildTimer = 0;
  let minimapWired = false;

  function scheduleMinimapBuild() {
    clearTimeout(minimapBuildTimer);
    minimapBuildTimer = setTimeout(() => {
      if (state.enabled) buildMinimap();
    }, 80);
  }

  function getMinimapEls() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    if (!shadow) return null;
    const mm = shadow.querySelector(".minimap");
    const track = shadow.querySelector("[data-mm-track]");
    const vp = shadow.querySelector("[data-mm-viewport]");
    if (!mm || !track || !vp) return null;
    return { mm, track, vp };
  }

  function hideMinimap() {
    const els = getMinimapEls();
    if (!els) return;
    els.mm.removeAttribute("data-visible");
    els.track.textContent = "";
    els.vp.style.height = "0";
  }

  function articleScrollMetrics() {
    if (!articleEl || !articleEl.isConnected) return null;
    const rect = articleEl.getBoundingClientRect();
    const top = window.scrollY + rect.top;
    const height = Math.max(1, rect.height);
    return { top, height };
  }

  function buildMinimap() {
    const els = getMinimapEls();
    if (!els) return;
    if (!state.enabled) { hideMinimap(); return; }
    const metrics = articleScrollMetrics();
    if (!metrics) { hideMinimap(); return; }
    const { top: aTop, height: aHeight } = metrics;

    const frag = document.createDocumentFragment();

    // Headings → ticks. Use the entries we built for the TOC so the ordering
    // and visibility filter matches exactly.
    for (const entry of tocEntries) {
      const el = entry.el;
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const y = window.scrollY + r.top - aTop;
      const pct = Math.max(0, Math.min(100, (y / aHeight) * 100));
      const tick = document.createElement("div");
      tick.className = "minimap-tick";
      tick.setAttribute("data-level", String(entry.level));
      tick.setAttribute("data-toc-id", entry.id);
      tick.style.top = `${pct}%`;
      if (tocActiveId && entry.id === tocActiveId) tick.setAttribute("data-active", "1");
      frag.appendChild(tick);
    }

    // Highlights → colored dots. Use the first <mark> for each entry.
    const seen = new Set();
    const marks = articleEl.querySelectorAll('mark[data-doc-reader-hl="1"]');
    for (const m of marks) {
      const id = m.getAttribute("data-doc-reader-hl-id");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const entry = highlightById.get(id);
      const color = clampHighlightColor(entry?.color);
      const r = m.getBoundingClientRect();
      const y = window.scrollY + r.top - aTop;
      const pct = Math.max(0, Math.min(100, (y / aHeight) * 100));
      const dot = document.createElement("div");
      dot.className = "minimap-hl";
      dot.setAttribute("data-color", color);
      dot.setAttribute("data-hl-id", id);
      dot.style.top = `${pct}%`;
      frag.appendChild(dot);
    }

    els.track.textContent = "";
    els.track.appendChild(frag);
    els.mm.setAttribute("data-visible", "1");
    updateMinimapViewport();
  }

  function refreshMinimapActive() {
    const els = getMinimapEls();
    if (!els) return;
    const ticks = els.track.querySelectorAll(".minimap-tick");
    for (const t of ticks) {
      if (tocActiveId && t.getAttribute("data-toc-id") === tocActiveId) t.setAttribute("data-active", "1");
      else t.removeAttribute("data-active");
    }
  }

  function updateMinimapViewport() {
    const els = getMinimapEls();
    if (!els) return;
    if (!state.enabled) return;
    const metrics = articleScrollMetrics();
    if (!metrics) return;
    const { top: aTop, height: aHeight } = metrics;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const scroll = window.scrollY;
    const startPct = Math.max(0, Math.min(100, ((scroll - aTop) / aHeight) * 100));
    const endPct = Math.max(0, Math.min(100, ((scroll + vh - aTop) / aHeight) * 100));
    const height = Math.max(2, endPct - startPct);
    els.vp.style.top = `${startPct}%`;
    els.vp.style.height = `${height}%`;
  }

  function onMinimapClick(e) {
    const metrics = articleScrollMetrics();
    if (!metrics) return;
    const els = getMinimapEls();
    if (!els) return;
    const rect = els.track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const target = metrics.top + ratio * metrics.height - (window.innerHeight || 0) / 2;
    window.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }

  function wireMinimap(shadow) {
    if (minimapWired) return;
    const mm = shadow.querySelector(".minimap");
    if (!mm) return;
    mm.addEventListener("click", onMinimapClick);
    minimapWired = true;
  }

  function watchArticleForToc() {
    if (tocMO) { try { tocMO.disconnect(); } catch {} tocMO = null; }
    if (!articleEl || typeof MutationObserver === "undefined") return;
    tocMO = new MutationObserver(() => scheduleTocRebuild());
    try {
      tocMO.observe(articleEl, { childList: true, subtree: true, characterData: true });
    } catch { tocMO = null; }
  }

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

  // ---- Recently read history ---------------------------------------------
  // Stored as a flat array of { url, title, siteId, siteLabel, accent, visitedAt }
  // under HISTORY_STORAGE_KEY, newest first, deduped by canonical URL,
  // capped at HISTORY_MAX entries.
  function bestPageTitle() {
    try {
      const h1 = document.querySelector("h1");
      const t = (h1?.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    } catch { /* noop */ }
    const dt = (document.title || "").replace(/\s+/g, " ").trim();
    return dt || location.pathname || location.href;
  }
  // ---- Per-article reading position resume -------------------------------
  // Saves `{ y, sectionId, updatedAt }` per canonical URL while the reader is
  // active. On the next visit (or next time reader is enabled) we restore
  // the scroll position so users land where they left off. Save is debounced;
  // restore is one-shot per page load and bails if the user has already
  // scrolled, so we never yank them.
  let resumeSaveTimer = 0;
  let resumeSaveAttached = false;
  let resumeApplied = false;

  async function loadResumePosition() {
    if (!state.supported) return null;
    const key = canonicalUrlKey();
    if (!key) return null;
    try {
      const got = await chrome.storage?.local?.get?.(RESUME_STORAGE_KEY);
      const map = got?.[RESUME_STORAGE_KEY];
      if (map && typeof map === "object" && map[key]) return map[key];
    } catch { /* storage unavailable */ }
    return null;
  }

  async function persistResumePosition(pos) {
    if (!state.supported) return;
    const key = canonicalUrlKey();
    if (!key) return;
    try {
      const got = await chrome.storage?.local?.get?.(RESUME_STORAGE_KEY);
      const map = (got && got[RESUME_STORAGE_KEY]) || {};
      map[key] = pos;
      const entries = Object.entries(map);
      let next = map;
      if (entries.length > RESUME_MAX) {
        entries.sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0));
        next = Object.fromEntries(entries.slice(0, RESUME_MAX));
      }
      await chrome.storage?.local?.set?.({ [RESUME_STORAGE_KEY]: next });
    } catch { /* ignore */ }
  }

  function scheduleResumeSave() {
    if (!state.enabled) return;
    if (resumeSaveTimer) clearTimeout(resumeSaveTimer);
    resumeSaveTimer = setTimeout(() => {
      resumeSaveTimer = 0;
      if (!state.enabled) return;
      const y = window.scrollY || 0;
      if (y < RESUME_MIN_Y) return;
      const pos = {
        y,
        sectionId: pickCurrentSectionId() || null,
        updatedAt: Date.now(),
      };
      persistResumePosition(pos);
    }, 1200);
  }

  function startResumeTracking() {
    if (resumeSaveAttached) return;
    window.addEventListener("scroll", scheduleResumeSave, { passive: true });
    resumeSaveAttached = true;
  }

  function stopResumeTracking() {
    if (!resumeSaveAttached) return;
    window.removeEventListener("scroll", scheduleResumeSave);
    resumeSaveAttached = false;
    if (resumeSaveTimer) { clearTimeout(resumeSaveTimer); resumeSaveTimer = 0; }
  }

  async function tryResumePosition() {
    if (resumeApplied) return;
    if ((window.scrollY || 0) > RESUME_MIN_Y) { resumeApplied = true; return; }
    const pos = await loadResumePosition();
    if (!pos) return;
    resumeApplied = true;
    const apply = () => {
      if ((window.scrollY || 0) > RESUME_MIN_Y) return;
      let scrolled = false;
      if (pos.sectionId) {
        let el = null;
        try { el = document.getElementById(pos.sectionId); } catch { el = null; }
        if (el && typeof el.scrollIntoView === "function") {
          try { el.scrollIntoView({ block: "start", behavior: "auto" }); scrolled = true; } catch { /* noop */ }
        }
      }
      if (!scrolled && Number.isFinite(pos.y)) {
        const max = Math.max(0, (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0));
        try { window.scrollTo(0, Math.min(pos.y, max)); } catch { /* noop */ }
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => setTimeout(apply, 80));
    } else {
      setTimeout(apply, 96);
    }
  }

  async function recordHistoryVisit() {
    if (!site || !state.supported) return;
    const url = canonicalUrlKey();
    if (!url) return;
    const entry = {
      url,
      title: bestPageTitle(),
      siteId: site.id,
      siteLabel: site.label,
      accent: site.accent || "#7aa2ff",
      visitedAt: Date.now(),
    };
    try {
      const got = await chrome.storage?.local?.get?.(HISTORY_STORAGE_KEY);
      const prev = Array.isArray(got?.[HISTORY_STORAGE_KEY]) ? got[HISTORY_STORAGE_KEY] : [];
      const next = [entry, ...prev.filter((e) => e && e.url !== url)].slice(0, HISTORY_MAX);
      await chrome.storage?.local?.set?.({ [HISTORY_STORAGE_KEY]: next });
    } catch { /* storage unavailable */ }
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
      mirrorToSync(STORAGE_KEY, map);
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
      mirrorToSync(WIDTH_STORAGE_KEY, map);
    } catch {
      /* ignore */
    }
  }

  async function loadFontSize() {
    try {
      const got = await chrome.storage?.local?.get?.(FONT_STORAGE_KEY);
      const map = got?.[FONT_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) {
        return clampFontSize(map[state.host]);
      }
    } catch { /* storage unavailable */ }
    return FONT_DEFAULT;
  }

  async function persistFontSize(value) {
    try {
      const got = await chrome.storage?.local?.get?.(FONT_STORAGE_KEY);
      const map = (got && got[FONT_STORAGE_KEY]) || {};
      map[state.host] = clampFontSize(value);
      await chrome.storage?.local?.set?.({ [FONT_STORAGE_KEY]: map });
      mirrorToSync(FONT_STORAGE_KEY, map);
    } catch { /* ignore */ }
  }

  async function loadLineHeight() {
    try {
      const got = await chrome.storage?.local?.get?.(LH_STORAGE_KEY);
      const map = got?.[LH_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) {
        return clampLineHeight(map[state.host]);
      }
    } catch { /* storage unavailable */ }
    return LH_DEFAULT;
  }

  async function persistLineHeight(value) {
    try {
      const got = await chrome.storage?.local?.get?.(LH_STORAGE_KEY);
      const map = (got && got[LH_STORAGE_KEY]) || {};
      map[state.host] = clampLineHeight(value);
      await chrome.storage?.local?.set?.({ [LH_STORAGE_KEY]: map });
      mirrorToSync(LH_STORAGE_KEY, map);
    } catch { /* ignore */ }
  }

  async function loadFontFamily() {
    try {
      const got = await chrome.storage?.local?.get?.(FAMILY_STORAGE_KEY);
      const map = got?.[FAMILY_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) {
        return clampFamily(map[state.host]);
      }
    } catch { /* storage unavailable */ }
    return FAMILY_DEFAULT;
  }

  async function persistFontFamily(value) {
    try {
      const got = await chrome.storage?.local?.get?.(FAMILY_STORAGE_KEY);
      const map = (got && got[FAMILY_STORAGE_KEY]) || {};
      map[state.host] = clampFamily(value);
      await chrome.storage?.local?.set?.({ [FAMILY_STORAGE_KEY]: map });
      mirrorToSync(FAMILY_STORAGE_KEY, map);
    } catch { /* ignore */ }
  }

  async function loadSyntaxTheme() {
    try {
      const got = await chrome.storage?.local?.get?.(SYNTAX_STORAGE_KEY);
      const map = got?.[SYNTAX_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) {
        return clampSyntaxTheme(map[state.host]);
      }
    } catch { /* storage unavailable */ }
    return SYNTAX_THEME_DEFAULT;
  }

  async function persistSyntaxTheme(value) {
    try {
      const got = await chrome.storage?.local?.get?.(SYNTAX_STORAGE_KEY);
      const map = (got && got[SYNTAX_STORAGE_KEY]) || {};
      map[state.host] = clampSyntaxTheme(value);
      await chrome.storage?.local?.set?.({ [SYNTAX_STORAGE_KEY]: map });
      mirrorToSync(SYNTAX_STORAGE_KEY, map);
    } catch { /* ignore */ }
  }

  // ---- Keyboard shortcut: Shift+R -----------------------------------------
  // ---- Focus mode ---------------------------------------------------------
  // Dims everything in the article except the user's current paragraph (or
  // heading / list item / block). Target follows the pointer when hovering
  // over a block, otherwise locks onto the block nearest the vertical
  // viewport center as the user scrolls. The active block gets a marker
  // attribute; ancestors get a sibling-dim hook. Pure attribute toggling so
  // CSS owns the actual dim, fade, and animation.
  const FOCUS_BLOCK_SELECTOR = "p, li, blockquote, h2, h3, h4, dl, dd, pre, figure, table";
  let focusRaf = 0;
  let focusScrollAttached = false;
  let focusPointerAttached = false;
  let focusActiveEl = null;

  function focusableBlocks() {
    if (!articleEl) return [];
    let nodes = [];
    try { nodes = Array.from(articleEl.querySelectorAll(FOCUS_BLOCK_SELECTOR)); } catch { return []; }
    return nodes.filter((el) => {
      if (el.closest(`[${META_ATTR}="1"]`)) return false;
      if (el.closest(`[${HIDE_ATTR}="1"]`)) return false;
      // Skip nested blocks inside a <pre> (only the <pre> itself counts).
      if (el.tagName !== "PRE" && el.closest("pre")) return false;
      // Skip nested <li> wrappers; the leaf <li> handler picks them up.
      if (el.tagName === "DD" && el.closest("li")) return false;
      return true;
    });
  }

  function setFocusTarget(el) {
    if (el === focusActiveEl) return;
    if (focusActiveEl) {
      try { focusActiveEl.removeAttribute(FOCUS_TARGET_ATTR); } catch { /* */ }
    }
    focusActiveEl = el || null;
    if (focusActiveEl) {
      try { focusActiveEl.setAttribute(FOCUS_TARGET_ATTR, "1"); } catch { /* */ }
    }
  }

  function pickFocusByPoint(x, y) {
    if (!articleEl) return null;
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch { el = null; }
    if (!el || !articleEl.contains(el)) return null;
    return el.closest(FOCUS_BLOCK_SELECTOR);
  }

  function pickFocusByCenter() {
    const blocks = focusableBlocks();
    if (!blocks.length) return null;
    const cy = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (r.height <= 0) continue;
      // Distance from block's vertical mid to viewport mid.
      const mid = r.top + r.height / 2;
      const d = Math.abs(mid - cy);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    return best;
  }

  function scheduleFocusUpdate() {
    if (!state.focus || !state.enabled) return;
    if (focusRaf) return;
    focusRaf = requestAnimationFrame(() => {
      focusRaf = 0;
      if (!state.focus || !state.enabled) return;
      // Prefer pointer target if cached and still under cursor; otherwise
      // fall back to the block nearest the viewport center.
      const next = pickFocusByCenter();
      if (next) setFocusTarget(next);
    });
  }

  function onFocusPointerMove(e) {
    if (!state.focus || !state.enabled) return;
    if (e.pointerType === "touch") return;
    const hit = pickFocusByPoint(e.clientX, e.clientY);
    if (hit) setFocusTarget(hit);
  }

  function startFocusMode() {
    if (!state.enabled) return;
    const root = document.documentElement;
    root.setAttribute(FOCUS_ATTR, "1");
    if (!focusScrollAttached) {
      window.addEventListener("scroll", scheduleFocusUpdate, { passive: true });
      window.addEventListener("resize", scheduleFocusUpdate, { passive: true });
      focusScrollAttached = true;
    }
    if (!focusPointerAttached) {
      document.addEventListener("pointermove", onFocusPointerMove, true);
      focusPointerAttached = true;
    }
    scheduleFocusUpdate();
  }

  function stopFocusMode() {
    const root = document.documentElement;
    root.removeAttribute(FOCUS_ATTR);
    if (focusScrollAttached) {
      window.removeEventListener("scroll", scheduleFocusUpdate);
      window.removeEventListener("resize", scheduleFocusUpdate);
      focusScrollAttached = false;
    }
    if (focusPointerAttached) {
      document.removeEventListener("pointermove", onFocusPointerMove, true);
      focusPointerAttached = false;
    }
    if (focusRaf) { cancelAnimationFrame(focusRaf); focusRaf = 0; }
    setFocusTarget(null);
  }

  function setFocusMode(next, opts = {}) {
    next = !!next;
    if (next === state.focus) return state.focus;
    state.focus = next;
    if (next && state.enabled) startFocusMode();
    else stopFocusMode();
    syncPanel();
    if (opts.persist !== false) persistFocus(next);
    return state.focus;
  }

  function toggleFocusMode() {
    if (!state.enabled) return state.focus;
    return setFocusMode(!state.focus);
  }

  async function loadFocus() {
    try {
      const got = await chrome.storage?.local?.get?.(FOCUS_STORAGE_KEY);
      const map = got?.[FOCUS_STORAGE_KEY];
      if (map && typeof map === "object" && map[state.host]) return true;
    } catch { /* */ }
    return false;
  }

  async function persistFocus(value) {
    try {
      const got = await chrome.storage?.local?.get?.(FOCUS_STORAGE_KEY);
      const map = (got && got[FOCUS_STORAGE_KEY]) || {};
      if (value) map[state.host] = 1;
      else delete map[state.host];
      await chrome.storage?.local?.set?.({ [FOCUS_STORAGE_KEY]: map });
      mirrorToSync(FOCUS_STORAGE_KEY, map);
    } catch { /* */ }
  }

  // ---- chrome.storage.sync bridge ----------------------------------------
  // Per-host preference maps (enable state, site prefs, width, font size,
  // line-height, font family, syntax theme, focus mode) ride chrome.storage
  // .sync so settings follow the user across signed-in browsers. The local
  // store remains the source of truth for the running page; sync is mirrored
  // in both directions. On boot we hydrate local from sync (sync values win
  // per-host, then merge in any local-only hosts). On every persist we push
  // the updated map to sync (best-effort, swallow quota errors). On remote
  // sync changes we copy the new value into local, which trips the existing
  // local onChanged listeners and keeps the live page in step.
  async function mirrorToSync(key, map) {
    try {
      if (!chrome.storage?.sync?.set) return;
      await chrome.storage.sync.set({ [key]: map });
    } catch { /* quota / unavailable */ }
  }

  async function hydrateFromSync() {
    try {
      if (!chrome.storage?.sync?.get) return;
      const remote = await chrome.storage.sync.get(SYNCED_KEYS);
      if (!remote || typeof remote !== "object") return;
      const localGot = await chrome.storage?.local?.get?.(SYNCED_KEYS) || {};
      const writes = {};
      for (const key of SYNCED_KEYS) {
        const r = remote[key];
        if (!r || typeof r !== "object") continue;
        const l = (localGot[key] && typeof localGot[key] === "object") ? localGot[key] : {};
        // Sync wins per-host; keep local-only hosts that sync hasn't seen.
        const merged = { ...l, ...r };
        // Skip the write if the maps already match to avoid a redundant
        // onChanged storm on boot.
        if (JSON.stringify(merged) !== JSON.stringify(l)) writes[key] = merged;
      }
      if (Object.keys(writes).length) {
        await chrome.storage?.local?.set?.(writes);
      }
    } catch { /* sync unavailable */ }
  }

  // When another browser pushes a change, replay it into local so the
  // existing local-area listeners + reload paths pick it up.
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "sync") return;
    const writes = {};
    for (const key of SYNCED_KEYS) {
      if (!changes[key]) continue;
      const next = changes[key].newValue;
      if (next === undefined) continue;
      writes[key] = next;
    }
    if (Object.keys(writes).length) {
      try { chrome.storage?.local?.set?.(writes); } catch { /* */ }
    }
  });

  // ---- Inline image lightbox with zoom ----------------------------------
  // Clicking any <img> inside the article opens a frosted overlay with the
  // image at fit-to-screen, then zoom in/out (wheel + buttons + +/- keys),
  // drag to pan when zoomed past 1×, double-click to toggle 1×/2×, Esc to
  // close. Pure CSS chrome lives in mountShell's <style>; this controller
  // owns transform math + event wiring. The lightbox lives in the shadow
  // root so page CSS can never reach it.
  const lightboxState = {
    open: false,
    zoom: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    dragStartX: 0,
    dragStartY: 0,
    txStart: 0,
    tyStart: 0,
    pointerId: null,
    src: "",
  };

  function clampZoom(z) {
    if (!Number.isFinite(z)) return 1;
    return Math.min(LIGHTBOX_ZOOM_MAX, Math.max(LIGHTBOX_ZOOM_MIN, z));
  }

  function resolveImageSource(img) {
    try {
      if (img.currentSrc) return img.currentSrc;
      if (img.src) return img.src;
    } catch { /* cross-origin */ }
    return img.getAttribute("src") || "";
  }

  function getLightboxEls() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    if (!shadow) return null;
    const lightbox = shadow.querySelector(".lightbox");
    if (!lightbox) return null;
    return {
      shadow,
      lightbox,
      img: lightbox.querySelector(".lightbox-img"),
      stage: lightbox.querySelector("[data-lightbox-stage]"),
      caption: lightbox.querySelector("[data-lb-caption]"),
      zoomLabel: lightbox.querySelector("[data-lb-zoom]"),
      backdrop: lightbox.querySelector(".lightbox-backdrop"),
    };
  }

  function isLightboxOpen() {
    return lightboxState.open === true;
  }

  function applyLightboxTransform() {
    const els = getLightboxEls();
    if (!els || !els.img) return;
    const z = clampZoom(lightboxState.zoom);
    lightboxState.zoom = z;
    els.img.style.transform = `translate(${lightboxState.tx}px, ${lightboxState.ty}px) scale(${z})`;
    if (els.zoomLabel) els.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    els.img.setAttribute("data-zoom-gt-one", z > 1.001 ? "1" : "0");
    // Disable buttons at the rails.
    const zin = els.lightbox.querySelector('[data-lb="zoom-in"]');
    const zout = els.lightbox.querySelector('[data-lb="zoom-out"]');
    if (zin) zin.disabled = z >= LIGHTBOX_ZOOM_MAX - 1e-3;
    if (zout) zout.disabled = z <= LIGHTBOX_ZOOM_MIN + 1e-3;
  }

  function openLightbox(img, src) {
    const els = getLightboxEls();
    if (!els) return;
    lightboxState.open = true;
    lightboxState.zoom = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    lightboxState.src = src;
    els.img.alt = img.getAttribute("alt") || "";
    els.img.src = src;
    const cap = (img.getAttribute("alt") || "").trim()
      || (img.getAttribute("title") || "").trim();
    if (els.caption) {
      if (cap) {
        els.caption.textContent = cap;
        els.caption.removeAttribute("data-empty");
      } else {
        els.caption.textContent = "";
        els.caption.setAttribute("data-empty", "1");
      }
    }
    els.lightbox.setAttribute("data-visible", "1");
    els.lightbox.setAttribute("aria-hidden", "false");
    applyLightboxTransform();
    // Focus the close button so keyboard users can dismiss immediately.
    const closeBtn = els.lightbox.querySelector('[data-lb="close"]');
    try { closeBtn?.focus({ preventScroll: true }); } catch { /* */ }
  }

  function closeLightbox() {
    const els = getLightboxEls();
    if (!els) return;
    lightboxState.open = false;
    lightboxState.dragging = false;
    els.lightbox.removeAttribute("data-visible");
    els.lightbox.setAttribute("aria-hidden", "true");
    if (els.img) {
      els.img.removeAttribute("data-dragging");
      els.img.removeAttribute("data-zoom-gt-one");
      // Drop the src so memory isn't held for huge images.
      els.img.removeAttribute("src");
      els.img.style.transform = "translate(0px, 0px) scale(1)";
    }
  }

  function zoomLightbox(delta, origin) {
    if (!isLightboxOpen()) return;
    const els = getLightboxEls();
    if (!els || !els.img || !els.stage) return;
    const prev = lightboxState.zoom;
    const next = clampZoom(prev + delta);
    if (next === prev) return;
    // Zoom around the supplied origin (in stage-local coordinates) so the
    // point under the cursor stays put. Without an origin, zoom around the
    // current center (tx/ty stay).
    if (origin) {
      const rect = els.stage.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const ox = origin.x - rect.left - cx;
      const oy = origin.y - rect.top - cy;
      const ratio = next / prev;
      lightboxState.tx = ratio * (lightboxState.tx - ox) + ox;
      lightboxState.ty = ratio * (lightboxState.ty - oy) + oy;
    }
    lightboxState.zoom = next;
    if (next <= 1.001) {
      lightboxState.tx = 0;
      lightboxState.ty = 0;
    }
    applyLightboxTransform();
  }

  function resetLightbox() {
    lightboxState.zoom = 1;
    lightboxState.tx = 0;
    lightboxState.ty = 0;
    applyLightboxTransform();
  }

  function wireLightbox(shadow) {
    const lightbox = shadow.querySelector(".lightbox");
    if (!lightbox) return;
    const img = lightbox.querySelector(".lightbox-img");
    const stage = lightbox.querySelector("[data-lightbox-stage]");
    if (!img || !stage) return;

    lightbox.addEventListener("click", (e) => {
      const target = e.target;
      if (target?.closest?.("[data-lightbox-close]")) {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
        return;
      }
      const btn = target?.closest?.("[data-lb]");
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const action = btn.getAttribute("data-lb");
      if (action === "zoom-in") zoomLightbox(LIGHTBOX_ZOOM_STEP);
      else if (action === "zoom-out") zoomLightbox(-LIGHTBOX_ZOOM_STEP);
      else if (action === "reset") resetLightbox();
      else if (action === "close") closeLightbox();
    });

    img.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (lightboxState.zoom > 1.001) resetLightbox();
      else zoomLightbox(1, { x: e.clientX, y: e.clientY });
    });

    img.addEventListener("click", (e) => {
      // Single-click on the image at 1x zooms in; at >1x toggles back.
      e.preventDefault();
      e.stopPropagation();
      if (lightboxState.dragging) return;
      if (lightboxState.zoom <= 1.001) {
        zoomLightbox(1, { x: e.clientX, y: e.clientY });
      }
    });

    stage.addEventListener("wheel", (e) => {
      if (!isLightboxOpen()) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -LIGHTBOX_ZOOM_STEP : LIGHTBOX_ZOOM_STEP;
      zoomLightbox(delta, { x: e.clientX, y: e.clientY });
    }, { passive: false });

    // Pointer drag-to-pan when zoomed.
    img.addEventListener("pointerdown", (e) => {
      if (lightboxState.zoom <= 1.001) return;
      if (e.button !== 0 && e.pointerType === "mouse") return;
      lightboxState.dragging = true;
      lightboxState.dragStartX = e.clientX;
      lightboxState.dragStartY = e.clientY;
      lightboxState.txStart = lightboxState.tx;
      lightboxState.tyStart = lightboxState.ty;
      lightboxState.pointerId = e.pointerId;
      img.setAttribute("data-dragging", "1");
      try { img.setPointerCapture(e.pointerId); } catch { /* */ }
      e.preventDefault();
    });
    img.addEventListener("pointermove", (e) => {
      if (!lightboxState.dragging || e.pointerId !== lightboxState.pointerId) return;
      lightboxState.tx = lightboxState.txStart + (e.clientX - lightboxState.dragStartX);
      lightboxState.ty = lightboxState.tyStart + (e.clientY - lightboxState.dragStartY);
      img.style.transform = `translate(${lightboxState.tx}px, ${lightboxState.ty}px) scale(${lightboxState.zoom})`;
    });
    const endDrag = (e) => {
      if (!lightboxState.dragging) return;
      if (e.pointerId !== lightboxState.pointerId) return;
      lightboxState.dragging = false;
      lightboxState.pointerId = null;
      img.removeAttribute("data-dragging");
      try { img.releasePointerCapture(e.pointerId); } catch { /* */ }
    };
    img.addEventListener("pointerup", endDrag);
    img.addEventListener("pointercancel", endDrag);
  }

  // Tag in-article images so cursor + a11y picks them up. Idempotent.
  function ensureImageEnhancements() {
    if (!state.enabled || !articleEl || !articleEl.isConnected) return;
    let imgs;
    try { imgs = articleEl.querySelectorAll("img"); } catch { return; }
    for (const img of imgs) {
      if (img.getAttribute(IMG_ATTR) === "1") continue;
      // Skip tiny icons and decorative SVG-sprites that aren't worth opening.
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w && h && w < 64 && h < 64) continue;
      if (img.closest("a")) continue;
      img.setAttribute(IMG_ATTR, "1");
      img.setAttribute("tabindex", img.getAttribute("tabindex") || "0");
      if (!img.getAttribute("role")) img.setAttribute("role", "button");
      if (!img.getAttribute("aria-label")) {
        const alt = (img.getAttribute("alt") || "").trim();
        img.setAttribute("aria-label", alt ? `Open image: ${alt}` : "Open image");
      }
    }
  }

  // Keyboard activation on focused images.
  document.addEventListener("keydown", (e) => {
    if (!state.enabled) return;
    if (isLightboxOpen()) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target;
    if (!(t instanceof HTMLImageElement)) return;
    if (t.getAttribute(IMG_ATTR) !== "1") return;
    e.preventDefault();
    const src = resolveImageSource(t);
    if (src) openLightbox(t, src);
  }, true);

  // ---- Search-in-page overlay -------------------------------------------
  // A glassy overlay (lives in the shadow root) that lets the user search
  // the article body and jump between matches. Matches are wrapped in
  // <mark data-doc-reader-search="1"> nodes so we get free styling. The
  // overlay never persists across reloads or reader-mode toggles.
  let searchOpen = false;
  let searchQuery = "";
  let searchMatches = [];   // array of <mark> elements
  let searchIndex = -1;
  let searchDebounce = 0;
  let searchRestoreFocus = null;

  function searchEls() {
    const root = document.querySelector(`[${ROOT_ATTR}]`);
    const shadow = root?.shadowRoot;
    if (!shadow) return null;
    const wrap = shadow.querySelector(".search");
    const input = shadow.querySelector(".search-input");
    const count = shadow.querySelector("[data-search-count]");
    if (!wrap || !input || !count) return null;
    return { root, shadow, wrap, input, count };
  }

  function wireSearch(shadow) {
    const wrap = shadow.querySelector(".search");
    const input = shadow.querySelector(".search-input");
    if (!wrap || !input) return;
    input.addEventListener("input", () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      const q = input.value;
      searchDebounce = setTimeout(() => {
        searchDebounce = 0;
        runSearch(q);
      }, 90);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        closeSearch();
      } else if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        if (e.shiftKey) gotoMatch(-1, { relative: true });
        else gotoMatch(1, { relative: true });
      }
    });
    wrap.querySelector('[data-search="next"]')?.addEventListener("click", (e) => {
      e.preventDefault(); gotoMatch(1, { relative: true }); input.focus();
    });
    wrap.querySelector('[data-search="prev"]')?.addEventListener("click", (e) => {
      e.preventDefault(); gotoMatch(-1, { relative: true }); input.focus();
    });
    wrap.querySelector('[data-search="close"]')?.addEventListener("click", (e) => {
      e.preventDefault(); closeSearch();
    });
  }

  function clearSearchMarks() {
    if (!articleEl) { searchMatches = []; searchIndex = -1; return; }
    let marks = [];
    try { marks = Array.from(articleEl.querySelectorAll(`mark[${SEARCH_ATTR}="1"]`)); } catch { marks = []; }
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize?.();
    }
    searchMatches = [];
    searchIndex = -1;
  }

  function buildSearchMatches(query) {
    clearSearchMarks();
    if (!articleEl || !articleEl.isConnected) return [];
    const q = (query || "").trim();
    if (!q) return [];
    const lc = q.toLowerCase();
    // Walk text nodes inside the article, skipping reader chrome and hidden
    // nodes. Wrap each match in its own <mark>.
    let textNodes = [];
    try {
      const walker = document.createTreeWalker(articleEl, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
          if (p.closest(`[${META_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
          if (p.closest(`[${HIDE_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
          if (p.closest(`[${SECTION_HIDDEN_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
          if (p.closest(`mark[${SEARCH_ATTR}="1"]`)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let n; while ((n = walker.nextNode())) textNodes.push(n);
    } catch { return []; }
    const matches = [];
    let count = 0;
    const HARD_CAP = 2000;
    for (const tn of textNodes) {
      if (count >= HARD_CAP) break;
      const value = tn.nodeValue;
      const lower = value.toLowerCase();
      let from = 0;
      let idx = lower.indexOf(lc, from);
      if (idx < 0) continue;
      // Split the text node into [pre][match][post], collecting marks.
      let cursor = tn;
      let consumed = 0;
      while (idx >= 0 && count < HARD_CAP) {
        const localStart = idx - consumed;
        const middle = cursor.splitText(localStart);
        const tail = middle.splitText(lc.length);
        const mark = document.createElement("mark");
        mark.setAttribute(SEARCH_ATTR, "1");
        mark.setAttribute(SEARCH_ID_ATTR, String(count));
        mark.textContent = middle.nodeValue;
        middle.parentNode.replaceChild(mark, middle);
        matches.push(mark);
        count += 1;
        consumed = idx + lc.length;
        cursor = tail;
        idx = lower.indexOf(lc, consumed);
        if (!cursor || !cursor.nodeValue) break;
      }
    }
    return matches;
  }

  function setCurrentMatch(idx, opts = {}) {
    if (!searchMatches.length) {
      searchIndex = -1;
      updateSearchCount();
      return;
    }
    const n = searchMatches.length;
    const next = ((idx % n) + n) % n;
    for (const m of searchMatches) m.removeAttribute(SEARCH_CURRENT_ATTR);
    const cur = searchMatches[next];
    cur.setAttribute(SEARCH_CURRENT_ATTR, "1");
    searchIndex = next;
    if (opts.scroll !== false) {
      try {
        cur.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      } catch {
        try { cur.scrollIntoView(); } catch { /* */ }
      }
    }
    updateSearchCount();
  }

  function gotoMatch(delta, opts = {}) {
    if (!searchMatches.length) return;
    const rel = opts.relative !== false;
    if (rel && searchIndex < 0) {
      setCurrentMatch(delta > 0 ? 0 : searchMatches.length - 1);
    } else {
      setCurrentMatch(searchIndex + delta);
    }
  }

  function updateSearchCount() {
    const els = searchEls();
    if (!els) return;
    const total = searchMatches.length;
    const cur = searchIndex >= 0 ? searchIndex + 1 : 0;
    els.count.textContent = total > 0 ? `${cur}/${total}` : (searchQuery ? "0/0" : "0/0");
    if (searchQuery && total === 0) els.count.setAttribute("data-empty", "1");
    else els.count.removeAttribute("data-empty");
    const prev = els.wrap.querySelector('[data-search="prev"]');
    const next = els.wrap.querySelector('[data-search="next"]');
    if (prev) prev.disabled = total < 2;
    if (next) next.disabled = total < 2;
  }

  function runSearch(query) {
    searchQuery = query || "";
    if (!state.enabled) {
      clearSearchMarks();
      updateSearchCount();
      return;
    }
    searchMatches = buildSearchMatches(searchQuery);
    if (searchMatches.length) setCurrentMatch(0);
    else { searchIndex = -1; updateSearchCount(); }
  }

  function openSearch() {
    if (!state.enabled) return;
    const els = searchEls();
    if (!els) return;
    searchRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    els.wrap.setAttribute("data-visible", "1");
    els.wrap.setAttribute("aria-hidden", "false");
    searchOpen = true;
    // Pre-fill from current selection when it's short enough.
    try {
      const sel = window.getSelection?.();
      const txt = sel && !sel.isCollapsed ? String(sel).trim() : "";
      if (txt && txt.length <= 80 && articleEl && sel.anchorNode && articleEl.contains(sel.anchorNode)) {
        els.input.value = txt;
        runSearch(txt);
      } else if (els.input.value) {
        runSearch(els.input.value);
      }
    } catch { /* */ }
    requestAnimationFrame(() => {
      try { els.input.focus(); els.input.select(); } catch { /* */ }
    });
  }

  function closeSearch() {
    const els = searchEls();
    if (els) {
      els.wrap.removeAttribute("data-visible");
      els.wrap.setAttribute("aria-hidden", "true");
    }
    clearSearchMarks();
    searchQuery = "";
    if (els) { els.input.value = ""; updateSearchCount(); }
    searchOpen = false;
    if (searchRestoreFocus && typeof searchRestoreFocus.focus === "function") {
      try { searchRestoreFocus.focus(); } catch { /* */ }
    }
    searchRestoreFocus = null;
  }

  function toggleSearch() {
    if (searchOpen) closeSearch();
    else openSearch();
  }

  function isSearchOpen() { return searchOpen; }

  // ---- Markdown export ---------------------------------------------------
  // Walks the article subtree and converts the relevant nodes into a
  // GitHub-flavored Markdown string. Skips the reader's own injected
  // chrome (meta strip, copy buttons, section toggles) and any nodes the
  // strip-noise feature has tagged as hidden so the export matches what
  // the user sees in reader mode.

  function isReaderInjectedNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hasAttribute(META_ATTR)) return true;
    if (node.hasAttribute(COPY_ATTR)) return true;
    if (node.hasAttribute(TOGGLE_ATTR)) return true;
    return false;
  }

  function detectCodeLanguage(pre) {
    const code = pre.querySelector("code") || pre;
    const classes = (code.className || "") + " " + (pre.className || "");
    const m = classes.match(/(?:language|lang)-([A-Za-z0-9+#.-]+)/);
    if (m) return m[1].toLowerCase();
    const dl = code.getAttribute("data-language") || pre.getAttribute("data-language");
    if (dl) return String(dl).toLowerCase();
    return "";
  }

  function mdEscape(text) {
    return String(text).replace(/([\\`*_{}\[\]()#+\-!])/g, "\\$1");
  }

  function nodeToMarkdownInline(node) {
    if (!node) return "";
    if (node.nodeType === 3) return mdEscape(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    if (isReaderInjectedNode(node)) return "";
    const tag = node.tagName.toLowerCase();
    const inner = () => Array.from(node.childNodes).map(nodeToMarkdownInline).join("");
    switch (tag) {
      case "br": return "  \n";
      case "strong":
      case "b": {
        const t = inner().trim();
        return t ? `**${t}**` : "";
      }
      case "em":
      case "i": {
        const t = inner().trim();
        return t ? `*${t}*` : "";
      }
      case "del":
      case "s":
      case "strike": {
        const t = inner().trim();
        return t ? `~~${t}~~` : "";
      }
      case "code": {
        const txt = node.textContent || "";
        return txt ? `\`${txt.replace(/`/g, "\u200b`\u200b")}\`` : "";
      }
      case "a": {
        const href = node.getAttribute("href") || "";
        const label = inner().trim() || mdEscape(node.textContent || "");
        if (!href) return label;
        try {
          const abs = new URL(href, location.href).href;
          return `[${label}](${abs})`;
        } catch {
          return `[${label}](${href})`;
        }
      }
      case "img": {
        const alt = node.getAttribute("alt") || "";
        const src = node.getAttribute("src") || node.getAttribute("data-src") || "";
        if (!src) return "";
        try { return `![${alt}](${new URL(src, location.href).href})`; }
        catch { return `![${alt}](${src})`; }
      }
      case "sup":
      case "sub":
      case "span":
      case "abbr":
      case "cite":
      case "mark":
      case "small":
      case "u":
        return inner();
      default:
        return inner();
    }
  }

  function listToMarkdown(node, ordered, depth) {
    const indent = "  ".repeat(depth);
    const lines = [];
    let n = 1;
    for (const child of node.children) {
      if (child.tagName !== "LI") continue;
      if (isReaderInjectedNode(child)) continue;
      const bullet = ordered ? `${n}.` : "-";
      const parts = [];
      const subLists = [];
      for (const c of child.childNodes) {
        if (c.nodeType === 1 && (c.tagName === "UL" || c.tagName === "OL")) {
          subLists.push(c);
        } else {
          parts.push(c);
        }
      }
      const text = parts.map(nodeToMarkdownInline).join("").trim();
      lines.push(`${indent}${bullet} ${text || ""}`.trimEnd());
      for (const sl of subLists) {
        lines.push(listToMarkdown(sl, sl.tagName === "OL", depth + 1));
      }
      n += 1;
    }
    return lines.filter(Boolean).join("\n");
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr")).filter((r) => !isReaderInjectedNode(r));
    if (!rows.length) return "";
    const cells = rows.map((tr) =>
      Array.from(tr.children)
        .filter((c) => /^(TD|TH)$/.test(c.tagName) && !isReaderInjectedNode(c))
        .map((c) => nodeToMarkdownInline(c).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim())
    );
    if (!cells[0]?.length) return "";
    const width = Math.max(...cells.map((r) => r.length));
    const norm = cells.map((r) => {
      const out = r.slice();
      while (out.length < width) out.push("");
      return out;
    });
    const head = norm[0];
    const body = norm.slice(1);
    const sep = head.map(() => "---");
    const out = [`| ${head.join(" | ")} |`, `| ${sep.join(" | ")} |`];
    for (const r of body) out.push(`| ${r.join(" | ")} |`);
    return out.join("\n");
  }

  function blockToMarkdown(node) {
    if (!node || node.nodeType !== 1) {
      if (node?.nodeType === 3) {
        const t = (node.nodeValue || "").trim();
        return t ? mdEscape(t) : "";
      }
      return "";
    }
    if (isReaderInjectedNode(node)) return "";
    if (node.hasAttribute("data-doc-reader-hide") && node.getAttribute("data-doc-reader-hide") === "1") return "";
    if (node.hasAttribute(SECTION_HIDDEN_ATTR)) return "";
    const tag = node.tagName.toLowerCase();
    switch (tag) {
      case "h1": return `# ${nodeToMarkdownInline(node).trim()}`;
      case "h2": return `## ${nodeToMarkdownInline(node).trim()}`;
      case "h3": return `### ${nodeToMarkdownInline(node).trim()}`;
      case "h4": return `#### ${nodeToMarkdownInline(node).trim()}`;
      case "h5": return `##### ${nodeToMarkdownInline(node).trim()}`;
      case "h6": return `###### ${nodeToMarkdownInline(node).trim()}`;
      case "p": {
        const t = nodeToMarkdownInline(node).trim();
        return t;
      }
      case "blockquote": {
        const inner = Array.from(node.childNodes).map(blockToMarkdown).filter(Boolean).join("\n\n");
        return inner.split("\n").map((l) => `> ${l}`).join("\n");
      }
      case "pre": {
        const lang = detectCodeLanguage(node);
        const txt = getPreText(node).replace(/\s+$/, "");
        return `\`\`\`${lang}\n${txt}\n\`\`\``;
      }
      case "ul": return listToMarkdown(node, false, 0);
      case "ol": return listToMarkdown(node, true, 0);
      case "hr": return "---";
      case "table": return tableToMarkdown(node);
      case "figure": {
        const parts = [];
        for (const c of node.children) {
          const out = blockToMarkdown(c);
          if (out) parts.push(out);
        }
        return parts.join("\n\n");
      }
      case "figcaption": {
        const t = nodeToMarkdownInline(node).trim();
        return t ? `*${t}*` : "";
      }
      case "img": return nodeToMarkdownInline(node);
      case "section":
      case "article":
      case "div": {
        const parts = [];
        for (const c of node.childNodes) {
          const out = blockToMarkdown(c);
          if (out) parts.push(out);
        }
        return parts.join("\n\n");
      }
      default: {
        // Inline-leaning element at block position: render as paragraph.
        const t = nodeToMarkdownInline(node).trim();
        return t;
      }
    }
  }

  function getExportTitle() {
    if (!articleEl) return document.title || "document";
    let h1 = null;
    try { h1 = articleEl.querySelector("h1"); } catch { h1 = null; }
    const text = (h1?.textContent || document.title || "document").trim();
    return text || "document";
  }

  function buildMarkdownDocument() {
    if (!articleEl) return null;
    const title = getExportTitle();
    const url = location.href;
    const today = new Date().toISOString().slice(0, 10);
    const header = [
      `# ${title}`,
      "",
      `*Source: <${url}>*  \n*Saved: ${today}*`,
      "",
      "---",
      "",
    ].join("\n");
    const blocks = [];
    for (const c of articleEl.children) {
      // Skip the h1 if we already used it in the header.
      if (c.tagName === "H1" && blocks.length === 0) continue;
      const md = blockToMarkdown(c);
      if (md && md.trim()) blocks.push(md.trim());
    }
    return header + blocks.join("\n\n") + "\n";
  }

  function slugifyForFile(text) {
    return (text || "document")
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "document";
  }

  function downloadMarkdown(filename, body) {
    try {
      const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
      }, 1500);
      return true;
    } catch (err) {
      if (window.__docReaderDebug) console.warn(`[${NS}]`, "download failed", err);
      return false;
    }
  }

  function exportArticleToMarkdown() {
    if (!state.supported || !state.enabled || !articleEl) {
      flashPill();
      return { ok: false, reason: "reader-off" };
    }
    const body = buildMarkdownDocument();
    if (!body) return { ok: false, reason: "no-article" };
    const filename = `${slugifyForFile(getExportTitle())}.md`;
    const ok = downloadMarkdown(filename, body);
    flashTypography(ok ? "Exported Markdown" : "Export failed");
    return { ok, filename, bytes: body.length };
  }

  // ---- Export highlights + notes to Markdown ----------------------------
  // Walks `highlights` for the current URL, groups by the nearest preceding
  // h1/h2/h3 in the article, and emits a clean Markdown document with the
  // quoted text, color label, and the author's note (when present). Empty
  // highlight set produces a friendly flash rather than an empty file.
  function highlightSectionMap() {
    if (!articleEl) return [];
    const headings = [];
    const nodes = articleEl.querySelectorAll("h1, h2, h3");
    for (const h of nodes) {
      const off = articleTextOffset(h, 0);
      if (off < 0) continue;
      const text = (h.textContent || "").trim().replace(/\s+/g, " ");
      if (!text) continue;
      const level = h.tagName === "H1" ? 1 : (h.tagName === "H2" ? 2 : 3);
      headings.push({ off, text, level });
    }
    headings.sort((a, b) => a.off - b.off);
    return headings;
  }

  function buildHighlightsMarkdownDocument() {
    if (!articleEl) return null;
    const list = Array.isArray(highlights) ? highlights.slice() : [];
    if (!list.length) return "";
    list.sort((a, b) => (a.start || 0) - (b.start || 0));
    const headings = highlightSectionMap();
    const sectionFor = (start) => {
      let last = null;
      for (const h of headings) {
        if (h.off <= start) last = h;
        else break;
      }
      return last;
    };
    const colorLabel = (id) => {
      const c = HIGHLIGHT_COLORS.find((x) => x.id === id);
      return c ? c.label : (id || "Highlight");
    };
    const title = getExportTitle();
    const url = location.href;
    const today = new Date().toISOString().slice(0, 10);
    const out = [];
    out.push(`# ${title} — Highlights`);
    out.push("");
    out.push(`*Source: <${url}>*  \n*Saved: ${today}*  \n*Highlights: ${list.length}*`);
    out.push("");
    out.push("---");
    out.push("");
    let lastKey = "__none__";
    for (const h of list) {
      const sec = sectionFor(h.start || 0);
      const key = sec ? `${sec.level}|${sec.text}` : "__none__";
      if (key !== lastKey) {
        if (sec) {
          out.push(`## ${sec.text}`);
          out.push("");
        }
        lastKey = key;
      }
      const quote = String(h.text || "").trim().replace(/\r/g, "");
      const quoted = quote.split("\n").map((l) => `> ${l}`).join("\n");
      out.push(`- **[${colorLabel(h.color)}]**`);
      out.push("");
      out.push(quoted);
      const note = h.note ? String(h.note).trim() : "";
      if (note) {
        out.push("");
        out.push(`  *Note:* ${note.replace(/\n/g, "\n  ")}`);
      }
      out.push("");
    }
    return out.join("\n");
  }

  function exportHighlightsToMarkdown() {
    if (!state.supported || !state.enabled || !articleEl) {
      flashPill();
      return { ok: false, reason: "reader-off" };
    }
    const body = buildHighlightsMarkdownDocument();
    if (body === "" || body == null) {
      flashTypography("No highlights yet");
      return { ok: false, reason: "no-highlights", count: 0 };
    }
    const count = highlights.length;
    const filename = `${slugifyForFile(getExportTitle())}-highlights.md`;
    const ok = downloadMarkdown(filename, body);
    flashTypography(ok ? `Exported ${count} highlight${count === 1 ? "" : "s"}` : "Export failed");
    return { ok, filename, count, bytes: body.length };
  }

  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  // ---- Vim-style navigation ------------------------------------------------
  // j / k scroll the page; gg jumps top, Shift+G jumps bottom. Reader mode
  // only. Smooth-scroll keeps motion consistent with the rest of the UI.
  const VIM_SCROLL_STEP = 96;
  const VIM_GG_TIMEOUT_MS = 600;
  let vimGgPendingAt = 0;
  function vimScrollBy(dy) {
    try { window.scrollBy({ top: dy, left: 0, behavior: "smooth" }); }
    catch { window.scrollBy(0, dy); }
  }
  function vimScrollTo(y) {
    try { window.scrollTo({ top: y, left: 0, behavior: "smooth" }); }
    catch { window.scrollTo(0, y); }
  }
  function vimDocBottom() {
    const doc = document.documentElement;
    const h = Math.max(doc?.scrollHeight || 0, document.body?.scrollHeight || 0);
    return Math.max(0, h - (window.innerHeight || 0));
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (!state.supported) return;

    // Cmd/Ctrl+F: open search overlay (reader mode only). Done before the
    // modifier guard below so the shortcut still reaches us.
    if (state.enabled && !isSearchOpen() && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F" || e.code === "KeyF")) {
      if (!isTypingTarget(e.target)) {
        e.preventDefault(); e.stopPropagation();
        openSearch();
        return;
      }
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    // Lightbox key handling — when open, Escape closes; +/- zoom; 0 resets.
    if (isLightboxOpen()) {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        closeLightbox();
        return;
      }
      if (e.key === "+" || (e.code === "Equal" && e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        zoomLightbox(LIGHTBOX_ZOOM_STEP);
        return;
      }
      if (e.key === "-" || e.code === "Minus") {
        e.preventDefault(); e.stopPropagation();
        zoomLightbox(-LIGHTBOX_ZOOM_STEP);
        return;
      }
      if (e.key === "0" || e.code === "Digit0") {
        e.preventDefault(); e.stopPropagation();
        resetLightbox();
        return;
      }
    }

    // Shift + R toggles reader mode.
    if ((e.key === "R" || e.code === "KeyR") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleEnabled();
      return;
    }

    // Slash (/) opens the search-in-page overlay (reader mode only).
    if (state.enabled && !isSearchOpen() && (e.key === "/" || e.code === "Slash") && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      openSearch();
      return;
    }

    // Shift + M exports the current article to Markdown (reader mode only).
    if (state.enabled && (e.key === "M" || e.code === "KeyM") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      exportArticleToMarkdown();
      return;
    }

    // Shift + H exports highlights + notes to Markdown (reader mode only).
    if (state.enabled && (e.key === "H" || e.code === "KeyH") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      exportHighlightsToMarkdown();
      return;
    }

    // Shift + F toggles focus mode (reader mode only).
    if (state.enabled && (e.key === "F" || e.code === "KeyF") && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleFocusMode();
      return;
    }

    // [ and ] adjust max-width while reader mode is on. No shift.
    if (state.enabled && !e.shiftKey) {
      // Vim-style navigation. j scrolls down a step, k scrolls up. gg (two
      // quick g presses) jumps to the top of the document.
      if (e.key === "j" || e.code === "KeyJ") {
        e.preventDefault(); e.stopPropagation();
        vimScrollBy(VIM_SCROLL_STEP);
        return;
      }
      if (e.key === "k" || e.code === "KeyK") {
        e.preventDefault(); e.stopPropagation();
        vimScrollBy(-VIM_SCROLL_STEP);
        return;
      }
      if (e.key === "g" || e.code === "KeyG") {
        e.preventDefault(); e.stopPropagation();
        const now = Date.now();
        if (now - vimGgPendingAt <= VIM_GG_TIMEOUT_MS) {
          vimGgPendingAt = 0;
          vimScrollTo(0);
        } else {
          vimGgPendingAt = now;
        }
        return;
      }
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
      // - / = adjust font size. Accept the shifted "+" too.
      if (e.key === "-" || e.code === "Minus") {
        e.preventDefault();
        e.stopPropagation();
        setFontSize(state.fontSize - FONT_STEP);
        return;
      }
      if (e.key === "=" || e.code === "Equal") {
        e.preventDefault();
        e.stopPropagation();
        setFontSize(state.fontSize + FONT_STEP);
        return;
      }
      // , / . adjust line-height.
      if (e.key === "," || e.code === "Comma") {
        e.preventDefault();
        e.stopPropagation();
        setLineHeight(state.lineHeight - LH_STEP);
        return;
      }
      if (e.key === "." || e.code === "Period") {
        e.preventDefault();
        e.stopPropagation();
        setLineHeight(state.lineHeight + LH_STEP);
        return;
      }
      // c toggles the liquid-glass control panel.
      if (e.key === "c" || e.code === "KeyC") {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
        return;
      }
      // f cycles font family (sans -> serif -> mono).
      if (e.key === "f" || e.code === "KeyF") {
        e.preventDefault();
        e.stopPropagation();
        cycleFontFamily(1);
        return;
      }
      // b bookmarks (or un-bookmarks) the current section.
      if (e.key === "b" || e.code === "KeyB") {
        e.preventDefault();
        e.stopPropagation();
        toggleBookmarkCurrentSection();
        return;
      }
      // 1-4 apply highlight color to current selection; 0 removes the
      // hovered/last-touched mark when a palette is open over one.
      if ((e.key === "1" || e.code === "Digit1") && getArticleSelectionRange()) {
        e.preventDefault(); e.stopPropagation();
        applyHighlightToCurrentSelection(HIGHLIGHT_COLORS[0].id);
        return;
      }
      if ((e.key === "2" || e.code === "Digit2") && getArticleSelectionRange()) {
        e.preventDefault(); e.stopPropagation();
        applyHighlightToCurrentSelection(HIGHLIGHT_COLORS[1].id);
        return;
      }
      if ((e.key === "3" || e.code === "Digit3") && getArticleSelectionRange()) {
        e.preventDefault(); e.stopPropagation();
        applyHighlightToCurrentSelection(HIGHLIGHT_COLORS[2].id);
        return;
      }
      if ((e.key === "4" || e.code === "Digit4") && getArticleSelectionRange()) {
        e.preventDefault(); e.stopPropagation();
        applyHighlightToCurrentSelection(HIGHLIGHT_COLORS[3].id);
        return;
      }
      if ((e.key === "0" || e.code === "Digit0") && highlightTargetId) {
        e.preventDefault(); e.stopPropagation();
        removeHighlightById(highlightTargetId);
        hidePalette();
        return;
      }
      // Escape closes the palette.
      if (e.key === "Escape" && highlightPaletteEl?.getAttribute("data-visible") === "1") {
        hidePalette();
        return;
      }
    }
    // Shift + = (i.e. "+") also bumps font size, since plus reads better.
    if (state.enabled && e.shiftKey && (e.key === "+" || (e.code === "Equal" && e.shiftKey))) {
      e.preventDefault();
      e.stopPropagation();
      setFontSize(state.fontSize + FONT_STEP);
      return;
    }
    // Shift + G jumps to the bottom of the document (vim-style).
    if (state.enabled && e.shiftKey && (e.key === "G" || e.code === "KeyG")) {
      e.preventDefault();
      e.stopPropagation();
      vimScrollTo(vimDocBottom());
      return;
    }
  }
  window.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("selectionchange", onSelectionChange, true);
  document.addEventListener("click", onArticleClick, true);

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
      case "doc-reader/get-theme":
        sendResponse({ theme: state.theme, auto: true });
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
      case "doc-reader/get-typography":
        sendResponse({
          fontSize: state.fontSize,
          lineHeight: state.lineHeight,
          fontFamily: state.fontFamily,
          families: FAMILIES.map((f) => ({ id: f.id, label: f.label })),
          fontMin: FONT_MIN, fontMax: FONT_MAX, fontStep: FONT_STEP, fontDefault: FONT_DEFAULT,
          lineMin: LH_MIN, lineMax: LH_MAX, lineStep: LH_STEP, lineDefault: LH_DEFAULT,
          familyDefault: FAMILY_DEFAULT,
        });
        return true;
      case "doc-reader/set-font-family":
        setFontFamily(msg.fontFamily).then((v) => sendResponse({ fontFamily: v }));
        return true;
      case "doc-reader/set-syntax-theme":
        setSyntaxTheme(msg.syntaxTheme).then((v) => sendResponse({ syntaxTheme: v }));
        return true;
      case "doc-reader/list-syntax-themes":
        sendResponse({
          themes: SYNTAX_THEMES.map((t) => ({ id: t.id, label: t.label })),
          current: state.syntaxTheme,
        });
        return true;
      case "doc-reader/cycle-font-family":
        cycleFontFamily(msg.dir === -1 ? -1 : 1).then((v) => sendResponse({ fontFamily: v }));
        return true;
      case "doc-reader/set-font-size":
        setFontSize(msg.fontSize).then((v) => sendResponse({ fontSize: v }));
        return true;
      case "doc-reader/set-line-height":
        setLineHeight(msg.lineHeight).then((v) => sendResponse({ lineHeight: v }));
        return true;
      case "doc-reader/reset-typography":
        Promise.all([
          setFontSize(FONT_DEFAULT),
          setLineHeight(LH_DEFAULT),
          setFontFamily(FAMILY_DEFAULT),
        ]).then(([f, l, fam]) => sendResponse({ fontSize: f, lineHeight: l, fontFamily: fam }));
        return true;
      case "doc-reader/progress":
        sendResponse({
          enabled: state.enabled,
          percent: state.enabled ? Math.max(0, progressLastPct) : 0,
        });
        return true;
      case "doc-reader/bookmark-current":
        toggleBookmarkCurrentSection().then((res) => sendResponse(res || { id: null, bookmarked: false }));
        return true;
      case "doc-reader/list-bookmarks":
        readBookmarkEntries().then((entries) => sendResponse({
          url: canonicalUrlKey(),
          entries,
        }));
        return true;
      case "doc-reader/is-section-bookmarked":
        sendResponse({
          id: pickCurrentSectionId(),
          bookmarked: bookmarkIds.has(pickCurrentSectionId() || ""),
        });
        return true;
      case "doc-reader/list-highlights":
        sendResponse({
          url: canonicalUrlKey(),
          colors: HIGHLIGHT_COLORS.map((c) => ({ id: c.id, label: c.label, fill: c.fill })),
          entries: highlights.slice(),
        });
        return true;
      case "doc-reader/highlight-selection":
        applyHighlightToCurrentSelection(clampHighlightColor(msg.color));
        sendResponse({ ok: true, count: highlights.length });
        return true;
      case "doc-reader/remove-highlight":
        if (msg.id) removeHighlightById(String(msg.id));
        sendResponse({ ok: true, count: highlights.length });
        return true;
      case "doc-reader/clear-highlights":
        highlights = [];
        highlightById = new Map();
        clearAllHighlightMarks();
        persistHighlights();
        sendResponse({ ok: true });
        return true;
      case "doc-reader/toggle-panel":
        togglePanel();
        sendResponse({ open: document.querySelector(`[${ROOT_ATTR}]`)?.shadowRoot?.querySelector(".panel")?.getAttribute("data-visible") === "1" });
        return true;
      case "doc-reader/show-panel":
        showPanel();
        sendResponse({ ok: true });
        return true;
      case "doc-reader/hide-panel":
        hidePanel();
        sendResponse({ ok: true });
        return true;
      case "doc-reader/toc":
        sendResponse({
          entries: tocEntries.map((e) => ({ id: e.id, text: e.text, level: e.level })),
          activeId: tocActiveId,
        });
        return true;
      case "doc-reader/lightbox-state":
        sendResponse({
          open: isLightboxOpen(),
          zoom: lightboxState.zoom,
          src: lightboxState.src,
        });
        return true;
      case "doc-reader/close-lightbox":
        closeLightbox();
        sendResponse({ ok: true });
        return true;
      case "doc-reader/export-markdown":
        sendResponse(exportArticleToMarkdown());
        return true;
      case "doc-reader/export-highlights":
        sendResponse(exportHighlightsToMarkdown());
        return true;
      case "doc-reader/toggle-focus":
        sendResponse({ focus: toggleFocusMode() });
        return true;
      case "doc-reader/set-focus":
        sendResponse({ focus: setFocusMode(!!msg.focus) });
        return true;
      case "doc-reader/get-focus":
        sendResponse({ focus: state.focus, enabled: state.enabled });
        return true;
      case "doc-reader/open-search":
        openSearch();
        sendResponse({ open: isSearchOpen() });
        return true;
      case "doc-reader/close-search":
        closeSearch();
        sendResponse({ open: isSearchOpen() });
        return true;
      case "doc-reader/search":
        if (typeof msg.query === "string") {
          openSearch();
          const els = searchEls();
          if (els) { els.input.value = msg.query; }
          runSearch(msg.query);
        }
        sendResponse({ matches: searchMatches.length, index: searchIndex });
        return true;
      default:
        return false;
    }
  });

  // ---- Boot ----------------------------------------------------------------
  ensureRoot();
  if (state.supported) {
    // Pull any cross-browser preferences into local before we read them.
    await hydrateFromSync();
    state.width = await loadWidth();
    state.fontSize = await loadFontSize();
    state.lineHeight = await loadLineHeight();
    state.fontFamily = await loadFontFamily();
    state.syntaxTheme = await loadSyntaxTheme();
    applyWidth();
    applyTypography();
    await loadBookmarks();
    await loadHighlights();
    state.focus = await loadFocus();
    const wasEnabled = await loadEnabled();
    if (wasEnabled) setEnabled(true, { flash: false });
    // Record this page in the recently-read history (capped at 20).
    try { await recordHistoryVisit(); } catch { /* noop */ }
  }
  if (window.__docReaderDebug) console.log(`[${NS}]`, "ready", state);
})();
