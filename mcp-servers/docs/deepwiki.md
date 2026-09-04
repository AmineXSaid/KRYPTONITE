# deepwiki-mcp

A codebase wiki for the repository the agent is working in — generated from the
code itself, through a Genesis endpoint profile, and served back to any agent
that needs to understand the repo.

Unlike the four servers beside it, this one is **not** a read-only client to an
external system. It reads the workspace off local disk, generates a wiki
through the same model gateway the extension already talks to, writes it into
the repo under `.agent/wiki/`, and answers questions from it. Nothing leaves the
machine that Genesis would not already send to your endpoint.

## Why it lives here and not in the cloud

Cognition's DeepWiki indexes public GitHub. It cannot touch a private monorepo
behind an SSO proxy, a client-cert gateway, or an air-gapped network — which is
exactly the audience Genesis exists for. This server does the same job under
the same constraints as the rest of the agent: one endpoint profile, no new
network path, no embedding service to stand up, no data sent anywhere new.

## The two halves

**Serving** an existing wiki needs no model at all. `wiki_status`,
`list_wiki_pages`, `read_wiki_page` and `search_wiki` read the files under
`.agent/wiki/` and work offline. This is the surface an agent reaches for
automatically while working in the repo — cheap, safe to call often, and paid
for only when called.

**Building and asking** need the endpoint. `generate_wiki` (re)builds the wiki;
`ask_wiki` answers a question from it. Their configuration is validated the
first time one of them runs, and the error names the exact variable to set — so
a missing endpoint never stops the read tools from working.

## Tools

| tool | needs endpoint | what it does |
| --- | --- | --- |
| `wiki_status` | no | Whether a wiki exists, its page count, the commit it was built from, and **whether the checkout has moved past that commit** (stale). Call this first. |
| `list_wiki_pages` | no | The table of contents: id, title, summary, source files. |
| `read_wiki_page` | no | One page's Markdown, including any Mermaid diagram. |
| `search_wiki` | no | Keyword-rank pages for a topic, with snippets. Title hits beat summary hits beat body hits. |
| `ask_wiki` | yes | Answer a question from the wiki, citing the pages used; says so rather than guessing when the wiki does not cover it. |
| `generate_wiki` | yes | Index → outline → write each page grounded in real files → save to `.agent/wiki`. One model call per page. |

The read tools carry no `*_WRITE` counterpart: this server writes only under
`.agent/wiki`, and only `generate_wiki` does that.

## The pipeline

`generate_wiki` follows the agentic-DeepWiki blueprint:

1. **Index** the workspace — every source file's path, size and language, with
   ignored trees (`node_modules`, `.git`, build output, `.agent` itself) pruned
   and binaries skipped.
2. **Outline** — the model is handed the inventory and proposes the pages: a
   title, a one-line summary, and the source files each page should be grounded
   in. Paths it invents are dropped; a page with no title is dropped.
3. **Write each page** — for every page, the named files are loaded (capped per
   file) and the model writes that page grounded in them, with one Mermaid
   diagram where the structure earns it.
4. **Save** — the manifest (`wiki.json`) and one `pages/<id>.md` per page, so
   the wiki is versioned with the code and diffable in a pull request. A page's
   footer lists the files it was grounded in.

A generation that yields zero usable pages raises rather than overwriting a good
wiki with an empty one.

## Staleness

The manifest records the commit HEAD was at when the wiki was built.
`wiki_status` compares that to the current HEAD and flags `stale: true` with the
two short SHAs when the checkout has moved on. A page read as current truth when
it is hundreds of commits stale is the failure this design is built to avoid, so
the signal travels with every status rather than being left for the caller to
discover.

## Configuration

```bash
# Where the code is. Defaults to the working directory the server is launched
# in, which is what an MCP client with cwd set to the repo already passes.
DEEPWIKI_WORKSPACE=/path/to/repo

# Where the wiki lives. Defaults to <workspace>/.agent/wiki.
# DEEPWIKI_WIKI_DIR=.agent/wiki

# The endpoint — a Genesis profile, expressed as env vars so this server can
# reach the same gateway. Only needed for generate_wiki / ask_wiki.
DEEPWIKI_ENDPOINT_URL=https://gateway.company.internal/v1
DEEPWIKI_ENDPOINT_WIRE=openai      # openai | anthropic
DEEPWIKI_MODEL=your-model-id       # the opaque id your gateway serves
DEEPWIKI_ENDPOINT_KEY=             # omit entirely if the endpoint needs none
DEEPWIKI_ENDPOINT_KIND=reasoning   # seeds the output-token budget

# Optional
# DEEPWIKI_ENDPOINT_PATH=/chat/completions   # if the gateway is non-standard
# DEEPWIKI_MAX_OUTPUT_TOKENS=8192
# DEEPWIKI_MAX_FILE_BYTES=80000
# DEEPWIKI_MAX_INDEX_FILES=6000
# DEEPWIKI_CA_BUNDLE=  (or MCP_CA_BUNDLE, shared with the other servers)
```

The URL is forgiving: a bare host gets the wire's default path appended
(`/chat/completions` or `/v1/messages`), a URL that already names a completions
path is used verbatim, and `DEEPWIKI_ENDPOINT_PATH` overrides both.

## Registering it with a client

Point an MCP client at the console script, with its working directory set to the
repository you want documented:

```json
{
  "mcpServers": {
    "deepwiki": {
      "command": "deepwiki-mcp",
      "cwd": "/path/to/repo",
      "env": {
        "DEEPWIKI_ENDPOINT_URL": "https://gateway.company.internal/v1",
        "DEEPWIKI_MODEL": "your-model-id",
        "DEEPWIKI_ENDPOINT_KEY": "${env:GENESIS_GATEWAY_KEY}"
      }
    }
  }
}
```

Once registered, the read tools are available in any conversation: an agent that
needs the shape of the system calls `search_wiki` / `read_wiki_page` on its own,
the way it would reach for any other tool.
