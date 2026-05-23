# Doc Reader

Reader mode for technical documentation sites — MDN, React, Vercel, Tailwind. Single column, persistent TOC.

> Status: **v0.1.0 — scaffold**. Features ship every 15 minutes via an autonomous agent. See `ROADMAP.md` for what's next.

## Install (dev)

```
git clone https://github.com/Sanjays2402/doc-reader.git
cd doc-reader
```

Then in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select this folder.

## Permissions

- `storage`
- `activeTab`
- `scripting`

**Host permissions:**
- `https://developer.mozilla.org/*`
- `https://react.dev/*`
- `https://vercel.com/docs/*`
- `https://tailwindcss.com/docs/*`
- `https://nextjs.org/docs/*`

## Roadmap

- [ ] MV3 manifest + content script scaffolding
- [ ] Detect supported doc sites (MDN, React, Vercel, Tailwind, Next.js)
- [ ] Toggle reader mode on/off (keyboard shortcut Shift+R)
- [ ] Strip nav, sidebar, ads — keep article + code blocks
- [ ] Single-column layout with adjustable max-width
- [ ] Persistent TOC sidebar from h2/h3
- [ ] Reading progress indicator
- [ ] Font size + line-height controls
- [ ] Serif/sans/mono toggle
- [ ] Bookmark current section
- [ ] Bookmarks list popup with search
- [ ] Highlight tool (4 colors, persisted per URL)
- [ ] Auto-detect dark mode preference
- [ ] Print-friendly stylesheet
- [ ] Liquid-glass control panel

## License

MIT — see [LICENSE](LICENSE).
