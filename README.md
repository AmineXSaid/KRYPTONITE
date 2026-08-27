# GENESIS

A VS Code coding agent for endpoints that don't behave.

Most agent extensions treat the model endpoint as a settings textbox: paste a
URL, paste a key, hope. That works for a public API. It falls apart behind a
proxy that re-signs TLS, a gateway that wants a client certificate, an SSO flow
handing out ten-minute tokens, or a machine with no internet at all.

Genesis treats the endpoint as the product.

## Endpoint profiles

Profiles are YAML files in `.agent/endpoints/` — in your repo, versioned,
shared with your team. Secrets never live in them: `${env:VAR}` reads the
environment, `${secret:NAME}` reads the VS Code secret store (key
`genesis.NAME`), `${file:path}` reads a file, all resolved at request time.

Supported wire formats: `openai`, `anthropic`, and `raw` with a sandboxed
JavaScript transform module that reshapes anything neither adapter can express.

### What kind of model is behind it

Every profile declares a `kind`, and the Add-endpoint form will not save
without one:

| `kind` | what it means | what it sets for you |
| --- | --- | --- |
| `chat` | General instruction-following turns | the stock defaults |
| `reasoning` | Thinks before answering; slower, stronger | `maxOutputTokens: 8192` |
| `multimodal` | Reads images as well as text | `vision: true` |
| `coding` | Tuned for code edits and repo work | the stock defaults |
| `completion` | Fill-in-the-middle; drives ghost text | `tools: false`, `fim: true` |

A gateway will not tell you which of these it is serving — `model:` is an
opaque id and `baseUrl` is a hostname — but you always know, and the agent
behaves differently for each. So it is asked once, when the endpoint is added,
rather than guessed on every turn. The model picker shows it against each
endpoint, so eight profiles can be told apart at a glance.

`kind` is the headline; `capabilities:` is still the detail, and it wins. A
reasoning model that also reads images is `kind: reasoning` with
`vision: true` — the kind seeds, it never overrides. A profile written before
the field existed loads as `chat`; a misspelled one is refused, because the
alternative is silently seeding the wrong capabilities.

### Typography

The panel ships the three families it is drawn in — **IBM Plex Sans** for the
interface, **Space Mono** for every mono run, **Michroma** for the wordmark —
all under the SIL Open Font License. They have to be bundled rather than linked:
the webview CSP is `default-src 'none'` with `font-src` scoped to the extension
origin, so a family merely named in the CSS renders in the platform fallback and
nothing reports it. `media/fonts/LICENSE-NOTE.md` has the details.

### Why the transport is hand-built

Node's global `fetch` ignores `NODE_EXTRA_CA_CERTS` in some extension-host
launch paths and has no client-certificate story at all. Every request goes
through an undici dispatcher built from the profile, so mTLS and custom roots
behave identically on every platform — including through a `CONNECT` tunnel,
where the TLS settings must be applied to the *tunnelled origin* rather than
the proxy hop. That distinction is why mTLS-behind-proxy fails elsewhere.

## Diagnostics

The connection trace walks eight rungs, each gated on the one above, so the
first failure is always the real one. Every failure carries the remediation
string verbatim. TLS failures additionally produce a card naming the endpoint,
certificate subject and issuer, with the exact settings key to change and a
one-click CA upload.

Behind a proxy the failing certificate is presented inside the tunnel, so the
card says so rather than reporting the proxy's own certificate.

## Skills

Folders with a `SKILL.md` and YAML frontmatter, same format as the Anthropic
skills repository. Only the one-line index enters the system prompt; bodies
load on demand through a tool. Forty skills cost the same as five until one is
actually used — which is what makes the feature viable on a 32k gateway.

## Agents

An agent is a persona plus a list of what it may reach. One Markdown file each,
in `.agent/agents/`, YAML frontmatter over a body:

```yaml
---
name: log-reader
description: Reads logs and explains what failed, without touching anything.
model: openai/gpt-oss-20b          # optional, overrides the profile's model
memory: .agent/memory/log-reader.md
tools: [read_file, list_files, glob, search]
skills: [tls-basics]
mcp:
  filesystem:
    tools:
      include: [read_text_file, list_directory]
      exclude: [write_*]
  memory: true
---

You read logs. That is the whole job.
```

