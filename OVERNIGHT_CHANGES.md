# Overnight changes

Branch `claude/analyze-project-files-fb32f2`. Four local commits, nothing pushed.
`npm run verify` (typecheck + full suite) passes at every commit: **1,353 assertions, 0 failures**.

The short honest version: **3 of the 13 Tier 1 items are done and verified. 1 was
already built before tonight. 9 are not started.** Tier 2 was not reached. What
follows says which is which, and why.

---

## Two premises in the brief were out of date

Worth reading first, because they changed what was worth building.

**"An early open-browser tool that just opens an external tab — no embedded
browser pane yet."** Not so. `src/browser/cdp.ts` drives a real Chromium over
the DevTools Protocol: it navigates, clicks by ref, types, scrolls, and
screenshots. Earlier tonight I wired those screenshots into the model's context
as image blocks. Tier 2's *"prefer an Electron `<webview>` over a headless
screenshot pipeline"* would therefore be a **regression** — a `<webview>` cannot
click a button or read an accessibility tree. I did not touch it.

**Tier 1 #4, "conversation list with titles instead of a blank placeholder."**
Already implemented before tonight: `SessionStore`, `titleFrom()` auto-titling
from the first message, per-workspace persistence outside the repo, and a
history popover listing every conversation with its message count and an active
marker. I verified it rather than rebuilding it. **No work needed.**

---

## Done and verified

### 1. Project instructions file — Tier 1 #8
`.agent/instructions.md`, read into the stable head of every system prompt.

**Decision: `.agent/`, not `.kryptonite/`.** The brief suggested the latter, but
endpoints, skills, transforms and `mcp.json` already live under `.agent/`. A
second dot-directory would be a second convention for no gain. The path is the
`kryptonite.instructionsFile` setting for anyone who disagrees.

**Decision: a parameter, not a read inside the loop.** The system prompt is a
cache key. The pre-warm and the real request must build the same bytes, so the
text is passed into `runAgent` rather than read from disk inside it.

**Decision: capped at 16,000 characters, truncation stated in-band.** A file
someone pastes a manifest into must not quietly consume a 32k window, and a
model reading a fragment should be told it is reading one.

Placed after the engine's own rules and before the plan addendum: a workspace
convention refines how to work rather than replacing it, and the addendum has
to keep the last word or plan phase stops being a promise.

`src/core/instructions.ts` (new), `src/agent/loop.ts`, `src/core/app.ts`,
`src/ui/session.ts`, `package.json`, `test/instructions.ts` (new, 24 assertions).

### 2. Ambient editor context — Tier 1 #3, #6, #7
One coherent unit, because they answer one question: what is on the user's
screen. A user who types "fix this" has a file open, a cursor in it, a squiggle
on line 88 and four tabs they were reading; none of it used to reach the model.

Covers the active file (path, language, length, cursor line, dirty state), other
editors in a split view, the open tabs via `window.tabGroups`, the compiler's
diagnostics for the active file via `languages.getDiagnostics()`, and everything
else in the workspace as a **count** rather than a list.

**Decision: it rides in the user message, not the system prompt.** Not
stylistic — the system prompt is a cache key and this text changes whenever the
cursor moves. At the head it would miss the prompt cache on every single turn.

**Decision: the block says it was gathered automatically.** Without that a model
cannot distinguish a file the user attached from one that merely happened to be
focused, and it answers about whatever was on screen instead of what was asked.

**Decision: hints and information-level diagnostics are excluded.** A spelling
suggestion is the editor talking to itself, not a problem.

Everything is capped — 10 tabs, 12 problems, 200 characters per message. A busy
editor measures ~566 characters, about **160 tokens per turn**.
`kryptonite.editorContext` turns it off for windows too small to afford it.

The composer gained a "current file" readout, deliberately unlike the attachment
chips: quieter, and with no dismiss button, because it reports where the cursor
is rather than something the user chose. Verified rendering in a browser.

`src/core/editorContext.ts` (new), `src/core/app.ts`, `src/ui/protocol.ts`,
`src/ui/session.ts`, `media/webview/sidebar.js`, `media/webview/sidebar.css`,
`package.json`, `test/editor-context.ts` (new, 29 assertions),
`test/vscode-stub.ts`, `test/host.js`.

### 3. Animated input aura — Tier 1 #1
`conic-gradient` swept by an animated registered `@property --kx-angle`. Off at
rest, 4.2s per turn on focus, 2.4s while streaming. No library.

**Decision: two background layers, not a pseudo-element.** Surface painted to
the padding box, gradient to the border box, visible only through a transparent
1px border. The pseudo-element version must drop `overflow: hidden` to avoid
clipping itself, and the pills and toolbar lose their rounded corners with it.
The border stays 1px so nothing moves when the aura lights.

**Decision: the focus ring stays.** A gradient is not a 3:1 focus affordance —
parts of any sweep are low-contrast against the surface. The ring remains the
accessibility contract, which is what makes the aura safe to be decoration.
Reduced motion holds the rim still rather than removing it.

This is the third documented exception to the "no glows, no gradient fills" rule
at the top of `sidebar.css`; that comment now records it instead of being
quietly contradicted.

**Verified in a real browser**, because jsdom implements none of this: at 600ms
of the 2400ms cycle `--kx-angle` reads `90deg`, exactly a quarter turn, and the
composer measures the same height in all three states. The 20 tests pin what a
browser cannot be run for in CI — the registration, both triggers, the ring, the
reduced-motion block, the clipping — each of which fails *silently*.

`media/webview/sidebar.css`, `media/webview/sidebar.js`, `test/aura.cjs` (new,
20 assertions).

