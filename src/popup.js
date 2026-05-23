// Doc Reader — popup entry point.
// Renders the bookmarks-list view: every bookmark saved by the content
// script lives under chrome.storage.local[`doc-reader:bookmarks`] as a
// map of canonical URL -> [{ id, text, level, addedAt }]. We load that
// map, group by URL, and provide a fuzzy-ish substring search across
// section titles + URLs.

const BOOKMARK_KEY = "doc-reader:bookmarks";
const SITE_PREFS_KEY = "doc-reader:site-prefs";
const HISTORY_KEY = "doc-reader:history";

/** @type {Record<string, Array<{id:string,text:string,level:number,addedAt:number}>>} */
let bookmarkMap = {};
let query = "";
/** @type {Record<string, boolean>} per-site enable map keyed by site id */
let sitePrefs = {};
let sites = [];
/** @type {Array<{url:string,title:string,siteId:string,siteLabel:string,accent:string,visitedAt:number}>} */
let history = [];
let currentView = "bookmarks"; // "bookmarks" | "settings" | "history"

const root = document.getElementById("root");
const settingsView = document.getElementById("settings-view");
const siteListEl = document.getElementById("site-list");
const tplSiteRow = /** @type {HTMLTemplateElement} */ (document.getElementById("tpl-site-row"));
const tplHistoryRow = /** @type {HTMLTemplateElement} */ (document.getElementById("tpl-history-row"));
const historyView = document.getElementById("history-view");
const historyListEl = document.getElementById("history-list");
const historyClearBtn = document.getElementById("history-clear");
const historyBtn = document.getElementById("history-btn");
const viewTitle = document.getElementById("view-title");
const searchSection = document.querySelector(".search");
const backBtn = document.getElementById("back-btn");
const settingsBtn = document.getElementById("settings-btn");
const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("search-input"));
const searchClear = document.getElementById("search-clear");
const tplGroup = /** @type {HTMLTemplateElement} */ (document.getElementById("tpl-group"));
const tplItem = /** @type {HTMLTemplateElement} */ (document.getElementById("tpl-item"));
const tplEmpty = /** @type {HTMLTemplateElement} */ (document.getElementById("tpl-empty"));

// Match the theme to the user agent's preference. We default body to
// `dark`; flip to light when the user actually prefers light.
try {
  const mql = window.matchMedia?.("(prefers-color-scheme: light)");
  if (mql?.matches) document.body.setAttribute("data-theme", "light");
  mql?.addEventListener?.("change", (e) => {
    document.body.setAttribute("data-theme", e.matches ? "light" : "dark");
  });
} catch { /* noop */ }

document.getElementById("settings-btn")?.addEventListener("click", () => {
  setView(currentView === "settings" ? "bookmarks" : "settings");
});
historyBtn?.addEventListener("click", () => {
  setView(currentView === "history" ? "bookmarks" : "history");
});
historyClearBtn?.addEventListener("click", () => clearHistory());
backBtn?.addEventListener("click", () => setView("bookmarks"));

searchInput?.addEventListener("input", () => {
  query = searchInput.value.trim();
  if (searchClear) searchClear.hidden = !query;
  render();
});
searchInput?.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && searchInput.value) {
    e.preventDefault();
    clearSearch();
  }
});
searchClear?.addEventListener("click", () => {
  clearSearch();
  searchInput?.focus();
});

function clearSearch() {
  if (!searchInput) return;
  searchInput.value = "";
  query = "";
  if (searchClear) searchClear.hidden = true;
  render();
}

async function loadBookmarks() {
  try {
    const got = await chrome.storage?.local?.get?.(BOOKMARK_KEY);
    const map = got?.[BOOKMARK_KEY];
    bookmarkMap = map && typeof map === "object" ? map : {};
  } catch {
    bookmarkMap = {};
  }
}

async function loadSitePrefs() {
  try {
    const got = await chrome.storage?.local?.get?.(SITE_PREFS_KEY);
    const map = got?.[SITE_PREFS_KEY];
    sitePrefs = map && typeof map === "object" ? map : {};
  } catch {
    sitePrefs = {};
  }
}

