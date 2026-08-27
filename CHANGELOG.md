# Changelog

## Unreleased

### Added
- **A read-only MCP server can now be used in Ask and Plan.** Mark it
  `"readOnly": true` in `.agent/mcp.json` and its tools are offered in the two
  modes that previously withheld MCP entirely.

  The old blanket rule was defensible - MCP has no way for a server to declare
  a tool read-only, so there was nothing to check - but it produced a bad
  outcome: a server that genuinely only reads was locked out of Ask, the
  read-only mode, and you had to enter Act, the mode that can also edit files,
  to run a search. The safest servers were excluded from the safest mode.

  What was missing is not something the protocol can supply. It is a statement
  by the person who configured the server, so now they can make it. **It is a
  claim, not a proof**: nothing inspects what the server does, exactly as
  nothing checks that `approval: "auto"` was wise. The MCP tab shows a
  `READ-ONLY` chip on a marked server whose tooltip says you declared it and
  the extension did not verify it - a claim nobody can see is a claim nobody
  can audit.

  Unmarked servers are entirely unaffected: still withheld in Ask and Plan,
  still refused at the call if the model names one anyway. Only a literal
  `true` counts - `readOnly: "true"` is warned about and treated as false,
  because widening what those modes may reach on the strength of a typo is
  exactly the failure this flag must not have.
- **The panel now ships the fonts it is drawn in.** IBM Plex Sans for the
  interface, Space Mono for every mono run in it, and Michroma for the GENESIS
  wordmark - the three families the Genesis design specifies. None of them were
  previously rendering. `--kx-mono` had *named* Space Mono for several releases
  without bundling a binary, and the webview CSP is `default-src 'none'` with
  `font-src` scoped to the extension, so a named-but-absent family cannot be
  fetched: every mono run in the panel - tab labels, model ids, timings, code -
  was silently the platform monospace. Naming a font is not shipping one, and
  nothing reported the difference.

  This also settles a licensing question that was blocking release. The seven
  Anthropic Sans faces bundled before are proprietary, and
  `media/fonts/LICENSE-NOTE.md` recorded their redistribution as *unresolved*,
  prescribing either written permission or a fall back to a licensed face. All
  three families the design specifies are SIL Open Font License, so matching
  the design and clearing the blocker turned out to be one change. The
  Anthropic Sans binaries are removed; `git log` retains them. 94 KB ships in
  their place, down from 236 KB.

  Michroma is on its own `--kx-brand` token rather than `--kx-display`. It has
  one weight and is drawn to be set once under heavy tracking; pointing the
  display token at it would have set every markdown heading in the transcript
  in a display face at a weight it does not have.
- **The welcome screen is the one the design draws.** It was a centred crystal
  over "How can I help?" - which is what every assistant says - and up to three
  resume chips. It now opens with the mark and the GENESIS wordmark, then two
  lists: **Try**, three openers, and **Recent**, the conversations already in
  progress with an All that opens the full history.

  The openers are the part worth being careful about. Invented suggestions were
  removed from this screen once before, correctly, for naming code no workspace
  has. These name none: each is a command the extension already has, aimed at
  what the user has open right now - explain the open file, review the
  uncommitted changes, write tests for the selection.

  The whole column is left-aligned, as the design has it. Everything below the
  intro is a list of rows, and a centred mark above a left-aligned list gives
  the column two different axes.
- **Every endpoint declares what kind of model it serves.** `kind:` is
  mandatory on new profiles - one of `chat`, `reasoning`, `multimodal`,
  `coding`, `completion` - and the Add-endpoint form refuses to save without
  it. A gateway cannot be asked this: `model:` is an opaque id and `baseUrl` is
  a hostname, so the extension was assuming "chat" and hoping, which is how a
  fill-in-the-middle base model ends up being offered tools it has no grammar
  for and fails on its first turn.

  The field is load-bearing rather than a label. It seeds the capability block:
  `multimodal` turns `vision` on, `reasoning` raises the output budget to 8192
  because thinking spends tokens before the answer does, and `completion` turns
  `tools` off and `fim` on. Seeding never overrides - a hand-written
  `vision: false` on a multimodal profile still wins - so `kind` is the
  headline and `capabilities:` stays the detail.

  A profile written before the field existed loads as `chat` rather than
  failing; a *misspelled* one is refused, because that is the case where
  silently seeding the wrong capabilities leaves nothing to point at months
  later.
