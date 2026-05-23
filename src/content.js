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
  };

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

    shadow.appendChild(style);
    shadow.appendChild(progress);
    shadow.appendChild(toc);
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
      applyTypography();
      root.removeAttribute("hidden");
      stripNoise();
      applySingleColumn();
      buildToc();
      watchArticleForToc();
      startProgress();
    } else {
      stopProgress();
      hideToc();
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

  // ---- Typography (font size + line-height) -------------------------------
  function applyTypography() {
    const root = document.documentElement;
    root.style.setProperty("--doc-reader-font-size", `${state.fontSize}px`);
    root.style.setProperty("--doc-reader-line-height", String(state.lineHeight));
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
    }
    if (opts.persist !== false) persistLineHeight(v);
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
      case "doc-reader/get-typography":
        sendResponse({
          fontSize: state.fontSize,
          lineHeight: state.lineHeight,
          fontMin: FONT_MIN, fontMax: FONT_MAX, fontStep: FONT_STEP, fontDefault: FONT_DEFAULT,
          lineMin: LH_MIN, lineMax: LH_MAX, lineStep: LH_STEP, lineDefault: LH_DEFAULT,
        });
        return true;
      case "doc-reader/set-font-size":
        setFontSize(msg.fontSize).then((v) => sendResponse({ fontSize: v }));
        return true;
      case "doc-reader/set-line-height":
        setLineHeight(msg.lineHeight).then((v) => sendResponse({ lineHeight: v }));
        return true;
      case "doc-reader/reset-typography":
        Promise.all([setFontSize(FONT_DEFAULT), setLineHeight(LH_DEFAULT)])
          .then(([f, l]) => sendResponse({ fontSize: f, lineHeight: l }));
        return true;
      case "doc-reader/progress":
        sendResponse({
          enabled: state.enabled,
          percent: state.enabled ? Math.max(0, progressLastPct) : 0,
        });
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
    applyWidth();
    applyTypography();
    const wasEnabled = await loadEnabled();
    if (wasEnabled) setEnabled(true, { flash: false });
  }
  if (window.__docReaderDebug) console.log(`[${NS}]`, "ready", state);
})();
