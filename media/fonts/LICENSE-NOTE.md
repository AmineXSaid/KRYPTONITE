# Fonts bundled with this extension

The two `.woff2` files in this folder are bundled into the packaged `.vsix`,
which means the extension **redistributes** them to everyone who installs it.
Both are under the **SIL Open Font License 1.1**, which expressly permits that,
including inside a commercial product, provided the fonts are not sold on their
own and the licence travels with them.

| File | Family | Role | Licence | Upstream |
| --- | --- | --- | --- | --- |
| `JetBrainsMono-Variable.woff2` | JetBrains Mono | the interface | OFL 1.1 | github.com/JetBrains/JetBrainsMono |
| `IBMPlexSans-Variable.woff2` | IBM Plex Sans | prose only | OFL 1.1 | github.com/IBM/plex |

Both are the **latin subset** as served by Google Fonts, in the variable cut, so
one file per family covers every weight the design uses. 85 KB together.

The split is by ROLE, not by taste. JetBrains Mono carries labels, tabs, the
wordmark, code, and every id that has to line up in a column. IBM Plex Sans
carries prose and nothing else — `--kx-prose` in `tokens.css` names the exact
surfaces. A monospace sets every character at a full advance, so a line of prose
with no narrow letters wraps early; the transcript was breaking mid-sentence at
a dock width where a proportional face still had room.

`test/vsix.cjs` ties each family declared in `src/ui/shell.ts` to a licence file
naming it, in both directions: a family with no licence fails, and a licence for
a family that no longer ships fails too. That is the OFL obligation rather than
a file count, so this table cannot quietly go stale.

## What was here before


Three families totalling 96 KB — IBM Plex Sans for the interface, Space Mono for
mono runs, Michroma for the wordmark alone. The Terminal direction set the whole
design in one monospace, so all three were removed rather than left dormant:
40 KB instead of 96 KB, and no way for a surface to drift back onto a face the
design no longer uses.

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
