# Genesis / Pajamas theme — reference implementation, not a merge candidate

This directory is **not wired into the extension**. It's a themed
implementation of `Panel C - Pajamas - Genesis Type.dc.html` (the Claude
Design mockup) built against a **0.4.0 snapshot** of this repo — the version
bundled into that design handoff. `main` has since moved to 0.8.0 and grown
well past that snapshot: an Agents tab, an MCP tab, browser tooling
(`media/webview/browser.js`/`.css`), `tokens.css` split out on its own, and a
`sidebar.js` that's roughly 5x the size of the one in this directory. None of
that exists in what's here.

**Do not copy these files over the live `media/webview/*` paths.** Doing so
would delete real, current functionality this reference implementation knows
nothing about.

## What this actually is

A from-scratch restyle of the sidebar and Control Center surfaces onto a
fixed Genesis/Pajamas dark identity (replacing the `--vscode-*`-following kx
theme), matching the mockup's tokens, iconography (a new Bezel Roundel mark),
and component recipes — diff cards with dual gutters and word-level
highlighting, a modal history picker, a wired-up approval-mode selector,
todos without checkbox chrome, and so on. Full accounting of what was built,
what was deliberately left unimplemented (because the 0.4.0 protocol it was
built against had no MCP/Agents concepts at all — which is no longer true on
current `main`), and open questions (font licensing, product-identity
naming) is in `THEME-NOTES.md` in this same directory.

## What it's for

Landing the *visual direction* on GitHub where it can be reviewed, without
pretending it's a drop-in update against the real, current source. Turning
this into an actual mergeable change means re-doing the restyle against
current `main` — reading the real `sidebar.js`/`controlCenter.js`/`protocol.ts`
as they stand today (44 TS files, ~9,800 lines across the two webview
surfaces) and re-applying the same Panel C recipes to *all* of it, including
the Agents/MCP/browser surfaces this reference never saw. That's a
substantially bigger job than this directory represents.