- **The model picker says which kind each endpoint serves.** The rows were a
  tick and a model id, which told you nothing about what you were choosing
  between. They now carry the Genesis listbox shape - a selection dot, the
  model id over a sentence describing the kind, and a hue-coded tag - so eight
  profiles can be told apart at a glance. Colour follows the same argument the
  MCP tool chips make: the slot holds a classification, and telling them apart
  is the point. The Endpoints list in Diagnostics carries the same tag, so the
  answer is visible where endpoints are managed as well as where they are
  chosen - a profile that failed to parse shows none, having no honest one to
  report.

  The picker groups **by kind**, not by endpoint. Endpoint was the obvious
  grouping and the wrong one: with one model per profile it put a header above
  every single row, so the list was twice as tall as it needed to be and every
  header restated the name the row below already carried. What a user is
  choosing between here is capability - the one that thinks, the one that sees -
  so that is what the headers say, hue-coded, in a fixed order that does not
  depend on which order the profiles happened to load in. The endpoint moves
  onto the row, where it answers "which of these serves it", and the context
  window takes the right-hand slot the design puts a figure in.
- **Agents have a tab.** They were a collapsed section inside Diagnostics,
  which is where a thing goes to be inspected rather than used, three clicks
  from the composer and behind a heading nobody opens twice. The tab sits after
  MCP, because that is the order the two are chosen in: a server has to be
  configured before an agent can be scoped to it. It carries the list, the
  scope each agent enforces, the file each came from, and a New agent button in
  a sticky header so the one always-available action does not depend on there
  being anything in the list.
- **A count on the Agents tab**, following the rule MCP and Diagnostics already
  use: warnings, not totals. How many agents exist is not news and is on the
  tab's own page; a file that failed to parse is something the user has to be
  told about while looking somewhere else.

### Changed
- **The mode picker is a sheet, and it no longer offers Plan.** Plan is a
  *phase*, and it already exists as the middle segment of the ASK/PLAN/ACT
  control two inches to the left; offering it here too put one setting behind
  two controls that could disagree. What is left - Manual, Accept edits, Auto -
  maps one-to-one onto the three approval modes the host has always had.

  The picker itself is now the Genesis sheet: the panel dims, it rises from the
  bottom edge, and each mode states what it means in a sentence with a filled
  radio rather than a tick. Its metrics are sized to the panel rather than to a
  phone - the card is `height: auto` so it is exactly as tall as its three
  rows, capped at `min(72%, 300px)` so it yields on a short panel, and its
  gutters and type step down through `clamp()` as the panel narrows. Dropping
  Plan is what makes that compact size honest: three rows fit without scrolling
  at any panel height worth using.
- **Exactly one row in the model picker claims to be the selection.** The dot
  was bound to `data-active`, which is the *keyboard cursor* and moves with the
  arrow keys - so Auto and the endpoint it had resolved to both lit up, which
  reads as two selections. Selection is now its own state, and when Auto is in
  force its row names the endpoint it resolved to rather than restating the
  rule.
- **The send control is a rounded square.** A disc reads as a media button, the
  thing a consumer app puts under a video, and every other control in the
  composer is a rectangle with soft corners, so it was the one shape belonging
  to a different product. At a third of its own width it stays in the same
  family as the phase segments and the pills while remaining the heaviest
  element in the row, which is what a primary action should be. Armed it is the
  only filled control there, so the eye lands on it without anything else
  having to get louder; stop goes quiet rather than red, because red would say
  "something failed" at the moment nothing has. A press scales it, and reduced
  motion turns that off.
- **The composer has room to breathe.** A slightly larger corner radius, and
  padding in the text area and the toolbar that stops the first line sitting on
  the border. Nothing moved, nothing was added: the same controls, spaced like
  they were meant to be read.
- Agents are no longer listed in Diagnostics. One home, not two.

## 0.8.0

The editor surface. Genesis had one place to work, a panel, and everything
it could do had to be asked for there. This release is the other half: the
model reaches the file you are looking at, the cursor you are at, and the
errors already on screen, and it answers in the editor rather than beside it.

This merges a line of work that had been running in parallel since 0.5.4 and
had never reached main.

### Added
- **Ghost-text completion.** Suggestions at the cursor, behind two gates that
  both default off: `capabilities.fim` on the profile and
  `genesis.inlineCompletion` in settings. Either one off and not a single
  request is sent. Fill-in-the-middle needs a fast endpoint and most corporate
  gateways are not one, so this asks twice before it costs anything.
