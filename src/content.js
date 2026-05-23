// Doc Reader — content script scaffold
// Runs on supported documentation sites. Subsequent roadmap items
// build on top of this entry point (site detection, reader toggle,
// TOC, highlights, etc.).

(async () => {
  if (window.__docReaderLoaded) return;
  window.__docReaderLoaded = true;

  const NS = "doc-reader";
  const ROOT_ATTR = `data-${NS}-root`;

  // Site detection — load the registry from the extension package so
  // both popup and content script share one source of truth.
  let site = null;
  try {
    const mod = await import(chrome.runtime.getURL("src/sites.js"));
    site = mod.detectSite(location);
  } catch (err) {
    // Detection is best-effort; absence shouldn't break the page.
    if (window.__docReaderDebug) console.warn("[doc-reader] detect failed", err);
  }

  const state = {
    enabled: false,
    host: location.hostname,
    href: location.href,
    site: site ? { id: site.id, label: site.label, accent: site.accent } : null,
    supported: !!site,
  };

  // Tag the document so future CSS/features can scope to a known site.
  if (site) {
    document.documentElement.setAttribute(`data-${NS}-site`, site.id);
  }

  function ensureRoot() {
    let root = document.querySelector(`[${ROOT_ATTR}]`);
    if (!root) {
      root = document.createElement("div");
      root.setAttribute(ROOT_ATTR, "");
      root.setAttribute("hidden", "");
      // Shadow DOM keeps host page styles from leaking into the reader UI.
      root.attachShadow({ mode: "open" });
      (document.body || document.documentElement).appendChild(root);
    }
    return root;
  }

  function log(...args) {
    // Keep noise low; gated on a flag for debugging.
    if (window.__docReaderDebug) console.log(`[${NS}]`, ...args);
  }

  // Message bridge — popup/background can ping for status or toggle.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
      default:
        return false;
    }
  });

  ensureRoot();
  log("content script ready", state);
})();
