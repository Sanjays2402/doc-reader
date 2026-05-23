// Smoke test: validates manifest.json shape and required files exist.
import fs from "node:fs";
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const must = ["manifest_version","name","version","description"];
for (const k of must) if (!m[k]) { console.error("missing manifest key:", k); process.exit(1); }
if (m.manifest_version !== 3) { console.error("manifest_version must be 3"); process.exit(1); }
for (const p of ["src/popup.html","src/popup.js","src/popup.css","src/background.js","src/content.js","src/content.css"])
  if (!fs.existsSync(p)) { console.error("missing file:", p); process.exit(1); }
if (!Array.isArray(m.content_scripts) || m.content_scripts.length === 0) {
  console.error("manifest.content_scripts missing"); process.exit(1);
}
const cs = m.content_scripts[0];
if (!cs.js?.includes("src/content.js") || !cs.css?.includes("src/content.css")) {
  console.error("content_scripts must register src/content.js and src/content.css"); process.exit(1);
}
if (!Array.isArray(cs.matches) || cs.matches.length < 5) {
  console.error("content_scripts.matches must cover the supported doc sites"); process.exit(1);
}
for (const sz of [16,32,48,128]) if (!fs.existsSync(`icons/icon-${sz}.png`)) { console.error("missing icon:", sz); process.exit(1); }

// Site registry: must exist, be web-accessible, and detect each supported host.
if (!fs.existsSync("src/sites.js")) { console.error("missing src/sites.js"); process.exit(1); }
const war = m.web_accessible_resources;
if (!Array.isArray(war) || !war.some(r => r.resources?.includes("src/sites.js"))) {
  console.error("src/sites.js must be in web_accessible_resources"); process.exit(1);
}
const { SITES, detectSite, isSupported } = await import("../src/sites.js");
const expected = [
  ["https://developer.mozilla.org/en-US/docs/Web/JavaScript", "mdn"],
  ["https://react.dev/learn/thinking-in-react", "react"],
  ["https://vercel.com/docs/functions", "vercel"],
  ["https://tailwindcss.com/docs/installation", "tailwind"],
  ["https://nextjs.org/docs/app/getting-started", "nextjs"],
];
for (const [url, id] of expected) {
  const hit = detectSite(url);
  if (!hit || hit.id !== id) { console.error("detect failed:", url, "->", hit?.id); process.exit(1); }
}
for (const bad of ["https://example.com/", "https://vercel.com/pricing", "not a url"]) {
  if (isSupported(bad)) { console.error("false positive:", bad); process.exit(1); }
}
if (SITES.length < 5) { console.error("SITES registry too small"); process.exit(1); }

// Each site must declare a noise selector list so the strip feature has
// something to hide. COMMON_NOISE is shared across all sites.
const { COMMON_NOISE } = await import("../src/sites.js");
if (!Array.isArray(COMMON_NOISE) || COMMON_NOISE.length === 0) {
  console.error("COMMON_NOISE must be a non-empty array"); process.exit(1);
}
for (const s of SITES) {
  if (!Array.isArray(s.noise) || s.noise.length === 0) {
    console.error("site missing noise selectors:", s.id); process.exit(1);
  }
}

// Content CSS must hide tagged nodes only when reader mode is active.
const contentCss = fs.readFileSync("src/content.css", "utf8");
if (!/html\.doc-reader-active\s+\[data-doc-reader-hide="1"\][\s\S]*display\s*:\s*none/.test(contentCss)) {
  console.error("content.css must hide [data-doc-reader-hide=\"1\"] when reader is active");
  process.exit(1);
}

// Reader toggle: content script must register the Shift+R shortcut and
// expose a toggle entry point. We grep for stable tokens rather than
// loading the script (it depends on chrome.* globals).
const contentSrc = fs.readFileSync("src/content.js", "utf8");
for (const needle of [
  "KeyR",
  "shiftKey",
  "doc-reader/toggle",
  "__docReaderToggle",
  "doc-reader-active",
  "stripNoise",
  "restoreNoise",
  "data-doc-reader-hide",
  "buildToc",
  "toc-list",
  "On this page",
  "IntersectionObserver",
  "progress-fill",
  "updateProgress",
  "Reading progress",
  '.panel',
  "togglePanel",
  "syncPanel",
  "data-panel-open",
  "panel-slider",
  'data-ctl="width"',
  'data-ctl="font-size"',
  'data-ctl="line-height"',
  "doc-reader/toggle-panel",
]) {
  if (!contentSrc.includes(needle)) {
    console.error("content.js missing reader-toggle token:", needle);
    process.exit(1);
  }
}

// Popup must render the bookmarks-list view with search.
const popupHtml = fs.readFileSync("src/popup.html", "utf8");
for (const needle of [
  "id=\"search-input\"",
  "id=\"root\"",
  "id=\"tpl-group\"",
  "id=\"tpl-item\"",
  "id=\"tpl-empty\"",
  "Search bookmarks",
]) {
  if (!popupHtml.includes(needle)) { console.error("popup.html missing:", needle); process.exit(1); }
}
if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(popupHtml)) {
  console.error("popup.html must not contain emoji (use inline SVG icons)"); process.exit(1);
}

const popupJs = fs.readFileSync("src/popup.js", "utf8");
for (const needle of [
  "doc-reader:bookmarks",
  "chrome.storage",
  "chrome.tabs",
  "searchInput",
  "removeBookmark",
  "render",
  "highlight",
]) {
  if (!popupJs.includes(needle)) { console.error("popup.js missing:", needle); process.exit(1); }
}

const popupCss = fs.readFileSync("src/popup.css", "utf8");
for (const needle of [
  "backdrop-filter",
  "cubic-bezier(0.16, 1, 0.3, 1)",
  ".blob",
  ".group",
  ".bm",
  ".empty",
]) {
  if (!popupCss.includes(needle)) { console.error("popup.css missing:", needle); process.exit(1); }
}

console.log("\u2713 smoke ok");
