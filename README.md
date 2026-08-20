# KRYPTONITE

A VS Code coding agent for endpoints that don't behave.

Most agent extensions treat the model endpoint as a settings textbox: paste a
URL, paste a key, hope. That works for a public API. It falls apart behind a
proxy that re-signs TLS, a gateway that wants a client certificate, an SSO flow
handing out ten-minute tokens, or a machine with no internet at all.

Kryptonite treats the endpoint as the product.

## Endpoint profiles

Profiles are YAML files in `.agent/endpoints/` — in your repo, versioned,
shared with your team. Secrets never live in them: `${env:VAR}` reads the
environment, `${secret:NAME}` reads the VS Code secret store (key
`kryptonite.NAME`), `${file:path}` reads a file, all resolved at request time.

Supported wire formats: `openai`, `anthropic`, and `raw` with a sandboxed
JavaScript transform module that reshapes anything neither adapter can express.

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

Pick one with `/agent` in the composer, from the Agents section of the
Diagnostics tab, or from the command palette. While one is active a bar under
the tabs names it and states its scope; nothing is drawn when none is.

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

`KRYPTONITE: Export chat as JSON` writes the current conversation, or every
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
| `kryptonite.profileDirectory` | `.agent/endpoints` | Where profiles live |
| `kryptonite.skillsDirectory` | `.agent/skills` | Where skills live |
| `kryptonite.activeProfile` | *(first valid)* | Active profile name |
| `kryptonite.approvalMode` | `ask` | `ask` / `edits-auto` / `full-auto` |
| *(agents)* | `.agent/agents` | Not a setting - the path is fixed |
| `kryptonite.caBundlePath` | — | Global CA merged into every profile |

## Known caveat

`tls.getCACertificates("system")` requires Node ≥ 22.15. On older VS Code
builds `caBundle: system` contributes zero certificates and the engine falls
back to Node's bundled roots. The Config rung of the trace reports the count,
so a `0` there is the tell.
