# THEME-NOTES - Genesis / Pajamas theme on `main`

Branch: `genesis-theme`, cut from `main` at `870d9f9`. Not merged, no PR.

This started as a **render-layer** change and is no longer only that. Two
things reach `src/`:

1. **Fonts.** `src/ui/shell.ts` declares the three families the design names.
2. **Model kind.** A mandatory field on an endpoint profile, which needed the
   protocol, the profile type, the DTO and the YAML template.

Everything else in `src/` is untouched: the agent runtime, MCP client, browser
tooling, endpoint/auth/TLS plumbing, settings schema and command registrations
are exactly as `main` has them.

## Why this branch exists separately from `genesis-theme-reference`

`genesis-theme-reference/` (on the other branch) is a port of the **0.4.0
snapshot** bundled in the Claude Design handoff. That snapshot predates MCP,
Agents, browser tooling, inline completion and the third `ask` phase, so the
reference port has no MCP or Agents tab and cannot grow one without inventing
a wire contract. This branch themes the real thing instead.

## J1 - Inventory of everything the extension contributes

Taken from `package.json` and `src/`, not from memory.

### Commands (20)

| Command | Title |
|---|---|
| `genesis.focusSidebar` | Focus sidebar |
| `genesis.openControlCenter` | Open Control Center |
| `genesis.openBrowser` | Open browser |
| `genesis.closeBrowser` | Close browser |
| `genesis.newChat` | New chat |
| `genesis.runDiagnostics` | Run connection diagnostics |
| `genesis.selectEndpoint` | Select active endpoint |
| `genesis.newEndpoint` | Create endpoint profile |
| `genesis.restoreCheckpoint` | Restore checkpoint |
| `genesis.exportBundle` | Export offline bundle |
| `genesis.selectAgent` | Select agent |
| `genesis.newAgent` | Create agent |
| `genesis.exportChat` | Export chat as JSON |
| `genesis.exportAllChats` | Export all chats as JSON |
| `genesis.fixProblem` | Fix this problem |
| `genesis.documentSymbol` | Document this |
| `genesis.explainSelection` | Explain this |
| `genesis.writeTests` | Write tests for this |
| `genesis.generateCommitMessage` | Generate commit message |
| `genesis.watchAgentBrowser` | Watch the agent browser |

### Settings (15)

`profileDirectory`, `skillsDirectory`, `instructionsFile`, `editorContext`,
`browserHeaded`, `activeProfile`, `approvalMode`, `caBundlePath`, `codeLens`,
`codeActions`, `inlineCompletion`, `searchProvider`, `searchApiKey`,
`searchEngineId`, `browserProfile` - all under the `genesis.*` namespace.

### Views, providers and surfaces

| Contribution | Detail |
|---|---|
| View container | `genesis` in the **primary** sidebar, icon `media/icon.svg` |
| Webview view | `genesis.sidebar` |
| Webview panels | Control Center, Agent browser (`createWebviewPanel` x2) |
| Inline completion provider | 1 |
| CodeLens provider | 1 |
| Code actions provider | 1 |
| Status bar item | 1 |
| Menu contribution | `scm/title` (commit message) |
| Keybindings | none contributed |
| Notifications | 11 info, 8 warning, 7 error call sites |
| Quick picks | 4 |

### Webview surfaces (4 documents, 8 files)

`sidebar.{js,css}`, `controlCenter.{js,css}`, `browser.{js,css}`, plus the
shared `tokens.css` and `crystal.js`.

### Control Center sections (10)

`endpoints`, `wire`, `auth`, `tls`, `proxy`, `diag`, `agent`, `skills`,
`checkpoints`, `logs`.

## J2 - Mapping: feature -> recipe -> surface -> file

Nothing maps to "removed".

| Feature | Recipe | Surface | File |
|---|---|---|---|
| Wordmark + brand mark | Top strip; Bezel Roundel | sidebar header | `crystal.js`, `sidebar.css` |
| Session / MCP / Agents / Diagnostics tabs | Tab bar, mono 9px, per-tab accent | sidebar | `sidebar.css` |
| Active-agent chip row | Chip row with stop control | sidebar | `sidebar.css` |
| Chat transcript, tool calls, diffs | Disclosure + dump; diff gutter | Session | `sidebar.css` |
| Todos | Rule + weight, no card, no checkbox | Session | `sidebar.css` |
| Changes tray | Collapsible file list | Session | `sidebar.css` |
| Composer, phase, model, attach | Segmented control; popup; icon button | Session | `sidebar.css` |
| MCP servers | List row with status rail | MCP | `sidebar.css` |
| MCP tool chips | Chips, read-only blue / writes amber | MCP | `sidebar.{js,css}` |
| Agents list, Use/Leave, Live badge | List row + badge + buttons | Agents | `sidebar.css` |
| TLS ladder, endpoints, skills | Rung list; table; disclosure | Diagnostics | `sidebar.css` |
| Control Center (10 sections) | Table, form row, disclosure + dump | Control Center | `controlCenter.{js,css}` |
| Agent browser | Same tokens and button recipe | Browser panel | `browser.css` |
| Status bar item | VS Code native, text only | status bar | `src/core/app.ts` (untouched) |
| Notifications, quick picks | VS Code native chrome | host | untouched |
| CodeLens / code actions / inline completion | VS Code native chrome | editor | untouched |