- **Quick edit.** Select code, say what to change, apply or discard the diff
  without leaving the file.
- **CodeLens, code actions and doc comments.** Explain, Document and Tests above
  functions and classes; fixes and rewrites in the lightbulb menu. Both on by
  default, both with a setting, because a lens on every function is the feature
  or the annoyance depending on the file. All three sit on one shared path for
  invoking the model outside a chat turn and applying an edit, so they are thin.
- **Commit message generation.** Writes into the Source Control box through the
  Git extension's API rather than by shelling out, so it knows which repository
  is in front of the user and can reach the box at all.
- **Ambient editor context.** The focused file, the cursor, other editors in a
  split, the open tabs and the compiler's diagnostics for that file ride with
  each message. It is what makes "fix this" resolve to anything. Capped at 10
  tabs, 12 problems and 200 characters each, about 160 tokens on a busy editor,
  and it rides in the user message rather than the system prompt because that
  prompt is a cache key and this text changes whenever the cursor moves.
  `genesis.editorContext` turns it off.
- **A project instructions file.** `.agent/instructions.md`, prepended to every
  system prompt, for conventions that hold on every turn. Skills are the
  on-demand half of the same idea. Capped, with truncation stated in-band so a
  model reading a fragment is told so. Its own watcher, so an edit reaches the
  next turn rather than the next window.
- **Web search without a browser.** `web_search` for the questions that do not
  need a page opened. DuckDuckGo by default and needs no key; Brave, Google and
  Bing take `genesis.searchApiKey`, which accepts `${env:}` and `${file:}` so
  it need not sit in settings in the clear.
- **Untrusted-content marking.** Anything fetched from the internet reaches the
  model wrapped and labelled, so a page attempting to issue instructions is read
  as a page that says so rather than as an instruction.
- **Browser actions and vision.** Click and type by ref, read a page as prose
  with its images described, and a window to watch it work in
  (`genesis.browserHeaded`, `genesis.browserProfile`).
- **Background streaming across conversation switches.** A turn now carries its
  own abort, its own replay buffer and a reference to the transcript it appends
  to. Switching conversations mid-stream moves what is on screen and nothing
  else; the answer keeps being written to the conversation that asked for it.

### Changed
- **Ask is one predicate, read twice.** Both lines of work had built Ask
  independently. The surviving gate is read where tools are offered and again
  where a call executes, because filtering the advertised array is a request to
  the model rather than a guarantee about it. The agent gate rides on the same
  predicate, so the two cannot disagree.
- **The approval control moved onto the composer's control row**, beside the
  phase and the model. Those three answer one question between them: what it may
  do, which model does it, and whether it will ask first.
- **The panel opens in the Secondary Side Bar** by manifest contribution rather
  than by moving the whole Primary Side Bar across the window. Upgrading from
  0.5.4 or earlier undoes that move once and then never touches the layout.
- **The empty screen offers the conversations that exist**, not three invented
  examples naming code no workspace has.

### Fixed
- **A screenshot cost ~157,000 tokens instead of ~1,400**, a photo page was sent
  as a 1.2 MB png, and alt text never reached the model at all.
- **`controlCenter.js` took down the whole pane** on an unguarded
  `sv.tools.length`.

## 0.7.0

Agents: a persona plus a list of what it may reach, enforced at the boundary
where a call runs rather than advertised in the tools array. Alongside them,
three chat-surface changes: long questions stop burying the answer, a
conversation can leave the extension as a file, and the panel says what the
agent is doing to the workspace while it does it.

### Added
- **Long questions collapse.** A pasted stack trace or a three-screen brief is
  still the user's own words and none of it can be summarised away, but at full
  height one turn pushes the answer it is asking about off the panel, and
  scrolling back past it is the price of every later glance at the
  conversation. Past 420 characters or 7 lines a user turn renders clamped
  under a fade with its own `Show all N lines` expander; the text is never
  altered, only how much of it is on screen. Two thresholds because either
  alone is wrong: 40 short lines is a wall of text well under the character
  count, and one 900-character paragraph wraps to a wall of text on a single
  line. Restored transcripts clamp the same way, since both paths build the
  turn through one function.
- **Export the chat as JSON.** Transcripts live one-file-per-conversation in a
  private storage directory, which is the right shape for the extension and the
  wrong shape for a person: there was no way to hand a conversation to a
  colleague, attach it to a bug report, or feed it to a script. Two new
  commands - `Genesis: Export chat as JSON` and `Export all chats as JSON` -
  two rows in the header's overflow menu, and `/export` in the composer, all
  write one readable document through a save dialog. The conversation the
  composer is writing into is taken from the controller rather than from disk,
  so a turn still in flight and a chat not yet persisted both export what is on
  screen. The confirmation lands in the transcript with an `Open` button rather
  than in a toast that takes the path away with it.
