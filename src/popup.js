// Doc Reader — popup entry point.
// Renders the bookmarks-list view: every bookmark saved by the content
// script lives under chrome.storage.local[`doc-reader:bookmarks`] as a
// map of canonical URL -> [{ id, text, level, addedAt }]. We load that
// map, group by URL, and provide a fuzzy-ish substring search across
// section titles + URLs.

const BOOKMARK_KEY = "doc-reader:bookmarks";

/** @type {Record<string, Array<{id:string,text:string,level:number,addedAt:number}>>} */
let bookmarkMap = {};
let query = "";

const root = document.getElementById("root");
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
  // Settings live in the in-page panel for now. Surface a hint instead
  // of throwing an alert — alerts feel like 2014.
  flash("Open any doc page and press Shift+R for controls.");
});

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

// Live updates: if a content script bookmarks something while the popup
// is open (popup lifetime is short, but Chrome keeps it alive enough for
// this to matter), reflect it immediately.
try {
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area !== "local") return;
    if (!changes[BOOKMARK_KEY]) return;
    bookmarkMap = changes[BOOKMARK_KEY].newValue || {};
    render();
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
  await loadBookmarks();
  render();
  // Defer focus until after first paint so the layout settles.
  requestAnimationFrame(() => searchInput?.focus());
})();