Host-rendered surfaces (status bar, notifications, quick picks, CodeLens,
inline completion) are **not themeable from a webview stylesheet** - VS Code
draws them. They are listed so the inventory is complete, not because this
branch changes them.

## What has actually been done on this branch

- Genesis palette on main's `--kx-*` names (`tokens.css`), with two
  structural notes recorded in the file: main's surface scale ascends and
  Genesis's does not, and `--kx-under` folds into blue.
- Bezel Roundel under main's `__kxCrystal` contract (`crystal.js`), `i-kx`
  symbol id preserved so no call site changed. Notches stay oxide.
- Tab bar, buttons, badges to the mono 9px uppercase scale; radii to 4/3/0.
- Todos stripped of card and checkbox chrome; no strikethrough.
- Webview copy says Genesis.
- MCP tool chips coloured by capability (audit D4).
- **The three fonts the design names**, bundled and declared: Michroma for the
  wordmark, Space Mono for every uppercase label, IBM Plex Sans for body copy.
  All three are OFL 1.1 and their licences ship beside them in `media/fonts`.
  Anthropic Sans is removed - see "Reversals" below.
- **Model kind on an endpoint profile**, mandatory, end to end.

## Colours taken literally from the mockup

The colour work went through a pass where it was reproduced from the mockup
value by value rather than from a semantic table. Four things changed, and
all four were places where an earlier reading of the design was wrong:

| Surface | Was | Is | Why |
|---|---|---|---|
| The purple token's name | `--kx-mcp` | `--kx-agent` | the design gives MCP green and purple to agents, and a connected server was once painted purple on the strength of the name alone |
| Active phase segment | coloured text on a raised plate | filled with the phase hue, ink label | the mockup fills it |
| Phase hues | Ask blue-300, Plan orange, Act green | Ask blue-400, Plan purple-400, Act orange-400 | the mockup's own assignment |
| Tab underline | one blue for all four | Session blue, MCP green, Agents purple, Diagnostics orange | the mockup gives each tab a hue |
| Connected MCP server | purple rail and pill | green rail and pill | purple belongs to agents; the mockup puts green on a connected server |

Fills are the mockup's `-400` values unaltered. Only **text** is lifted, and
only where the mockup's own value misses WCAG AA on the ground it sits on:
`--kx-fg-2`, `--kx-fg-3`, `--kx-error`, `--kx-agent`, and the Plan banner label,
which takes purple-300 because purple-400 as text on `--kx-bg` is 4.11:1.
Ink on all three phase fills clears AA without help (5.25 / 4.94 / 7.03).

## Model kind - a mandatory field on an endpoint

This branch and a parallel session both built this field, and the merge kept
the parallel one, which is the better design. It is recorded here because the
two disagreed on something real.

The kinds are **chat**, **reasoning**, **multimodal**, **coding** and
**completion** - `src/endpoints/llmKind.ts`. This branch had proposed `chat |
reasoning | multimodal | embedding`, and `embedding` was the wrong fifth: an
embedding endpoint is not something you select as the chat model at all, so
listing it makes the picker offer a choice that can only be a mistake. What
the field is actually for is telling apart three models you *would* pick
between, and a FIM base model, which cannot drive a tool-calling loop.

The surviving version is also load-bearing rather than decorative: a kind
seeds capability defaults, so choosing multimodal turns vision on and choosing
completion turns tools off.

Mandatory rather than defaulted, because there is nowhere to get it from.
Genesis cannot ask an OpenAI-compatible gateway what a model is, and guessing
from the id is how a fill-in-the-middle base model ends up selected as the chat
model and fails on its first turn with a shape error instead of a sentence.

The form lives in the **sidebar**, under Diagnostics -> Endpoints ->
"+ Add endpoint". See the dead-code note below.

### Defects found and fixed while building

1. **13 of main's 52 WCAG contrast checks failed** on the first palette.
   Raised to Genesis's lighter `-300`/`-400` steps, darkened
   `--kx-surface-4`, and made the idle send button brighten on hover
   instead of staying dim. 52/52 now pass.
2. **Agents footer overflowed** - it sits outside the padded list container
   and pushed its button past the panel edge at 420px.
