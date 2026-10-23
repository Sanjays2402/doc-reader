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

## Features

### Custom CSS overrides (per site)

Open the popup → Settings → **Custom CSS** to inject your own CSS while reader
mode is on. The editor targets the supported site in the current tab, saved CSS
applies live to open tabs, and overrides follow you across signed-in browsers
via `chrome.storage.sync`. Clear the field and hit **Save CSS** to remove the
override for a site.

```css
/* Example: tighter measure on MDN */
article { max-width: 62ch !important; }
code { font-size: 0.92em; }
```

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

## Terms & Disclaimer

By using this project you agree to the following.

- **No warranty.** This software is provided "as is", without warranty of any kind, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.
- **No liability.** To the maximum extent permitted by law, the author and contributors are not liable for any claim, loss, or damage (direct, indirect, incidental, or consequential, including lost data or profits) arising from its use.
- **Your responsibility.** You use it at your own risk and are responsible for complying with the laws that apply to you.
- **Third-party sites.** This tool runs on websites you visit; use it in line with their terms.
- Documentation sites named in this README are trademarks of their owners; this extension is not affiliated with them. Use it in line with each site's terms.
- **Third parties.** Names, logos, APIs, and services of others belong to their owners and are used for identification only; no affiliation or endorsement is implied.
- **Your statutory rights.** Nothing here limits rights that cannot be waived by agreement, including under consumer-protection laws in the USA, Canada (including Quebec), and India (Consumer Protection Act, 2019).
- **License.** Use, copying, and distribution are governed by the [LICENSE](LICENSE) file; if anything here conflicts with it, the license controls.
