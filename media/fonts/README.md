# Bundled fonts

Three families, all under the SIL Open Font License 1.1. The full licence text
for each ships beside the binaries in this directory, which is what the OFL
requires of anyone redistributing the software.

| Family | Files | Role | Licence |
|---|---|---|---|
| Michroma | `Michroma-400.woff2`, `Michroma-400-ext.woff2` | the `Genesis` wordmark and nothing else | `OFL-Michroma.txt` |
| Space Mono | `SpaceMono-{400,700}.woff2` and their `-ext` pairs | every 9px uppercase label: tabs, phase segments, buttons, badges, dumps | `OFL-SpaceMono.txt` |
| IBM Plex Sans | `IBMPlexSans-var.woff2`, `IBMPlexSans-var-ext.woff2` | body copy | `OFL-IBMPlexSans.txt` |

## Why these three

They are the families the Genesis design names. Nothing here is a substitute
picked for licensing convenience.

## Two notes on the files themselves

**IBM Plex Sans is one variable file per subset, not one file per weight.**
It carries the whole `100 700` axis, so the four static cuts the extension used
to load are replaced by two files totalling 76KB. `src/ui/shell.ts` declares it
with `font-weight: 100 700` so the browser interpolates rather than synthesising
a fake bold.

**The `-ext` files are the latin-ext subset**, declared with a `unicode-range`
so they are only fetched when the panel actually renders a character outside
basic latin. A UK or US session downloads the base files and never touches them.

## What was removed

Anthropic Sans, which this extension previously bundled as seven static woff2
files. The Genesis design does not name it, and its redistribution terms were
never established for this repository.