3. **Centred mono labels sat left of centre.** Letter-spacing is applied
   after the last character too; compensated with a matching `text-indent`.
4. **Em-dashes** in the two new files broke the repo's house rule.
5. **A nested helper truncated its enclosing function.**
   `test/mcp-render.cjs` lifts functions out of `sidebar.js` by brace
   matching, so `mcpToolWrites` nested inside `renderMcp` silently cut
   `renderMcp` in half. The suite aborted with a SyntaxError rather than
   reporting a failure - which is why **the run's exit code is the signal,
   and grepping for FAIL lines is not**. The helper is now self-contained
   beside `mcpPill`, and the test grabs it explicitly.

## Reversals, stated plainly

**Anthropic Sans was removed** after the project owner had earlier chosen to
keep it. The later instruction was "same fonts, colors, design" against a
mockup that names Michroma, Space Mono and IBM Plex Sans and does not name
Anthropic Sans. Keeping it would have meant shipping a font the design does
not use, whose redistribution terms for this repository were never settled.
The seven woff2 files are deleted, not orphaned. Reverting is a `git revert`
of the commit that removed them.

## Dead code found, not written

`endpointForm()` in `media/webview/controlCenter.js` **cannot render**. Nothing
in that file ever sets `S.epForm`, and `genesis.newEndpoint` writes a YAML
file and opens it in the editor instead. The mandatory model-kind field was
added there first and had to be moved to the sidebar form, which is the one a
user can actually reach. The Control Center copy is left in place and left
consistent; deleting it is a separate decision from theming it.

## Two class collisions, same failure mode

`.actions` and `.perm` were each declared twice in `sidebar.css` for two
unrelated components. Same specificity, so the later block silently won:
`.perm` was handing the permission **card** `background: none`,
`border: 1px solid transparent` and `display: flex`, stripping its surface and
laying its title, body and command dump out in a row. The button is renamed
`.perm-btn`. Worth grepping the rest of the file for a third.

## A real bug in the MCP tab, found by matching the mockup

`mcpPill()` had no branch for `idle`, so an idle server - declared, reachable,
nothing asked of it this session - fell through to the red **unavailable**
pill. The loudest thing the tab can say, about the one state that means
nothing is wrong. The mockup paints idle orange, which is what pointed at it.

## Verification

`npm run verify`: **2732 assertions, 0 failed, exit 0.**
`npm run package`: the archive gate at **29** and the paint gate at **51**.
Every tab and the Control Center screenshotted with 0 runtime errors, driven
by a fixture shaped to main's real DTOs, plus an automated overflow probe at
280px and 900px that fails the run rather than being eyeballed.

### What the overflow probe could not see

A later screenshot pass at 280px found three defects the probe reported clean,
and the reason is worth keeping: **`document.scrollWidth` is the wrong
instrument for a panel made of scroll containers.**

- "Edit config" was past the right edge of `.mcp-wrap`, which is a scroller.
  It was therefore CLIPPED rather than pushing the page, so the document never
  widened and the probe saw nothing. A button can be absent without costing a
  pixel.
- A server's tool count was painted over its read-only pill. An overlap costs
  no width at all.
- The composer's action group wrapped onto a row of its own. Every control was
  inside the panel; only its POSITION was wrong.

`test/render.cjs` now asks the three questions that catch those: is each
control inside its own scroll container, does any text box intersect a
control's box, and which item is the one that wraps. Each was checked by
putting the defect back and watching the assertion name it.

The exit code is the signal. A crash is not a FAIL line and a hang is not a
failure, and an exit code you never received is not an exit code of zero.

Tests were updated for the rename, never weakened: the crystal-artwork
assertions now pin the roundel's four variants and its oxide notch fills, and
`mcp-render.cjs` pins the chip classification including the unknown-verb
default.

## Not yet done

The audit's remaining IDs. Nothing below is stubbed or faked - it is simply
not built yet on this branch:

- **A6** - the audit lists a five-tab bar including `Control`; main has four
  and keeps the ten Control sections in the Control Center panel instead.
- **B9/B10** - per-line diff comments and the inline composer. No protocol
  message exists for attaching a note to a line.
- **C3** - the token-highlight mirror layer over the textarea.
- **C8/C9** - thinking toggle and effort selector. `SelectModelMsg` carries
  endpoint and model only.
- **F3** - focus trap and focus restore on the modals.
- ~~The Agents tab carries two identical "New agent" buttons.~~ Done: the
  footer copy is gone and the footer now states which agent is in force and
  nothing else. See the note beside `sk-foot` in `sidebar.js`.
- **G1-G5** - the Control tab as the audit describes it.
- **H3/H4/H5/H8** - the `s_client`, endpoint, skills and live-command dumps.
- **J4** - the per-feature regression pass over all 20 commands.
