# Anthropic Sans — licensing status of the files in this folder

**Read this before publishing the extension to a marketplace.**

The seven `.woff2` files in this folder are Anthropic Sans, converted from `.otf`
originals supplied with the Genesis design handoff. `media/**` is not excluded
by `.vscodeignore`, so these files ship inside the packaged `.vsix` — the
extension **redistributes** them to every person who installs it.

## The decision on record

For this refactor (Panel C / Genesis theme), the project owner was asked
explicitly whether to follow the design brief's original plan — drop Anthropic
Sans and use Michroma + IBM Plex Sans instead — or keep Anthropic Sans as the
`--display`/`--body` faces. They chose to **keep Anthropic Sans**, with the
redistribution question in view. That is a deliberate call, but it does not
resolve the underlying licensing question: nothing here constitutes permission
to redistribute Anthropic Sans.

Before any public marketplace release, either

1. obtain written permission from Anthropic to redistribute these binaries, or
2. remove this folder (or add `media/fonts/**` to `.vscodeignore`) and fall
   back to a licensed face.

## Falling back

Option 2 is cheap by construction. `src/ui/shell.ts`'s `fontFaces()` emits
`@font-face` rules only for files that are actually present in this folder,
and `sidebar.css` / `controlCenter.css` already name system fallbacks after
`'Anthropic Sans Text'` / `'Anthropic Sans Display'`
(`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`). Deleting this
folder, or excluding it in `.vscodeignore`, removes the fonts from the package
with no code change — the panel then renders on the platform sans-serif.

A licensed substitute (e.g. Plus Jakarta Sans, SIL Open Font License, free to
embed and redistribute) would need to be bundled the same way these files are:
the webview CSP is `default-src 'none'` with `font-src` scoped to the
extension origin, so nothing can be pulled from Google Fonts or any other CDN
at runtime.

## Provenance

- Source: `.otf` static instances supplied with the design handoff, already
  converted to `.woff2` before this refactor.
- Faces shipped: Text 400 / 400-italic / 500 / 600 / 700, Display 600 / 700.
- `--mono` (`'Space Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace`)
  is **not** bundled here — the CSP blocks the Google Fonts request the name
  implies, so it silently falls back to the system monospace stack. No
  redistribution question applies to it because no binary ships.
