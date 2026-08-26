# THEME-NOTES — Genesis / Pajamas refactor (Panel C)

Refactor of the extension's two webview surfaces (sidebar, Control Center)
onto the fixed dark Genesis/Pajamas identity from the design handoff's
`Panel C - Pajamas - Genesis Type.dc.html`, per `REFACTOR-PROMPT.md`. This is
a **render-layer replacement**: `src/core`, `src/agent`, `src/endpoints`,
`src/providers`, `src/checkpoint`, `src/diagnostics`, `src/skills`, and the
webview↔host wire contract in `src/ui/protocol.ts` are untouched except for
two cosmetic display strings (see below). Every feature that existed before
this refactor still works.

## What changed, file by file

| File | Change |
|---|---|
| `media/webview/roundel.js` | New. Replaces `crystal.js`. Exposes `window.__kxRoundel = {defs, svg}` — the Bezel Roundel mark (`g-roundel`, `g-roundel-dim`, `g-roundel-sm`, `g-notch`), ported 1:1 from the mockup's `<symbol>` defs. Square 24×24, never the old portrait 42:48. |
| `media/webview/crystal.js` | Deleted. |
| `media/webview/sidebar.css` | Full rewrite. Fixed Genesis/Pajamas tokens (no `--vscode-*`), Panel C component recipes. |
| `media/webview/sidebar.js` | Full rewrite of the render layer. Same `S` store shape, same `post()` calls, same inbound `message` handler — see feature table below for what's new vs. restyled. |
| `media/webview/controlCenter.css` / `.js` | Full rewrite, same tokens/recipes as sidebar, all ten `CcSection`s preserved. |
| `media/fonts/*.woff2` + `media/fonts/LICENSE-NOTE.md` | Anthropic Sans bundled in (see **Font decision** below). |
| `src/ui/shell.ts` | `fontFaces()` now emits Anthropic Sans `@font-face` rules instead of the never-shipped Inter/JetBrains Mono plan; script tag points at `roundel.js`; webview `<title>` strings say "Genesis" / "Genesis Control Center". |
| `src/ui/controlCenter.ts` | Editor-tab title string only: `"KRYPTONITE"` → `"Genesis Control Center"`. |
| `src/core/app.ts` | Two display strings only: output channel name and status-bar text, `KRYPTONITE` → `Genesis`. No logic touched. |
| `package.json` | `viewsContainers`/`views`/`commands`/`configuration.title` display strings → "Genesis". `name`, `displayName`, `publisher`, and every `kryptonite.*` command id / config key are **unchanged** — see **Open question: product identity** below. Added `jsdom` devDependency + `test`/`pretest` scripts (the test files already existed and required jsdom; there was no way to run them before this). |
| `media/icon.svg`, `media/logo.png` | Replaced with the Bezel Roundel (`g-roundel-sm` geometry for the activity-bar SVG; `logo.png` programmatically rendered from the `g-roundel` geometry — see **Marketplace icon** below). |
| `.vscodeignore` | Excludes `kryptonite-0.3.0-source/**` (an old kx-theme snapshot that was not previously excluded and would otherwise have shipped the retired theme back into the `.vsix`), the unrelated `skills/**` bycatch and pasted screenshots that landed in this bundle, and two unreferenced stray root-level `icon.svg`/`logo.png` duplicates of the old shattered-fragment mark. |
| `test/drive.js` | Updated to drive the new DOM (roundel, `.stream-row`, history-as-modal, `.step-row`, todos without checkbox chrome) instead of the old kx markup, plus new assertions for genuinely new behavior (approval-mode sheet, changed-files strip) and regression cases for the six defects found by rendering it. All 71 assertions pass. |
| `test/host.js` | Untouched — it never touched the frontend, only `App`'s activation/session lifecycle. All 28 assertions pass. |

## Feature → recipe → file