async function loadHistory() {
  try {
    const got = await chrome.storage?.local?.get?.(HISTORY_KEY);
    const list = got?.[HISTORY_KEY];
    history = Array.isArray(list) ? list.filter((e) => e && e.url) : [];
  } catch {
    history = [];
  }
}

async function clearHistory() {
  history = [];
  try {
    await chrome.storage?.local?.set?.({ [HISTORY_KEY]: [] });
  } catch { /* noop */ }
  if (currentView === "history") renderHistory();
}

async function removeHistoryEntry(url) {
  history = history.filter((e) => e.url !== url);
  try {
    await chrome.storage?.local?.set?.({ [HISTORY_KEY]: history });
  } catch { /* noop */ }
  if (currentView === "history") renderHistory();
}

async function loadSites() {
  try {
    const mod = await import(chrome.runtime.getURL("src/sites.js"));
    sites = Array.isArray(mod.SITES) ? mod.SITES : [];
  } catch {
    sites = [];
  }
}

function isSiteEnabled(siteId) {
  // Default-on: only explicit `false` disables.
  return sitePrefs[siteId] !== false;
}

async function setSiteEnabled(siteId, enabled) {
  sitePrefs = { ...sitePrefs, [siteId]: !!enabled };
  try {
    await chrome.storage?.local?.set?.({ [SITE_PREFS_KEY]: sitePrefs });
    // Mirror to chrome.storage.sync so the toggle follows the user across
    // signed-in browsers. Best-effort; quota / unavailability is silently
    // tolerated because local is the source of truth for the live tab.
    try { await chrome.storage?.sync?.set?.({ [SITE_PREFS_KEY]: sitePrefs }); } catch { /* noop */ }
  } catch { /* noop */ }
}

function setView(view) {
  currentView = view === "settings" ? "settings" : view === "history" ? "history" : "bookmarks";
  const showSettings = currentView === "settings";
  const showHistory = currentView === "history";
  const showBookmarks = currentView === "bookmarks";
  if (root) root.hidden = !showBookmarks;
  if (settingsView) settingsView.hidden = !showSettings;
  if (historyView) historyView.hidden = !showHistory;
  if (searchSection) searchSection.hidden = !showBookmarks;
  if (backBtn) backBtn.hidden = showBookmarks;
  if (viewTitle) {
    viewTitle.textContent = showSettings
      ? "Settings"
      : showHistory
        ? "Recently read"
        : "Doc Reader";
  }
  if (settingsBtn) {
    settingsBtn.setAttribute("aria-pressed", showSettings ? "true" : "false");
    settingsBtn.title = showSettings ? "Close settings" : "Settings";
  }
  if (historyBtn) {
    historyBtn.setAttribute("aria-pressed", showHistory ? "true" : "false");
    historyBtn.title = showHistory ? "Close history" : "Recently read";
  }
  if (showSettings) renderSites();
  else if (showHistory) renderHistory();
  else render();
}

// Live updates: if a content script bookmarks something while the popup
// is open (popup lifetime is short, but Chrome keeps it alive enough for
// this to matter), reflect it immediately.
try {
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (changes[BOOKMARK_KEY]) {
      bookmarkMap = changes[BOOKMARK_KEY].newValue || {};
      if (currentView === "bookmarks") render();
    }
    if (changes[SITE_PREFS_KEY]) {
      sitePrefs = changes[SITE_PREFS_KEY].newValue || {};
      if (currentView === "settings") renderSites();
    }
    if (changes[HISTORY_KEY]) {
      const next = changes[HISTORY_KEY].newValue;
      history = Array.isArray(next) ? next.filter((e) => e && e.url) : [];
      if (currentView === "history") renderHistory();
    }
  });
} catch { /* noop */ }

// ---- Render --------------------------------------------------------------

function siteLabelFor(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "developer.mozilla.org") return "MDN";
    if (host === "react.dev") return "React";
    if (host === "vercel.com") return "Vercel";
    if (host === "tailwindcss.com") return "Tailwind";
    if (host === "nextjs.org") return "Next.js";
    return host;
  } catch {
    return "Doc";
  }
}