- **A live changed-file panel.** `fileTouched` reached the frontend and hit an
  empty `case` - the panel knew a file had changed and did nothing with it.
  There is now one row per file above the composer, revealed on the first
  write, flashing on each subsequent one, with the running `+`/`-` per file and
  in total; a row opens the file, and the panel can be cleared without touching
  anything on disk. The list is conversation-scoped rather than turn-scoped: it
  answers "what has this chat done to my workspace", which a list that emptied
  at every turn boundary could not. It survives a webview reload through the
  turn replay buffer and a window reload through `stateSync`.
- **Line counts, while the turn is still running.** `write_file` and
  `edit_file` now report what they did through `onFileTouched`, measured by
  `lineStat` (`src/agent/tools.ts`): common leading and trailing lines are
  trimmed and what remains is counted, which is exact for a single contiguous
  edit and an overestimate for scattered ones. The panel marks those numbers
  with a `~` until the end of the turn, when the shadow repository's `numstat`
  replaces this turn's estimate with git's own count and the tilde goes. The
  estimate is subtracted rather than the total overwritten, so a file changed
  in an earlier turn keeps the count it earned there.
- **Agents.** A persona plus a list of what it may reach, one Markdown file
  each in `.agent/agents/`: a model override, a memory file, an allowlist of
  built-in tools, an allowlist of skills, and a per-server filter over MCP
  tools. The `mcp:` block takes Hermes Agent's own shape
  (`tools.include` / `tools.exclude`, `*` globs) so a filter can be copied
  between the two, plus the shorthands people write first - `mcp: "*"`,
  `mcp: none`, `mcp: [filesystem, memory]`, `mcp: { filesystem: [read_*] }`.
  Everything except `name` is optional and every omission means "unrestricted"
  rather than "none", so an agent can start as a persona and acquire limits
  later. Pick one with `/agent`, from the Agents section of the Diagnostics
  tab, or from the command palette; a bar under the tabs names the active one
  and states its scope, and nothing is drawn when none is selected.
- **The agent scope is enforced, not advertised.** One predicate,
  `agentAllowsMcp` / `agentAllowsTool` (`src/agents/loader.ts`), read at the
  boundary where tools are offered *and* at the boundary where a call runs -
  the same rule the read-only phases follow, for the same reason: filtering the
  `tools` array is a request to the model, not a guarantee about it. An agent
  whose picker row promises "read_text_file only" and whose runtime runs
  `write_file` would be worse than no agent at all. `test/agent-gate.ts` drives
  the real loop with a model that deliberately calls tools it was never
  offered; `test/mcp-live.ts` proves the same scope against a real MCP server
  process, where the write tool is connected and callable without the agent and
  refused with it.
- **Agent memory.** `memory:` names a workspace file that is read into the
  system prompt on every turn, with the instruction that the agent may rewrite
  it using its own tools. No machinery behind it, which is the point: what
  accumulates is a file that can be read, edited and deleted. Capped at 8k
  characters, refused if the path leaves the workspace.
- **A way back from the empty screen.** New chat used to land on a welcome
  message whose only route back was the history popover in the header - two
  clicks and a menu, to return to the thing you were reading a second ago. The
  empty screen now lists the last few conversations under the starting-point
  chips. Nothing renders on a first run, so the message stands alone.
- **`Open in editor` on file tool cards.** A card about a file could not reach
  it. The header cannot carry the link - it is itself the button that expands
  the card, and a control inside a control is neither valid nor operable by
  keyboard - so the action lives in the body it opens, on `read_file`,
  `write_file` and `edit_file`, and not on a call that failed.

### Changed
- **The footer strip is gone.** A row under the composer carried the context
  figure, its meter and the endpoint pill: three facts that are status rather
  than controls, costing a row of vertical space on every panel in a sidebar
  whose scarcest resource is vertical space. The figure and the meter moved
  into the header beside the wordmark, and the endpoint's health became a dot
  on the model button, which already names that endpoint's model. Nothing was
  dropped: the figure still prints only when the gateway reported real usage,
  the meter still turns amber then coral, and the dot still turns red on a TLS
  failure.

