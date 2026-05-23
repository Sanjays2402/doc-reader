// Doc Reader — supported site registry.
//
// Each entry describes one documentation site we know how to read.
// Detection is intentionally conservative: hostname match first,
// optional path prefix, and a CSS selector for the article root so
// future features (strip nav, build TOC, etc.) have a known anchor.
//
// Adding a new site = add an entry here. No other code change needed.

export const SITES = Object.freeze([
  {
    id: "mdn",
    label: "MDN Web Docs",
    accent: "#83d0f2",
    hosts: ["developer.mozilla.org"],
    pathPrefix: null,
    article: "main#content article, main#content, article.main-page-content",
    title: "main h1, article h1",
    toc: "main h2, main h3",
  },
  {
    id: "react",
    label: "React",
    accent: "#61dafb",
    hosts: ["react.dev"],
    pathPrefix: null,
    article: "article, main article, [role=main] article",
    title: "article h1, main h1",
    toc: "article h2, article h3",
  },
  {
    id: "vercel",
    label: "Vercel Docs",
    accent: "#ffffff",
    hosts: ["vercel.com"],
    pathPrefix: "/docs",
    article: "main article, main [data-docs-content], main",
    title: "main h1",
    toc: "main h2, main h3",
  },
  {
    id: "tailwind",
    label: "Tailwind CSS",
    accent: "#38bdf8",
    hosts: ["tailwindcss.com"],
    pathPrefix: "/docs",
    article: "main article, main #content, main",
    title: "main h1",
    toc: "main h2, main h3",
  },
  {
    id: "nextjs",
    label: "Next.js",
    accent: "#ffffff",
    hosts: ["nextjs.org"],
    pathPrefix: "/docs",
    article: "main article, main [data-docs-content], main",
    title: "main h1",
    toc: "main h2, main h3",
  },
]);

/**
 * Detect the supported site for a given URL.
 * @param {string|URL|Location} input
 * @returns {object|null} matching SITES entry, or null when unsupported.
 */
export function detectSite(input) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input?.href ?? input));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname || "/";
  for (const site of SITES) {
    const hostHit = site.hosts.some(
      (h) => host === h || host.endsWith(`.${h}`),
    );
    if (!hostHit) continue;
    if (site.pathPrefix && !path.startsWith(site.pathPrefix)) continue;
    return site;
  }
  return null;
}

/**
 * Convenience: is this URL a supported doc page?
 * @param {string|URL|Location} input
 */
export function isSupported(input) {
  return detectSite(input) !== null;
}

export default { SITES, detectSite, isSupported };