function prettyPath(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname;
  } catch {
    return url;
  }
}

function highlight(text, q) {
  const frag = document.createDocumentFragment();
  if (!q) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const needle = q.toLowerCase();
  const hay = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    const hit = hay.indexOf(needle, i);
    if (hit < 0) {
      frag.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (hit > i) frag.appendChild(document.createTextNode(text.slice(i, hit)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(hit, hit + needle.length);
    frag.appendChild(mark);
    i = hit + needle.length;
  }
  return frag;
}

function matches(entry, url, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (entry.text || "").toLowerCase().includes(needle) ||
    url.toLowerCase().includes(needle) ||
    siteLabelFor(url).toLowerCase().includes(needle)
  );
}

function bookmarkUrl(canonical, id) {
  // Bookmark ids are heading element ids, which the content script
  // ensured exist as in-page anchors. Append as a hash so the browser
  // jumps after the page loads.
  try {
    const u = new URL(canonical);
    u.hash = id ? `#${id}` : "";
    return u.toString();
  } catch {
    return canonical;
  }
}

async function openBookmark(url) {
  try {
    await chrome.tabs?.create?.({ url });
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

async function removeBookmark(canonical, id) {
  const list = (bookmarkMap[canonical] || []).filter((b) => b && b.id !== id);
  if (list.length) bookmarkMap[canonical] = list;
  else delete bookmarkMap[canonical];
  try {
    await chrome.storage?.local?.set?.({ [BOOKMARK_KEY]: bookmarkMap });
  } catch { /* noop */ }
  render();
}

function renderEmpty(title, hint) {
  const node = tplEmpty.content.cloneNode(true);
  node.querySelector(".empty-title").textContent = title;
  node.querySelector(".empty-hint").textContent = hint;
  root.appendChild(node);
}

function render() {
  root.replaceChildren();
  const urls = Object.keys(bookmarkMap)
    .filter((u) => Array.isArray(bookmarkMap[u]) && bookmarkMap[u].length);

  if (!urls.length) {
    renderEmpty(
      "No bookmarks yet",
      "Press Shift+R on a supported docs page, then press B to bookmark a section."
    );
    return;
  }

  // Sort URLs by most-recent activity (max addedAt in the group).
  urls.sort((a, b) => latestAddedAt(bookmarkMap[b]) - latestAddedAt(bookmarkMap[a]));

  let shown = 0;
  for (const url of urls) {
    const entries = (bookmarkMap[url] || [])
      .filter((e) => e && e.id && e.text)
      .filter((e) => matches(e, url, query))
      .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    if (!entries.length) continue;

    const groupFrag = tplGroup.content.cloneNode(true);
    const groupEl = groupFrag.querySelector(".group");
    groupEl.querySelector(".group-site").textContent = siteLabelFor(url);
    groupEl.querySelector(".group-count").textContent = String(entries.length);
    const link = groupEl.querySelector(".group-url");
    link.href = url;
    link.textContent = prettyPath(url);
    link.addEventListener("click", (e) => {
      e.preventDefault();
      openBookmark(url);
    });

    const list = groupEl.querySelector(".group-items");
    for (const entry of entries) {
      const itemFrag = tplItem.content.cloneNode(true);
      const liEl = itemFrag.querySelector(".bm");
      const openBtn = liEl.querySelector(".bm-open");
      const textEl = liEl.querySelector(".bm-text");
      textEl.replaceChildren(highlight(entry.text, query));
      openBtn.title = entry.text;
      openBtn.addEventListener("click", () => openBookmark(bookmarkUrl(url, entry.id)));
      const rmBtn = liEl.querySelector(".bm-remove");
      rmBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        removeBookmark(url, entry.id);
      });
      list.appendChild(itemFrag);
    }
    root.appendChild(groupFrag);
    shown += entries.length;
  }

  if (!shown) {
    renderEmpty(
      "No matches",
      `Nothing matches "${query}". Try a shorter query or clear the search.`
    );
  }
}

function latestAddedAt(list) {
  let max = 0;
  for (const e of list || []) if (e && typeof e.addedAt === "number" && e.addedAt > max) max = e.addedAt;
  return max;
}

// Tiny inline toast so we don't fall back to alert().
let flashTimer = null;
function flash(msg) {
  let el = document.getElementById("flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "flash";
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "44px",
      transform: "translateX(-50%) translateY(8px)",
      padding: "8px 12px",
      borderRadius: "10px",
      background: "rgba(20,20,24,0.78)",
      color: "#fff",
      border: "1px solid rgba(255,255,255,0.12)",
      backdropFilter: "blur(20px)",
      WebkitBackdropFilter: "blur(20px)",
      fontSize: "12px",
      letterSpacing: "-0.01em",
      zIndex: "10",
      opacity: "0",
      transition: "opacity 200ms cubic-bezier(0.16,1,0.3,1), transform 200ms cubic-bezier(0.16,1,0.3,1)",
      pointerEvents: "none",
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
  }, 2400);
}

