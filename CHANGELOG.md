# Changelog

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
- **Act button is Kryptonite green.** The Plan / Act segment now reads as
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

First release under the KRYPTONITE name.

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
- Config namespace is `kryptonite.*` with five keys.
- Approval modes are `ask | edits-auto | full-auto`.
- Approvals render in the transcript rather than as modal dialogs.
