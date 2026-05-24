# Roadmap

This file is the agent's task queue. Unchecked items get implemented in order. When all items are checked, the agent appends a new batch of 10.

- [x] MV3 manifest + content script scaffolding
- [x] Detect supported doc sites (MDN, React, Vercel, Tailwind, Next.js)
- [x] Toggle reader mode on/off (keyboard shortcut Shift+R)
- [x] Strip nav, sidebar, ads — keep article + code blocks
- [x] Single-column layout with adjustable max-width
- [x] Persistent TOC sidebar from h2/h3
- [x] Reading progress indicator
- [x] Font size + line-height controls
- [x] Serif/sans/mono toggle
- [x] Bookmark current section
- [x] Bookmarks list popup with search
- [x] Highlight tool (4 colors, persisted per URL)
- [x] Auto-detect dark mode preference
- [x] Print-friendly stylesheet
- [x] Liquid-glass control panel
- [x] Estimated reading time in header
- [x] Copy code button on every code block
- [x] Syntax theme picker (3 themes: noir, paper, neon)
- [x] Inline image lightbox with zoom
- [x] Section-collapse toggles on h2 headings
- [x] Export current article to Markdown
- [x] Focus mode (dims everything except current paragraph)
- [x] Search-in-page overlay with match navigation
- [x] Per-site enable/disable settings panel
- [x] Recently read history (last 20 docs)
- [x] Annotations: add inline notes to highlights
- [x] Export highlights + notes to Markdown
- [x] Sync settings across browsers via chrome.storage.sync
- [x] Per-article reading position resume
- [x] Mini-map scrollbar showing headings + highlights
- [ ] Vim-style keyboard navigation (j/k/gg/G)
- [ ] Spaced-repetition queue for bookmarked sections
- [ ] Auto-link cross-references between MDN/React/Next.js terms
- [ ] Inline glossary tooltips for technical terms on hover
- [ ] Custom CSS injection panel (per-site overrides)