The `mcp:` block is Hermes Agent's own shape, so a server filter can be copied
between the two. `mcp: "*"` or omitting the key grants every configured server;
`mcp: none` grants none; `mcp: [filesystem, memory]` names servers without
filtering their tools.

Scoping is not decoration. Every tool offered costs context on every request,
and a tool the model can see is a tool it can call - handing a server's whole
surface to an agent that needs two of its tools spends tokens on the other
twelve and leaves the destructive ones one hallucination away.

It is also enforced, not advertised. The same predicate runs at the boundary
where tools are offered and at the boundary where a call is executed, so a name
the model produced from earlier in the transcript is refused rather than run -
the same rule the read-only phases follow, for the same reason.

Everything except `name` is optional, and every omission means "unrestricted"
rather than "none": an agent can start as a persona and acquire limits later.

The `memory:` file is read into the system prompt on every turn and the agent
is told it may rewrite it with its own tools. There is no machinery behind that
- which is the point: what accumulates is a file you can read, edit and delete.

Agents have a tab of their own, after MCP, because that is the order the two
are chosen in: a server has to be configured before an agent can be scoped to
it. The tab lists every agent with the scope it actually enforces, the file it
came from, and a button to use it or open it; the number on the tab is a count
of files that failed to parse, not of agents, so it stays dark when nothing is
wrong.

`/agent` in the composer and the command palette reach the same list. While one
is active a bar under the tabs names it and states its scope; nothing is drawn
when none is.

## MCP servers

Configured in `.agent/mcp.json`, in the shape Claude Desktop and Claude Code
use, so a server block copies between them verbatim. Tools reach the model as
`mcp__<server>__<tool>`.

Two keys are this extension's own:

| key | meaning |
| --- | --- |
| `approval` | `ask` routes every call through the permission gate; `auto` does not |
| `readOnly` | **your** claim that the server only reads — see below |

### `readOnly`, and why it is your claim to make

Ask and Plan promise the model can only look. MCP gives a server no way to
declare a tool read-only, so by default those two modes withhold MCP entirely —
there is nothing for the extension to check.

That is safe but blunt: a server that genuinely only reads gets locked out of
the read-only modes, and you end up in Act — which can also edit files — just to
run a search.

`"readOnly": true` is you saying you checked. It is the only thing that opens
Ask and Plan to a server's tools:

```json
"jira": {
  "command": "/path/to/.venv/bin/jira-mcp",
  "approval": "ask",
  "readOnly": true
}
```

**Nothing verifies it.** The extension cannot introspect what a server does, and
pretending otherwise would be worse than the honest label — so a marked server
carries a `READ-ONLY` chip in the MCP tab whose tooltip says you declared it and
the extension did not check. Set it only for a server you have actually read,
the same judgement `approval: "auto"` asks for.

Only a literal `true` counts. `readOnly: "true"` produces a warning and is
treated as false; widening what Ask and Plan may reach because of a typo is
precisely what this flag must not do.

## In the editor

The chat panel is not the only surface. Each of these calls the same endpoint
profile, through the same transport, so a gateway that works in the panel works
here too.

**Ghost text at the cursor.** Off by default, behind two gates: the profile must
declare `capabilities.fim` and `genesis.inlineCompletion` must be on. Either
one off and not a single request is sent. Fill-in-the-middle needs a fast
endpoint, and most corporate gateways are not one, so this asks twice before it
costs anything.

**Quick edit.** Select code, describe the change, apply or discard the diff
without leaving the file.

**CodeLens and code actions.** Explain, Document and Tests above functions and
classes; Genesis's fixes in the lightbulb menu. Both are on by default and
both have a setting, because a lens on every function is either the feature or
the annoyance depending on the file.

**Commit messages.** `Genesis: Generate commit message` writes into the Source
Control box, through the Git extension's API rather than by shelling out, so it
knows which repository is in front of you.

**What is on screen.** The focused file, the cursor, the other editors in a
split, the open tabs and the compiler's errors for that file ride along with
each message. It is what makes "fix this" resolve to anything. It costs a few
hundred tokens a turn and rides in the user message rather than the system
prompt, because the system prompt is a cache key and this text changes whenever
the cursor moves. `genesis.editorContext` turns it off for windows too small
to afford it.

## Project instructions

`.agent/instructions.md`, prepended to every system prompt, for the conventions
that have to hold on every turn. Skills are the on-demand half of the same idea:
this is what is always true, a skill is what is true when it is needed. Absent
is fine and is not warned about. Capped, with any truncation stated in-band so a
model reading a fragment is told it is reading one.

