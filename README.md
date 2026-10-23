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
- **Third-party sites and tools.** This tool runs inside websites or apps made by others; use it in line with their terms.
- Documentation sites named in this README are trademarks of their owners; this extension is not affiliated with them. Use it in line with each site's terms.
- **Third parties.** Names, logos, APIs, and services of others belong to their owners and are used for identification only; no affiliation or endorsement is implied.
- **Your statutory rights.** Nothing here limits rights that cannot be waived by agreement, including under consumer-protection laws in the USA, Canada (including Quebec), and India (Consumer Protection Act, 2019).
- **License.** Use, copying, and distribution are governed by the [LICENSE](LICENSE) file; if anything here conflicts with it, the license controls.

## Content, Assets & Fair Use

- **Original work.** Unless noted otherwise (including below), the code, text, design, and images in this repository were created by the author.
- **Libraries, fonts, and icons.** Third-party libraries, fonts (for example Google Fonts), and icon sets belong to their creators and are used under their own licenses; see the dependency manifests and each source for terms.
- **Logos, brands, and screenshots.** Third-party names, logos, and screenshots appear only to identify or describe their products (nominative use). They remain the property of their owners and do not imply affiliation or endorsement.
- **Ideas and inspiration.** Where this project is inspired by another product, game, or idea, it is an independent implementation. It borrows only general ideas, mechanics, or styles, which are not anyone's exclusive property, and is meant to contain no third-party code or artwork used without permission.
- **Fair use and fair dealing.** Any third-party material is used in limited ways for purposes such as education, research, review, commentary, or identification, relying on fair use in the USA (17 U.S.C. § 107), fair dealing in Canada (Copyright Act, ss. 29–29.2), and fair dealing in India (Copyright Act, 1957, s. 52), where they apply.
- **Concerns and takedown requests.** If you own rights in something here and believe it is used improperly, [open an issue](https://github.com/Sanjays2402/doc-reader/issues) or contact the author through their GitHub profile with a link to the material and your claim. It will be reviewed promptly and credited, changed, or removed as appropriate. You may also use GitHub's DMCA process.
- **Contributions.** By contributing, you confirm you have the right to submit your contribution and agree it is licensed under this repository's license.
