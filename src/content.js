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
  const FONT_STORAGE_KEY = `${NS}:font-size`;
  const LH_STORAGE_KEY = `${NS}:line-height`;
  const FAMILY_STORAGE_KEY = `${NS}:font-family`;
  const BOOKMARK_STORAGE_KEY = `${NS}:bookmarks`;
  const HIGHLIGHT_STORAGE_KEY = `${NS}:highlights`;
  const HIGHLIGHT_ATTR = "data-doc-reader-hl";
  const HIGHLIGHT_ID_ATTR = "data-doc-reader-hl-id";
  const HIGHLIGHT_COLOR_ATTR = "data-doc-reader-hl-color";
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
  const ARTICLE_ATTR = "data-doc-reader-article";
  const ANCESTOR_ATTR = "data-doc-reader-article-ancestor";
  const HEADING_ATTR = "data-doc-reader-heading";
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

  const state = {
    enabled: false,
    host: location.hostname,
    href: location.href,
    site: site ? { id: site.id, label: site.label, accent: site.accent } : null,
    supported: !!site,
    width: WIDTH_DEFAULT,
    fontSize: FONT_DEFAULT,
    lineHeight: LH_DEFAULT,
    fontFamily: FAMILY_DEFAULT,
    theme: "light",
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
        <div class="panel-actions">
          <button type="button" data-action="reset">Reset</button>
          <button type="button" class="primary" data-action="close">Done</button>
        </div>
        <div class="panel-foot">
          <span>Toggle panel</span>
          <span class="kbd">C</span>
        </div>
      </div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(progress);
    shadow.appendChild(toc);
    shadow.appendChild(pill);
    shadow.appendChild(panel);
    wirePanel(shadow);
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
      ]);
      syncPanel();
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
    } else {
      stopProgress();
      hidePanel();
      hideToc();
      hidePalette();
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
    tocClickGuardUntil = Date.now() + 700;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveTocId(id);
  }

  function setActiveTocId(id) {
    if (id === tocActiveId) return;
    tocActiveId = id;
    refreshBookmarkMarks();
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
    // Position palette above selection, clamped to viewport.
    const padding = 10;
    const palW = 196;
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
    } catch { /* ignore */ }
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
      default:
        return false;
    }
  });

  // ---- Boot ----------------------------------------------------------------
  ensureRoot();
  if (state.supported) {
    state.width = await loadWidth();
    state.fontSize = await loadFontSize();
    state.lineHeight = await loadLineHeight();
    state.fontFamily = await loadFontFamily();
    applyWidth();
    applyTypography();
    await loadBookmarks();
    await loadHighlights();
    const wasEnabled = await loadEnabled();
    if (wasEnabled) setEnabled(true, { flash: false });
  }
  if (window.__docReaderDebug) console.log(`[${NS}]`, "ready", state);
})();