## Web search

`web_search` answers without opening the browser, which is the cheaper path when
the question is "what is the current syntax for X" rather than "what does this
page say". `duckduckgo` is the default and needs no key. Brave, Google and Bing
need `genesis.searchApiKey`, and Google also needs `genesis.searchEngineId`.
The key takes `${env:NAME}` and `${file:path}` like an endpoint profile does, so
it need not sit in settings in the clear.

Anything fetched from the internet reaches the model wrapped and labelled as
untrusted, so a page that tries to issue instructions is read as a page saying
so rather than as an instruction.

## Browser

The model drives whichever Chromium-family browser the machine already has;
none is bundled. `read` returns the page text and a numbered ref for everything
clickable, which is what `click` and `type` act on.

`read` also lists the pictures. `innerText` carries no alt text, so a gallery of
eight captioned photographs used to read as an empty page — every description
its author wrote, discarded. Described images now arrive with their size, images
marked decorative (`alt=""`) are left out, and anything undescribed is counted
rather than listed: *"6 more with no description"* is the line that tells the
model its reading is incomplete. It costs about 100 characters on a 15,000
character read.

`screenshot` returns the picture *to the model*, not only to the transcript, so
it can judge a chart, a diagram, or where something sits on a page. On the
Anthropic wire the image travels inside the `tool_result` block; chat-completions
refuses images in a tool message, so it follows in a labelled user message.

The format is chosen by measuring rather than guessing. A png is captured first,
because most of what a model looks at is text and small text is what jpeg is
worst at; if that png is over 200 KB it is captured again as jpeg and the
smaller of the two wins. A page of prose stays a 50 KB png, and a wall of
photographs goes from a 1.2 MB png to 425 KB of the same picture. Either way it
is one viewport, so it costs the model about 1,400 tokens.

This is gated on `capabilities.vision`. A gateway without it answers a base64
blob with a 400, so a profile that does not declare vision gets the old
behaviour — the screenshot is saved and shown to you, and the model is told in
so many words that it cannot see it and why. Run the capability probe from the
Control Center, or set `vision: true` by hand.

### The image budget

`capabilities.maxImageBytes` caps how much base64 image data one request may
carry. It defaults to 1,500,000 — room for about six screenshots, sized to sit
under the 2 MB body limit that is the common default on nginx and most API
gateways.

It exists because images are the one thing whose weight on the wire has nothing
to do with its weight in the context window. A screenshot is ~1,400 tokens and
~200 KB, so ten of them barely dent a 200k window and still add up to a 5.7 MB
POST. Nothing else in the loop would catch that — by the token accounting
nothing is wrong — and the gateway's answer is a 413 that names nothing in
particular, ten useful turns in.

Over budget, the oldest pictures are replaced by a line saying so, newest kept,
because a screenshot ages badly: the page has usually been navigated away from,
and the one being reasoned about is the one just taken. That most recent one is
always sent whatever it weighs — a cap able to discard the picture the model
asked for one step earlier would turn a size problem into a correctness one.
Only the request is trimmed; the transcript keeps every image, so a later turn
with more room can still send them.

## Sessions

Each conversation is one transcript, stored as a single JSON file under
`<globalStorage>/sessions/<workspaceKey>/<id>.json` — never inside the
workspace, so a corporate repo does not accumulate chat logs someone then has
to explain in review.

The conversation the composer writes into changes in exactly three places: the
**New chat** button, loading a conversation from the history popover, and
deleting the active one. Nothing else rotates a session id — in particular,
sending a message never does. The active id is remembered per workspace, so
reloading the window resumes where you left off rather than silently starting
over.

The history popover lists one row per conversation with its message count, marks
the one you are writing into, and deletes on hover.

Transcripts hold the full turn, including tool calls and their results, so the
model keeps its own working memory across turns and a restored conversation
renders the tool cards it originally produced.

The conversation collapses what it should. A user turn past 420 characters or
seven lines renders clamped under a fade with its own expander, so a pasted
stack trace stops pushing the answer it is asking about off the panel. Nothing
is truncated, only hidden.

`Genesis: Export chat as JSON` writes the current conversation, or every
conversation in the workspace, as one document through a save dialog. `/export`
does the same from the composer. The conversation the composer is writing into
comes from memory rather than from disk, so a turn still in flight exports what
is on screen.