### Fixed
- **A message steered mid-turn kept its text and lost its files.** The steering
  path built `{ role: "user", content: text }` by hand while the normal send
  path composed images into content blocks and inlined text files as fenced
  blocks. A screenshot pasted during a running turn reached the model as the
  sentence about it - and the composer had already cleared the pill, so nothing
  on screen said it was gone. Both paths now go through one
  `composeUserMessage`, and the acknowledgement carries the file chips so the
  transcript shows what is waiting. The queue path was already correct; its
  note now shows the chips too.

## 0.6.0

Ask joins Plan and Act, a second live MCP example, and small chat-surface polish.

### Added
- **Ask mode.** A third composer segment, in the palette's new amber
  (`--kx-ask`), next to Plan (violet) and Act (turquoise). Ask offers the same
  grounding as Plan - `read_file`, `list_files`, `glob`, `search`,
  `read_skill` - but never `update_todos` and never ends in a plan card: it
  exists to answer a direct question against the real workspace, not to
  produce a design or a build order. Shift+Tab now cycles Ask → Plan → Act →
  Ask instead of toggling two states, and the read-only banner above the
  transcript generalises to both restricted phases instead of naming Plan
  alone.
- `ASK_ONLY` (`src/agent/loop.ts`), the tool set for ask phase, and
  `ASK_ADDENDUM`, its system-prompt addition - short, and deliberately silent
  about steps or plans, so a model cannot mistake it for Plan's contract.
  `READ_ONLY` is now `ASK_ONLY` plus `update_todos` rather than a second
  hand-maintained list, so the two cannot drift apart.
- **A second MCP example.** `.agent/mcp.json` now ships `memory`
  (`@modelcontextprotocol/server-memory`) alongside `filesystem` - a local
  knowledge graph rather than another file reader, so the shipped config
  demonstrates a stateful tool, not just a second passthrough. Nothing it does
  touches the workspace: its graph lives next to the installed package unless
  `MEMORY_FILE_PATH` says otherwise. `test/mcp-live.ts` spawns it for real,
  same as `filesystem`, and round-trips a `create_entities` / `search_nodes`
  call rather than only checking that it starts.

### Fixed
- **The read-only phases are now enforced, not just advertised.** Filtering the
  `tools` array is a request to the model, not a guarantee about it: a gateway
  that drops the array, a small model echoing a `write_file` shape from earlier
  in the transcript, or an instruction injected into a file the model just
  read, all produce a call for a tool that was never offered - and the loop
  handed that name straight to `runTool`. A write in Ask mode landed. The phase
  policy now lives in one predicate, `toolAllowedIn` (`src/agent/loop.ts`),
  read at both the advertisement boundary and the execution boundary, so the
  two cannot disagree. A refused call comes back as a tool result naming the
  phase that *can* run it, so the turn continues instead of dying.
  MCP tools are refused outside Act by prefix rather than by lookup - a server
  that names a tool `read_file` does not walk through the gate on its suffix.
- **The MCP client no longer advertises a capability it does not implement.**
  `CLIENT_CAPABILITIES` claimed `sampling`, which invites the server to send
  `sampling/createMessage`; every server-initiated request was answered with
  `-32601`. A server that trusted the advertisement got a hard protocol error
  at the moment it tried to use the feature. Dropped from both the stdio and
  HTTP transports; nothing consumed it here either.
- An unknown phase reaching the webview left the composer with no segment lit
  and no banner - a state the user could not name or escape except by
  clicking. It normalises to Act, matching the host's own default, rather than
  to Ask: showing a read-only badge over a session the host would still run a
  write in is the flattering answer and the wrong one. The host normalises
  `setPhase` the same way and echoes the corrected value back.
- A restored transcript showed settled tool cards with a green tick beside a
  grey "still running" rail dot, the two marks contradicting each other on the
  same row.

### Added
- **`roots/list` is now implemented** rather than refused. A server asking
  where the workspace is gets a real answer - the directory it was started in,
  as a `file://` URI built with `pathToFileURL` so a Windows drive letter
  survives. Previously the one capability the client legitimately advertised
  was still answered "method not found". Remote servers get an empty list,
  which is the truth: they do not share this machine's filesystem.
