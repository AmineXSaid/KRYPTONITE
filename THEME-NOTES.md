# THEME-NOTES - Genesis / Pajamas theme on `main`

Branch: `genesis-theme`, cut from `main` at `870d9f9`. Not merged, no PR.

This is a **render-layer** change. `src/` is untouched apart from nothing at
all so far: every edit lives in `media/webview/*` and `test/*`. The agent
runtime, MCP client, browser tooling, endpoint/auth/TLS plumbing, settings
schema and command registrations are exactly as `main` has them.

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
| `kryptonite.focusSidebar` | Focus sidebar |
| `kryptonite.openControlCenter` | Open Control Center |
| `kryptonite.openBrowser` | Open browser |
| `kryptonite.closeBrowser` | Close browser |
| `kryptonite.newChat` | New chat |
| `kryptonite.runDiagnostics` | Run connection diagnostics |
| `kryptonite.selectEndpoint` | Select active endpoint |
| `kryptonite.newEndpoint` | Create endpoint profile |
| `kryptonite.restoreCheckpoint` | Restore checkpoint |
| `kryptonite.exportBundle` | Export offline bundle |
| `kryptonite.selectAgent` | Select agent |
| `kryptonite.newAgent` | Create agent |
| `kryptonite.exportChat` | Export chat as JSON |
| `kryptonite.exportAllChats` | Export all chats as JSON |
| `kryptonite.fixProblem` | Fix this problem |
| `kryptonite.documentSymbol` | Document this |
| `kryptonite.explainSelection` | Explain this |
| `kryptonite.writeTests` | Write tests for this |
| `kryptonite.generateCommitMessage` | Generate commit message |
| `kryptonite.watchAgentBrowser` | Watch the agent browser |

### Settings (15)

`profileDirectory`, `skillsDirectory`, `instructionsFile`, `editorContext`,
`browserHeaded`, `activeProfile`, `approvalMode`, `caBundlePath`, `codeLens`,
`codeActions`, `inlineCompletion`, `searchProvider`, `searchApiKey`,
`searchEngineId`, `browserProfile` - all under the `kryptonite.*` namespace.

### Views, providers and surfaces

| Contribution | Detail |
|---|---|
| View container | `kryptonite` in the **secondary** sidebar, icon `media/icon.svg` |
| Webview view | `kryptonite.sidebar` |
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

## Verification

`npm test`: **2282 assertions, 0 failed, exit 0.**
Every tab and the Control Center screenshotted with 0 runtime errors, driven
by a fixture shaped to main's real DTOs.

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
- **G1-G5** - the Control tab as the audit describes it.
- **H3/H4/H5/H8** - the `s_client`, endpoint, skills and live-command dumps.
- **J4** - the per-feature regression pass over all 20 commands.