The empty screen lists the conversations you can go back to, so New chat is not
a one-way door.

## Changed files

One row per file, above the composer, revealed on the first write and updated
in place while the turn runs - the running `+`/`-` per file and in total, a
click to open, and no scrolling back through the transcript to find out what
was touched.

The counts start as the writing tool's own: common leading and trailing lines
are trimmed and what remains is counted, which is exact for a single contiguous
edit and an overestimate for scattered ones. They are marked with a `~` while
that is true. When the turn ends the shadow repository's `numstat` replaces
this turn's estimate with git's own count and the tilde goes.

## Checkpoints

A shadow git repository snapshots the workspace before every turn using a
separate `GIT_DIR` in extension storage. Your real repository, index, reflog
and hooks are never touched. Each edited file gets its own diff card that can
be accepted or rejected independently.

## Build

```bash
npm install
npm run typecheck
npm run build      # esbuild single file → dist/extension.js
npm run package    # .vsix
```

For air-gapped installs, package on a connected machine and hand over the
`.vsix`. It ships no `node_modules`, makes no runtime network calls, and loads
no remote fonts or icons.

## Verification

VS Code cannot be launched in a headless build environment, so the extension is
verified statically instead:

```bash
npm run verify       # typecheck plus every suite below
node test/host.js    # activates dist/extension.js against a vscode stub
node test/drive.js   # drives the real sidebar frontend in jsdom
```

`host.js` checks that every contributed command is registered and exercises the
session lifecycle; `drive.js` renders the webview into a real DOM and asserts on
what a user would see. Neither ships in the `.vsix`.

Agent scoping is checked at three levels, because a scope that holds in one and
not the others is worse than none: `test/agents.ts` on the predicate,
`test/agent-gate.ts` driving the real loop with a model that deliberately calls
tools it was never offered, and `test/mcp-live.ts` against a real MCP server
process - fourteen tools connected, two of them visible to a scoped agent, the
write tool reachable without it and refused with it.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `genesis.profileDirectory` | `.agent/endpoints` | Where profiles live |
| `genesis.skillsDirectory` | `.agent/skills` | Where skills live |
| `genesis.activeProfile` | *(first valid)* | Active profile name |
| `genesis.approvalMode` | `ask` | `ask` / `edits-auto` / `full-auto` |
| *(agents)* | `.agent/agents` | Not a setting - the path is fixed |
| `genesis.caBundlePath` | — | Global CA merged into every profile |
| `genesis.instructionsFile` | `.agent/instructions.md` | Conventions prepended to every system prompt |
| `genesis.editorContext` | `true` | Send the focused file, open tabs and its errors with each message |
| `genesis.codeLens` | `true` | Explain / Document / Tests above functions and classes |
| `genesis.codeActions` | `true` | Genesis fixes and rewrites in the lightbulb menu |
| `genesis.inlineCompletion` | `false` | Ghost text at the cursor. Also needs `capabilities.fim` |
| `genesis.browserHeaded` | `false` | Show the agent's browser instead of running it headless |
| `genesis.browserProfile` | `persistent` | `persistent` keeps its cookies, `fresh` starts empty |
| `genesis.searchProvider` | `duckduckgo` | `duckduckgo` / `brave` / `google` / `bing` |
| `genesis.searchApiKey` | — | Key for the provider. Takes `${env:}` and `${file:}` |
| `genesis.searchEngineId` | — | Google Programmable Search `cx`. Google only |

## Where the panel opens

In the Secondary Side Bar, on the far right of the window, beside the editor.
The container is contributed to `viewsContainers.secondarySidebar`, so that is
where VS Code puts it with no command run at activation and nothing moved.
Explorer, Search and the rest of the Primary Side Bar stay on the left.

Versions up to 0.5.4 could not do this — the contribution point did not exist,
and the only thing an extension could reach was the pair of commands that swing
the whole Primary Side Bar across the window, Explorer and all. Upgrading from
one of those undoes that move once, then never touches the layout again.

Dragging the panel somewhere else is a VS Code gesture and VS Code remembers it;
**View: Reset View Locations** puts it back.

## Known caveat

`tls.getCACertificates("system")` requires Node ≥ 22.15. On older VS Code
builds `caBundle: system` contributes zero certificates and the engine falls
back to Node's bundled roots. The Config rung of the trace reports the count,
so a `0` there is the tell.