### Also landed tonight, before this brief
Screenshots now reach the model as image blocks on both wires, gated on
`capabilities.vision`; `capabilities.maxImageBytes` bounds the request body;
the panel moved to the Secondary Side Bar. Three defects found by measurement:
a screenshot counted as ~157,000 tokens instead of ~1,400; a photo page sent as
a 1.2 MB png; alt text never reaching the model at all. Plus the first render
coverage for `controlCenter.js`, which immediately found an unguarded
`sv.tools.length` that took down the entire pane.

---

## Not done

Nine Tier 1 items are **not started**. No half-built code was left behind and
nothing was reverted — I did not begin any of them. Plans below.

I stopped adding features while I could still write this file and package
cleanly. Three features carrying real tests are worth more than nine with the
build red, and the brief said so explicitly.

### #2 Ghost-text completions — the largest, and the one I'd think hardest about
Plan: `registerInlineCompletionItemProvider({ pattern: "**" })` for breadth.
Debounce ~250ms on `onDidChangeTextDocument`, key an LRU cache on
`(uri, version, prefixHash)`, and hand the `CancellationToken` straight to
`EndpointClient.complete({ signal })` — the client already takes an
`AbortSignal`, so cancellation is wired end to end.

**Read this before building it.** Inline completion wants sub-500ms round trips
and a fill-in-the-middle endpoint. This extension exists for corporate gateways
that typically offer neither. It is the feature most likely to feel broken on
precisely the endpoints the product targets. If built, gate it behind
`capabilities.fim` (a new capability, defaulting false) and a `kryptonite.inlineCompletion`
setting defaulting **off**, so it is opt-in for people whose endpoint can carry it.

### #5 Background streaming across conversation switches
Today `SessionController` holds a **single** `this.abort`, so the design is
genuinely absent. Plan: replace it with `Map<sessionId, {abort, buffer, history}>`,
move the replay buffer in beside it, and make `loadSession`/`newChat` swap the
active key rather than call `interruptQuietly()`. The webview needs to render
from the buffer for whichever id it is showing. Test: start a turn, switch away,
switch back, assert the full text arrived — the brief is right that this needs
an explicit test, and it is why I did not attempt it in the time left.

### #9/#10/#11 CodeLens, code actions, doc comments
One cluster sharing an "invoke the model outside a chat turn and apply an edit"
path that does not exist yet. Build that first: a small `oneShot(prompt)` helper
on `App` returning a string, plus a `WorkspaceEdit` applier with a diff preview.
Then the three providers are thin. #10 is the highest value of the three now
that diagnostics are already gathered — `editorContext.ts` produces exactly the
`ProblemRef` a "Fix with Kryptonite" action needs.

### #12 Slash commands
`/` in the composer already opens a picker listing **skills**. `/fix`, `/tests`,
`/explain`, `/doc` must merge into that picker rather than shadow it, or one of
the two silently stops working. Plan: give the picker two groups (commands,
skills), and implement each command as a prompt template that reuses the editor
context from #2 above — `/fix` with no argument should mean "the diagnostics
already in the turn".

### #13 Commit message generation
Plan: `vscode.extensions.getExtension("vscode.git").exports.getAPI(1)`, take
`repo.state.indexChanges`, cap the diff (a 5,000-line diff is not a prompt),
call the one-shot helper from the #9 cluster, and set `repo.inputBox.value`.
Needs the same non-chat model path, which is why it is grouped with them.

### Tier 2 — not reached
Not attempted, so nothing to revert. Two notes worth keeping:
- **Built-in browser pane**: already exists and is better than the suggested
  approach. Do not replace CDP with a `<webview>`.
- **First-pass semantic index**: the honest overnight version is embeddings over
  file chunks in a JSON file with a content hash per chunk. Production-grade
  indexing — a real vector store, incremental re-indexing, evaluation — is a
  much larger follow-on project and should not be confused with it.

---

## Tier 3 — roadmap only, deliberately untouched

- **Next Edit Suggestions** — needs a specially trained model; not bootstrappable in a session.
- **Full semantic index at production scale** — needs a vector store, incremental re-indexing and evaluation.
- **Chat participants API** — designing a public extensibility surface is a product decision, not a build.
- **Coding agent (issue → PR)** — needs GitHub OAuth, an execution sandbox, and safety review before touching live repos.
- **Knowledge bases / Spaces** — needs backend storage and indexing beyond a local extension.
- **CodeQL autofix** — depends on GitHub Advanced Security; not buildable client-side.
- **Other IDE/platform surfaces** — separate products and codebases, not extensions of this one.
- **Content exclusion, audit, policy, seats** — org admin and billing infrastructure, not extension features.

---

## Assumptions I made without asking

1. `.agent/instructions.md` over `.kryptonite/instructions.md` — matches every existing convention in the repo.
2. Editor context defaults **on**. It costs ~160 tokens a turn and is what makes "fix this" resolve to anything; the setting exists for small windows.
3. The aura triggers on focus **and** streaming, not one or the other. Focus alone would leave the streaming case dead, which is the case it is for.
4. Diagnostics are limited to errors and warnings. Hints and information are editor chatter.
5. Only the **active file's** diagnostics are listed; the rest of the workspace is a count. A model fixing one file does not need 400 warnings from elsewhere.
6. Features were committed individually, but tonight's pre-existing uncommitted work went in as one commit — those changes were entangled across shared files and `git add -p` is not available non-interactively.

## Build and package

`npm run build` (esbuild, not `compile`) and `npm test` both clean. The `.vsix`
is built with `npm run package`, which wraps `vsce package --no-dependencies`;
`npx @vscode/vsce package` would work too but ignores that flag and the repo's
pinned vsce.
