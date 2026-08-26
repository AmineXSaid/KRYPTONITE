# Fonts bundled with this extension

The four `.woff2` files in this folder are bundled into the packaged `.vsix`,
which means the extension **redistributes** them to everyone who installs it.
All four are under the **SIL Open Font License 1.1**, which expressly permits
that, including inside a commercial product, provided the fonts are not sold on
their own and the licence travels with them.

| File | Family | Licence | Upstream |
| --- | --- | --- | --- |
| `IBMPlexSans-Variable.woff2` | IBM Plex Sans | OFL 1.1 | github.com/IBM/plex |
| `SpaceMono-Regular.woff2` | Space Mono 400 | OFL 1.1 | github.com/googlefonts/spacemono |
| `SpaceMono-Bold.woff2` | Space Mono 700 | OFL 1.1 | github.com/googlefonts/spacemono |
| `Michroma-Regular.woff2` | Michroma | OFL 1.1 | github.com/googlefonts/michroma |

These are the three families the Genesis design is drawn in: IBM Plex Sans for
the interface, Space Mono for every mono run in it, and Michroma for the
GENESIS wordmark alone.

All four are the **latin subset** as served by Google Fonts
(`U+0000-00FF` plus the usual punctuation and symbol ranges). IBM Plex Sans is
the variable cut, so one 45 KB file covers the 400/500/600 the design uses
instead of three static faces. 94 KB total.

## What this replaced, and why it matters

This folder previously held seven faces of **Anthropic Sans**, and this note
recorded that bundling them was a **licensing matter unresolved**:

> Anthropic Sans is a proprietary typeface commissioned by Anthropic. It is not
> published under an open licence […] The files provided here came from a
> third-party mirror, which is not a licence grant.
>
> Bundling the binaries into a distributed extension is redistribution, and that
> is a licensing matter to settle with Anthropic before release.

That note prescribed two ways out: obtain written permission, or fall back to a
licensed face. The Genesis design specifies IBM Plex Sans, which **is** a
licensed face, so matching the design and clearing the blocker turned out to be
the same change. The Anthropic Sans binaries have been removed; nothing in the
CSS references them.

`git log` retains them if the decision is ever revisited.

## Note on the CSP

The webview CSP is `default-src 'none'` with `font-src` scoped to the extension
origin. A family that is merely *named* in the CSS cannot be fetched from Google
Fonts at runtime — it has to be bundled here. That is not a hypothetical: for
several releases `--kx-mono` named Space Mono without shipping it, so every mono
run in the panel silently rendered in the platform monospace.

`src/ui/shell.ts` emits `@font-face` only for files that are actually present,
and every CSS stack names system fallbacks after the bundled family, so
deleting a file here degrades the panel rather than breaking it.
