# Anthropic Sans — licensing status of the files in this folder

**Read this before publishing the extension to a marketplace.**

The seven `.woff2` files in this folder are Anthropic Sans, converted from `.otf`
originals. They are bundled in the packaged `.vsix`, which means the extension
**redistributes** them to every person who installs it.

## What the design handoff says

`FONTS.md`, from the design project this typography came from
(`claude.ai/design/p/16299f11-5add-4606-a319-a8f087dd759a`), states verbatim:

> Anthropic Sans is a proprietary typeface commissioned by Anthropic. It is not
> published under an open licence and is not distributed through Google Fonts or
> Adobe Fonts. The files provided here came from a third-party mirror, which is not
> a licence grant.
>
> Rendering it locally on a machine where it is already installed is one thing.
> Bundling the binaries into a distributed extension is redistribution, and that is
> a licensing matter to settle with Anthropic before release — not a build step.

## The decision on record

Bundling was chosen deliberately, with the above understood, so that the panel
renders as designed on every machine rather than only on machines that already have
the family installed. That trade is a licensing question, not a technical one, and it
is **unresolved**: nothing here constitutes permission to redistribute.

Before any public release, either

1. obtain written permission from Anthropic to redistribute these binaries, or
2. remove this folder from the package and fall back to a licensed face.

## Falling back

Option 2 is cheap by construction. `src/ui/shell.ts` emits `@font-face` only for
files that are actually present, and every CSS stack already names system fallbacks
after `'Anthropic Sans'`. Deleting this folder — or adding `media/fonts/**` to
`.vscodeignore` — removes the fonts from the package with no code change; the panel
then renders on the platform sans-serif.

`FONTS.md` names Plus Jakarta Sans (SIL Open Font License, free to embed and
redistribute) as the intended licensed substitute, and records that the design was
measured against it. Note that it cannot be loaded from Google Fonts at runtime: the
webview CSP is `default-src 'none'` with `font-src` scoped to the extension origin,
so it would have to be bundled the same way these files are.

## Provenance

- Source: `.otf` static instances supplied with the design handoff.
- Conversion: `fontTools` 4.63.0 + `brotli`, OTF → WOFF2, no subsetting.
  419 KB → 236 KB across seven faces; all 684 glyphs retained (622 for the italic).
- Faces shipped: Text 400/400-italic/500/600/700, Display 600/700. The Light and
  Extrabold cuts are unreferenced by the design and are not included.