| Feature | Recipe used | File |
|---|---|---|
| Header (wordmark, new/history/more) | Header recipe, icon buttons | `sidebar.js` `mount()`, `sidebar.css` `.gx-header` |
| Session/Diagnostics tabs | Tab bar recipe (mono 9px, `box-shadow` underline) | `.gx-tabs`, `.gx-tab` |
| Plan-phase banner | Banner recipe (dot + mono label) | `.gx-banner` |
| Welcome screen + starters + recent sessions | Welcome recipe; "Recent" now wired from real `S.sessions` | `renderWelcome()` |
| User message | Rail-quote row, no bubble/card (per the earlier "todos/cards feel cheap" fix direction) | `.msg-user` |
| Session title | New: pinned header line above the transcript, sourced from real `session.title` in `StateSync`/`sessionSwitched` — the mockup shows this but nothing was wired to it before | `renderTurnTitle()` |
| Tool calls | Grouped "N steps" disclosure (was individually-collapsible cards); each step is itself a mini-disclosure so raw tool output is never lost, just one level deeper | `stepsWrap()`, `.steps-wrap` |
| Diff card | Dual old/new gutters, word-level LCS diff on adjacent del/add row pairs, hunk-boundary marker (see **Not implemented: expand-in-place** below) | `addDiff()`, `wordDiffHtml()` |
| Permission gate | Left-rail card, orange (`--orange`), 3 real decisions (allow/always/deny) as primary+text buttons | `addPermission()`, `.perm-gate` |
| Todos | Railed list, no checkbox chrome — state via weight/colour, not strikethrough | `renderTodos()`, `.todo-list` |
| Streaming indicator | Roundel-dim + sweeping notch, shimmer verb, `esc` hint, `role="status" aria-live="polite"`; a "Finished" row now persists after `turnEnd` (mockup's idle state, previously absent) | `startStream()`/`endStream()` |
| Changed-files strip | New: `fileTouched` was already sent by the host but silently dropped by the old frontend (`case "fileTouched": break;`). Now tracked and rendered as the mockup's disclosure + list | `trackChangedFile()`, `onFileTouched()`, `.chg-strip` |
| History | Was a corner popover; now a real modal (backdrop, `role="dialog"`, search, esc/backdrop-dismiss) per the explicit "pop-up window not another tab" request in the chat log | `openHistory()`/`renderHistory()`, `.modal` |
| Approval mode (ask / edits-auto / full-auto) | New UI: bottom-sheet mode picker wired to the real `setConfig`/`approvalMode` config key, which existed in the protocol but had **no UI exposure at all** before this refactor | `openModeSheet()`, `.mode-sheet` |
| Phase (Plan/Act) | Segmented control, two real states colored green/orange | `.seg` |
| Model picker | List/group recipe, unchanged data source | `renderModelPop()` |
| MCP / MCP config editing / Agents tabs | **Not built** — see below | — |
| Diagnostics: TLS ladder, endpoints table+form, skills list | Rung/table/form/disclosure recipes | `renderTls()`, `renderEndpoints()`, `renderSkills()` |
| Control Center: all 10 sections | Same recipes, mirrored 1:1 from sidebar.css | `controlCenter.css`/`.js` |

## Deliberate divergences from `REFACTOR-PROMPT.md`

1. **Anthropic Sans kept, not Michroma/IBM Plex Sans.** Asked explicitly before
   starting; the project owner chose to keep the already-bundled Anthropic
   Sans faces (`--display`/`--body`) over the brief's original font plan, with
   the redistribution-licensing caveat in `media/fonts/LICENSE-NOTE.md` in
   view. `--mono` still names `'Space Mono'` first for documentation, but no
   Space Mono binary is bundled — the CSP blocks the Google Fonts request the
   mockup's `<link>` tag implies, so it silently falls back to the system
   monospace stack. This is unchanged from what the mockup would actually do
   inside a real `default-src 'none'` webview.
2. **Fixed dark identity, not a VS Code theme follower.** The pre-refactor
   sidebar/CC used `--vscode-*` variables throughout and had light/high-contrast
   overrides. Panel C's tokens are literal hex values with no theme binding.
   This was already implied by "no `--vscode-*` passthrough" in the brief and
   by the mockup itself, but is worth flagging explicitly: **the panel now
   looks the same in every VS Code theme**, including light and high-contrast.
3. **Product identity left alone.** `package.json`'s `name`, `displayName`,
   `publisher`, `description`, every `kryptonite.*` command id and config key,
   the `KRYPTONITE_API_KEY` env var template, and the shadow-git commit
   author (`git config user.name Kryptonite`) are unchanged. Only pure
   *display* strings (command-palette titles, view/activity-bar titles, the
   Control Center editor-tab title, the output-channel name, the status-bar
   text) were relabeled "Genesis" to match the wordmark now shown inside the
   panel itself. **This is a real open question, not a technical one**: the
   in-panel UI now says "GENESIS" while the extension is still installed,
   configured, and scripted as `kryptonite`/`KRYPTONITE`. Renaming the rest
   (marketplace listing, command namespace, settings keys, the env var) is a
   product decision with real consequences for anyone with existing
   keybindings, tasks, or `settings.json` entries referencing `kryptonite.*` —
   it needs an explicit yes, not a guess.

## Not implemented (mockup shows it, nothing in the wire protocol backs it)

Per the adaptation rule "do not invent a new visual pattern" — the flip side
is also true: don't invent a new *backend* to make a visual pattern real.
These all have a ready CSS recipe (`.gx-tab`, `.modal`, `.model-pop`, etc.) if
the protocol grows to support them, but nothing was faked:

- **MCP and Agents tabs.** `protocol.ts` has no server-list or agent-registry
  message types at all. Building these tabs would mean designing new
  `OutboundMessage`/`InboundMessage` variants and host-side data — a real
  feature addition, not a theme change.
- **Extended-thinking toggle and reasoning-effort selector** in the model
  popup. `SelectModelMsg` only carries `endpoint`/`model`; there is no
  thinking/effort concept anywhere in `ConfigKey` or the profile DTOs.
- **Per-line comments on a diff.** The gutter hover affordance is drawn (CSS
  is ready) but does nothing — there's no `commentOnDiffLine`-shaped message.
- **"Expand N lines above/below" on a diff hunk boundary.** The host only
  sends the unified patch text (already windowed to ~3 lines of context per
  hunk by git). Rendering a working expand affordance would need the full
  file content, which nothing currently fetches. The hunk-boundary row is
  still shown, styled to the recipe, but isn't clickable to expand; the
  "Open diff"/file-open actions on the card cover the same need.
- **A third "Ask" phase.** `Phase` is `"plan" | "act"` only in the wire
  protocol of the 0.4.0 snapshot this was built against, so the mockup's
  three-way Act/Plan/Ask segmented control renders here as two states.
  Note that current `main` **does** have all three (its history includes a
  `claude/ask-plan-act-mcp` PR), so this is a gap in the snapshot, not in the
  product — when this theme is redone against `main` the segment becomes a
  genuine three-way control.

  Beware a name collision this creates: the approvals button that sits a few
  pixels to the right of the PLAN/ACT segment reads `ASK` when
  `approvalMode === "ask"`, which looks like the missing third phase but is a
  different concept entirely (what may run without stopping to ask, vs. what
  the model is allowed to do at all). It now carries a mode icon and a
  disambiguating tooltip for exactly that reason. If the third phase does
  land, that button likely needs renaming outright.

## Marketplace icon

`media/logo.png` (256×256) was generated programmatically (Pillow, exact
geometry from the mockup's `g-roundel` symbol — ring, four oxide notches,
core glyph) since no SVG→PNG toolchain or a designer export was available in
this environment. It's geometrically accurate but was never eyeballed by a
person at marketplace-listing size; swap it for a designer export before
publishing if it doesn't look right at that size.

## Bugs found by actually rendering it

The panel was driven in headless Chromium with real `postMessage` traffic
(the webview is a browser frame, so the same CSS/JS renders the same pixels
there as in VS Code). Six defects showed up that reading the code did not,
all now fixed and covered by regression tests in `test/drive.js`:

1. **The streaming row stranded itself above its own work.** `startStream()`
   appends when the turn begins, so every tool step, diff and gate appended
   *after* it — "Thinking…" sat near the top of the transcript with the work
   it described scrolling on below. `add()` now keeps it trailing. (This was
   inherited behavior, not new: the pre-refactor `.stream` div did the same.)
2. **Raw `@@ -12,7 +12,7 @@` headers leaked into the diff**, which the brief
   explicitly forbids. Hunk boundaries now read `11 LINES ABOVE` /
   `N LINES SKIPPED`, and a hunk starting at line 1 renders no marker at all.
3. **`.actions` collided across two components.** The TLS remediation stack
   declared a bare `.actions { flex-direction: column }`; the permission
   gate's own `.actions` row never declared `flex-direction`, so the column
   leaked across specificity and stacked Allow / Always / Deny vertically,
   centered, against the panel edge. The TLS one is now `.tls-actions`.
4. **The history modal was trapped inside the header.** Its scrim is
   `position:absolute; inset:0`, and the nearest positioned ancestor was the
   42px `.gx-header` — so the dialog rendered clipped into the title bar with
   no backdrop. `#histModal` now hangs off `#app`.
5. **The welcome screen never centered.** It carried `flex:1` inside `#log`,
   which is a block box, so the grow factor did nothing and it sat jammed
   against the top of an otherwise empty panel. Now `min-height:100%`.
6. **The approvals button read as a third phase** — see the Ask note above.

Worth stating plainly: items 1, 3 and 4 are the kind of defect that only
appears once something renders. A jsdom suite that asserts on structure
passed all of them, because the DOM was correct and the *layout* was not.

## Definition-of-done self-audit (against `REFACTOR-PROMPT.md`)

- [x] Every webview surface (sidebar, Control Center) renders in the new
      theme. Status bar and output channel display strings match.
- [x] Zero colors outside the token set in the live tree (`grep`-verified);
      zero `--vscode-*`, `kx-`, or `crystal`/`__kxCrystal` references left in
      the live source tree.
- [x] Radii are 3px/4px/0 throughout the new CSS.
- [x] Keyboard: `:focus-visible` ring on every control (inherited base rule);
      Escape ordering implemented (`qp`/model popup → mode sheet → history
      modal → stop streaming); `aria-label` on icon-only buttons;
      `aria-expanded` on disclosures; `role="dialog" aria-modal="true"` on
      both modals; `role="status" aria-live="polite"` on the streaming row.
- [x] `prefers-reduced-motion` kills the shimmer/sweep animations (rule
      carried over verbatim from the mockup).
- [x] Panel survives narrow widths — layout is flex/grid throughout, no
      fixed widths that would overflow at 280px (not verified in a real VS
      Code window; the environment has no way to render one — verify this
      one visually before shipping).
- [x] `npm run typecheck`, `npm run build`, and `npm test` (71 + 28
      assertions, including regression cases for all six defects above)
      all pass clean as of this refactor.
- [ ] Every pre-existing feature reachable and themed — true for everything
      the wire protocol actually supports (see the feature table). The
      **Not implemented** section above lists what the mockup shows that the
      protocol doesn't back yet; those are scoped as follow-up work, not
      silently dropped capability.
- [ ] Visual verification inside an actual VS Code window — this environment
      cannot launch VS Code, so nothing here has been screenshotted or
      eyeballed at real size/DPI. Do that before shipping.
