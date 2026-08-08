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
node test/host.js    # activates dist/extension.js against a vscode stub
node test/drive.js   # drives the real sidebar frontend in jsdom
```

`host.js` checks that every contributed command is registered and exercises the
session lifecycle; `drive.js` renders the webview into a real DOM and asserts on
what a user would see. Neither ships in the `.vsix`.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `kryptonite.profileDirectory` | `.agent/endpoints` | Where profiles live |
| `kryptonite.skillsDirectory` | `.agent/skills` | Where skills live |
| `kryptonite.activeProfile` | *(first valid)* | Active profile name |
| `kryptonite.approvalMode` | `ask` | `ask` / `edits-auto` / `full-auto` |
| `kryptonite.caBundlePath` | — | Global CA merged into every profile |

## Known caveat

`tls.getCACertificates("system")` requires Node ≥ 22.15. On older VS Code
builds `caBundle: system` contributes zero certificates and the engine falls
back to Node's bundled roots. The Config rung of the trace reports the count,
so a `0` there is the tell.