(async function init() {
  await Promise.all([loadBookmarks(), loadSitePrefs(), loadSites(), loadHistory()]);
  render();
  // Defer focus until after first paint so the layout settles.
  requestAnimationFrame(() => searchInput?.focus());
})();

function renderSites() {
  if (!siteListEl || !tplSiteRow) return;
  siteListEl.replaceChildren();
  if (!sites.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites available.";
    siteListEl.appendChild(li);
    return;
  }
  for (const s of sites) {
    const frag = tplSiteRow.content.cloneNode(true);
    const row = frag.querySelector(".site-row");
    row.style.setProperty("--site-accent", s.accent || "#7aa2ff");
    row.dataset.siteId = s.id;
    row.querySelector(".site-label").textContent = s.label;
    row.querySelector(".site-host").textContent = (s.hosts && s.hosts[0]) || "";
    const input = row.querySelector(".switch-input");
    const enabled = isSiteEnabled(s.id);
    input.checked = enabled;
    input.setAttribute("aria-label", `Enable Doc Reader on ${s.label}`);
    row.querySelector(".switch-label").textContent = `Toggle ${s.label}`;
    input.addEventListener("change", async () => {
      await setSiteEnabled(s.id, input.checked);
    });
    siteListEl.appendChild(frag);
  }
}

function relativeTime(ts) {
  const now = Date.now();
  const diff = Math.max(0, now - (Number(ts) || 0));
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  try { return new Date(ts).toLocaleDateString(); } catch { return `${d}d ago`; }
}

function renderHistory() {
  if (!historyListEl || !tplHistoryRow) return;
  historyListEl.replaceChildren();
  const entries = (history || [])
    .filter((e) => e && e.url)
    .sort((a, b) => (b.visitedAt || 0) - (a.visitedAt || 0))
    .slice(0, 20);

  if (historyClearBtn) historyClearBtn.hidden = !entries.length;

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "empty";
    const wrap = tplEmpty.content.cloneNode(true);
    wrap.querySelector(".empty-title").textContent = "Nothing read yet";
    wrap.querySelector(".empty-hint").textContent =
      "Open a supported docs page — MDN, React, Vercel, Tailwind, or Next.js — and it'll appear here.";
    li.appendChild(wrap);
    historyListEl.appendChild(li);
    return;
  }

  for (const e of entries) {
    const frag = tplHistoryRow.content.cloneNode(true);
    const row = frag.querySelector(".hist-row");
    row.style.setProperty("--site-accent", e.accent || "#7aa2ff");
    const titleEl = row.querySelector(".hist-title");
    titleEl.textContent = e.title || prettyPath(e.url);
    titleEl.title = e.title || e.url;
    row.querySelector(".hist-site").textContent = e.siteLabel || siteLabelFor(e.url);
    row.querySelector(".hist-when").textContent = relativeTime(e.visitedAt);
    const openBtn = row.querySelector(".hist-open");
    openBtn.addEventListener("click", () => openBookmark(e.url));
    const rmBtn = row.querySelector(".hist-remove");
    rmBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeHistoryEntry(e.url);
    });
    historyListEl.appendChild(frag);
  }
}