- **`test/mcp-script.ts`: an MCP server that is not an npm package.** Every
  other MCP suite started something through `npx`, which quietly made "works
  with MCP" mean "works with the two npm packages we ship as examples". This
  one writes a dependency-free Python server to a temp file and drives it
  through the real registry, so the transport is what is under test rather
  than somebody's SDK. It also has the server call `roots/list` back mid
  `tools/call` - the only coverage of a server-initiated request against a
  live registry, and the thing that proves the fix above rather than assuming
  it. Skips cleanly where no Python 3 exists; on Windows it prefers `python`,
  because `python3` there is a Store alias that launches nothing.
- The config template gains a `script-server` example (disabled, like the
  others) and says plainly that `command` need not be `npx`. Two footguns are
  documented at the point they bite: the script path must be absolute, since
  `cwd` is the workspace and a relative path breaks when a different folder is
  opened, and the interpreter must be named rather than relying on a shebang,
  which Windows does not consult at all.
- Command cards label their two halves `IN` and `OUT`. The header truncates a
  command to fit the panel, so the full line had nowhere to live; "what did it
  actually run" is also the first question on a failure, and the error path
  used to skip the argument preview entirely. Both the live path and session
  restore build the same shape.
- A status rail down the left of the transcript - one dot per tool row, grey
  running, turquoise done, burgundy failed. A column read at one x-position
  scans faster than a ragged right edge set by each row's argument length.

### Changed
- The phase control is a `radiogroup` with `aria-checked` rather than three
  plain buttons styled by a data attribute. A screen reader announced three
  equal buttons and never which phase was live - the one thing the control
  exists to say. The active segment also gains a 2px underline in its own hue,
  so the state does not rest on colour alone.
- `PHASES` is now the definition and `Phase` is derived from it, so a fourth
  phase cannot enter the type without also becoming something the host can
  validate at runtime. `src/ui/protocol.ts` re-exports it instead of keeping a
  second hand-maintained copy.
- Approval mode's own `"ask"` (confirm every mutating call) and phase's new
  `"ask"` (a phase with no mutating calls to confirm) are different axes and
  never interact - Ask phase offers nothing `approvalMode` would ever gate.
  Documented at the point both are read, not only here.
- The composer placeholder splits three ways: "Ask Genesis anything…" now
  belongs to Ask, where it always literally applied; Act gets "Tell Genesis
  what to do…" instead of inheriting Ask's old text.
- The idle-verb pool gains `ASK_VERBS` ("Reading up…", "Following the
  trail…", …), so a waiting Ask turn reads differently from a waiting Act
  turn rather than falling back to the generic set.
- `.agent/mcp.json` and the scaffold template in `src/core/app.ts` both now
  say MCP tools are withheld in Ask mode too, not Plan alone.

## 0.5.0

Latency work — connection reuse, prompt caching, and getting disk, git, and
JSON serialisation off the path between Enter and the first token. Plus a
diagnostics fix for gateways that hang on non-streaming requests.

### Fixed
- **Diagnostics hung for two minutes on NVIDIA NIM.** The Completion rung sends
  a non-streaming request, which that gateway does not answer at all over
  HTTP/1.1. The streaming fallback and its warning already existed, but the
  probe waited out the full 120s production timeout before reaching them, with
  the panel showing only "Running…". The probe is now bounded to 20s and aborts
  rather than being abandoned, so the fallback and its explanation appear
  almost immediately.
- **A reply that arrived in one frame did not type out.** How a response is
  chunked is the gateway's choice; some send the whole answer in a single SSE
  frame. Painting on arrival made those land as one block. Display is now paced
  from a buffer, so a reply types regardless of how it arrives, and the end of
  a turn always reveals whatever is left.
- **A disabled MCP server was invisible.** `enabled: false` caused the registry
  to drop the server entirely, so the panel showed "No MCP servers configured"
  and offered to create a config file the user had just edited. Disabled
  servers are now a state: listed, greyed, not counted as failures, with a note
  saying how to turn them on.
- **Multi-byte characters corrupted mid-stream.** The SSE reader decoded each
  chunk independently, so a UTF-8 sequence spanning a TCP segment boundary
  became U+FFFD — any reply with emoji or CJK broke at random points. Now
  decoded through a streaming `TextDecoder`.
- **Interrupt did not abort the request**, only the reading of it, so a cancel
  during a long pause before the first token had no effect until the next chunk
  arrived. The signal now reaches `undici.request`.
- **Anthropic tool results were sent one message each.** The wire expects every
  `tool_result` for a turn in a single user message; splitting them teaches a
  model that can call in parallel to stop. They are now batched.
- `message_start` was ignored, so input and cache token counts never surfaced.
- The diagnostics ladder built four undici dispatchers and closed none.

### Added
- **Prompt caching**, opt-in per profile via `capabilities.promptCaching`
  (`anthropic` | `prefix` | `none`, default `none`) and `capabilities.cacheTtl`.
- **Warm-up on composer focus** — connection, credential, and the cacheable
  head of the prompt are paid for while the user is still typing.
- **Per-turn timings in the log**: headers, TTFT, TPOT, total, and a cumulative
  handshake count. A count that climbs once per turn means connection reuse is
  broken; it is the first thing to check.
- `usage.cacheRead` / `usage.cacheWrite`, the only honest confirmation caching
  is working.
- CI: `npm test` / `npm run verify`, a declared `jsdom` devDependency, and a
  GitHub Actions matrix (Node 20/22 × Ubuntu/Windows) that also uploads a
  packaged `.vsix`. Live-API and MCP-server suites are excluded from CI and
  have their own `test:live` / `test:mcp` scripts.

### Changed
- **Idle sockets are pooled for 60s, not undici's default 4s.** A turn is
  separated from the next by however long a person takes to read and type, so
  every turn was paying a fresh TCP connect, TLS handshake, and — on the
  endpoints this extension exists for — a CONNECT tunnel and an mTLS exchange.
- TLS material is parsed once into a shared `SecureContext` instead of handing
  ~150 root PEMs to every handshake.
- **Skill edits no longer tear down the transport.** Profiles and skills are
  watched separately; saving a `SKILL.md` mid-conversation used to destroy the
  connection pool.
- Transcripts are written asynchronously behind an in-memory metadata index.
  `list()` and `nextUntitled()` each used to read and parse every transcript on
  disk, and `list()` runs on every save.
- The turn checkpoint no longer blocks the request: it starts immediately and
  is joined at the approval gate, which every mutating tool passes through.
- Token counts are memoised per message rather than recomputed each iteration.
- Auth resolution overlaps request encoding rather than preceding it.
- A request that fails on a stale pooled socket, before reaching the server, is
  replayed once on a fresh one.

## 0.4.0

Bundled skills, Act button in brand green, and a Control Center fix.

### Fixed
- **Control Center crashed on open since 0.3.0.** Two bugs:
  (1) The stroke shorthand `SW` used by every icon in `controlCenter.js` was
  never declared — it was called `S6` in the sidebar, and the CC copy was never
  updated when the crystal refactor renamed it. Every icon `<path>` threw a
  `ReferenceError` at parse time, which killed the IIFE before `mount()`.
  (2) In a VS Code webview, `<script src>` tags can race: `controlCenter.js`
  read `window.__kxCrystal` synchronously at init, but `crystal.js` sometimes
  hadn't finished loading yet. Both surface scripts now poll for readiness
  before running, so load order cannot break them.
- Defensive guards added to `renderStrip` and section renderers for missing
  `tls.ca`, `proxy.noProxy`, and `files` arrays on profile DTOs.

### Added
- **All 17 Anthropic skills ship inside the extension.** The `skills/` directory
  at the extension root contains every skill from
  `github.com/anthropics/skills`: algorithmic-art, brand-guidelines,
  canvas-design, claude-api, doc-coauthoring, docx, frontend-design,
  internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator,
  theme-factory, web-artifacts-builder, webapp-testing, xlsx. The loader already
  scanned `<extensionPath>/skills/` as a bundled directory; this populates it.
  Workspace skills in `.agent/skills/` still override bundled ones by name.
- `THIRD-PARTY-NOTICES.md` from the Anthropic skills repository.

### Changed
- **Act button is Genesis green.** The Plan / Act segment now reads as
  purple / emerald — `--kx-active` for Plan, `--kx-accent` for Act — matching
  the brand identity. Previously Act used `--vscode-button-secondaryBackground`
  which was a nondescript grey.

## 0.3.1

Composer fixes, file attachments, and UI polish from user testing.

### Fixed
- **Textarea showed a scrollbar when empty.** The overflow was always `auto`;
  now it starts as `hidden` and only switches to `auto` once the content exceeds
  `max-height`. A `min-height: 32px` prevents the input area from collapsing.
- **Textarea shrank below its usable height.** The autoGrow calculation reset
  height to `auto` without a floor, and the scrollbar fought the layout. Both
  are now coordinated: height clamps at 32px–120px and overflow follows.

### Added
- **File attachments.** The paperclip button opens a native file picker (images,
  documents, all files, up to 10 MB). Chosen files appear as removable pills
  above the textarea. Images are sent as base64 content blocks when the profile
  has vision enabled; the client layer already handles both OpenAI and Anthropic
  image wire formats. Attachments clear on send and on session switch.
- **Image rendering in transcripts.** User messages with image content blocks
  render inline thumbnails in the chat bubble, both live and on session restore.

### Changed
- **Aura animation reworked.** Adopted the user's heartbeat timing: a single
  ring snaps outward on each beat rather than orbiting continuously. The swirl
  layer and second staggered ring are removed. The animation is tighter and
  calmer.

## 0.3.0

New brand mark, and a rebuilt session mechanism.

### Fixed
- **New chat did nothing visible.** `newChat` cleared the transcript on the host
  and rotated the session id, but broadcast no message that told the webview to
  clear. The conversation stayed on screen while the host had already moved on.
- **Every message became its own session.** A consequence of the above: because
  the screen never changed after pressing New chat, each subsequent message was
  filed under a freshly rotated id. The history popover filled with one-message
  sessions. Session identity now changes in exactly one place, and every change
  is announced with `sessionSwitched`.
- **Tool calls were never persisted.** The agent loop accumulated assistant and
  tool messages in a local array and dropped it on return; the controller then
  rebuilt history as a lossy `user` / `assistant` pair. The model re-read files
  it had already read, and a restored session could not render its tool cards.
  The loop now reports each message it appends through `onMessage`.
- **A window reload split conversations.** Each extension-host start minted a
  new session id. The active id is persisted in `workspaceState` and the
  transcript is picked back up on activation.
- **The user's message was recorded after the turn, not before.** A webview
  reloading mid-stream re-rendered a transcript that did not contain the
  question it was answering. The user turn is now written before the model is
  called, so a host that dies loses the reply but never the question.

### Added
- History popover shows message counts, marks the active conversation, and has
  a per-row delete. New inbound message `deleteSession`.
- `media/logo.png` — a 128×128 tile, registered as the extension `icon`. The
  manifest previously had none.
- `media/webview/crystal.js` — the brand mark as a single shared asset loaded by
  both surfaces. It used to be a verbatim copy in each webview script.

### Changed
- **New crystal artwork.** A faceted cluster traced from the source logo:
  eighteen facets over four emerald gradients above a dark union silhouette,
  plus three highlight slivers. Portrait 42:48 rather than the old landscape
  48:30, so `crystal(height)` derives the width and no call site can stretch it.
  The silhouette is load-bearing — without it the gaps between facets show the
  host background and the cluster reads as shattered on a light theme.
- **The waiting indicator is a dark-green aura.** Two staggered expanding
  pulses, a masked conic sweep orbiting the mark, a breathing core and a beating
  crystal, all in deep emerald so the aura sits behind the mark rather than
  out-shouting it. `prefers-reduced-motion` still falls back to a static
  crystal.
- The activity-bar icon is a reduced six-shard cluster, thickened so the gaps
  survive VS Code masking it to flat monochrome at 16–24px. The full silhouette
  rendered as a blob.
- Outbound `sessionRestored` is now `sessionSwitched`, and it is emitted for new
  chats and deletions as well as loads.
- `SessionMetaDto` gains `count` and `active`; `StateSync.session` gains
  `title`.

## 0.2.0

First release under the GENESIS name.

### Added
- Sidebar webview: session transcript, tool cards, per-file diff cards, todo
  card, in-chat permission cards, plan phase, slash and `@` quick picks,
  model picker grouped by profile, context meter.
- Control Center editor tab with ten sections covering endpoints, wire formats,
  auth, TLS/mTLS, proxy, diagnostics, agent, skills, checkpoints and logs.
- Plan phase: read-only tool set plus a fenced `plan` block parsed into a card.
- `update_todos` tool backing the todo card.
- Per-file diff accept/reject against the shadow-git snapshot.
- Turn replay so a webview reloaded mid-stream catches up.
- `authCacheReport()` — cache keys and expiries, never tokens.
- `ShadowRepo.numstat`, `restoreFile`, `fileDiff`.
- `EndpointClient.close()`; clients pooled per profile.

### Fixed
- OAuth2 exchange cache used tokens for 30s **after** expiry. The skew is now
  the standard early refresh: stop using the token 30s **before** it expires.

### Changed
- Config namespace is `genesis.*` with five keys.
- Approval modes are `ask | edits-auto | full-auto`.
- Approvals render in the transcript rather than as modal dialogs.
