# confluence-mcp

Read-only CQL search and page retrieval over a Confluence Data Center instance.
**This server cannot modify anything** — see [read-only enforcement](../README.md#how-read-only-is-enforced).

## Generating your own Personal Access Token

You authenticate as yourself. The server sees exactly what your Confluence
account can see, and nothing more.

1. Sign in to Confluence (`https://confluence.company.internal`).
2. Click your **avatar**, top right → **Settings**.
3. In the left sidebar, choose **Personal Access Tokens**.
4. **Create token**. Name it e.g. `mcp-readonly-<yourname>`.
5. Set an expiry. Shorter is better; you can always issue another.
6. **Copy it now** — Confluence shows it exactly once.
7. Put it in `.env` as `ATLASSIAN_PAT`.

> On most corporate deployments Jira and Confluence share an identity provider,
> and **one PAT works against both** — you usually do not need two. If yours
> issues them separately, run each server with its own `ATLASSIAN_PAT`.

> No **Personal Access Tokens** entry? Either PATs are disabled instance-wide,
> or this is Confluence Cloud. Run `python probe.py --confluence`.

## Environment

```bash
CONFLUENCE_BASE_URL=https://confluence.company.internal
ATLASSIAN_AUTH_MODE=bearer
ATLASSIAN_PAT=<your token>
```

> **Data Center takes no `/wiki` prefix.** Confluence Cloud is
> `https://your-site.atlassian.net/wiki` and Data Center is the bare host. A
> `/wiki` on a DC instance produces an HTML 404, which this server reports as a
> wrong-path error rather than a missing page.

Verify first:

```bash
set -a; source .env; set +a
python probe.py --confluence
```

## MCP client config

```json
{
  "mcpServers": {
    "confluence": {
      "command": "/absolute/path/to/atlassian-mcp/.venv/bin/confluence-mcp",
      "env": {
        "CONFLUENCE_BASE_URL": "https://confluence.company.internal",
        "ATLASSIAN_AUTH_MODE": "bearer",
        "ATLASSIAN_PAT": "<your token>",
        "MAX_RESULTS_CAP": "50"
      }
    }
  }
}
```

Absolute path — MCP clients do not inherit your shell's `PATH`.

---

## Tools

### `confluence_search(cql, max_results=25, start=0)`

CQL passthrough. Returns a **page**, not the whole result set.

```
cql = 'space = ENG AND type = page AND text ~ "rollback procedure" ORDER BY lastmodified DESC'
```

```json
{
  "total": 63,
  "start": 0,
  "returned": 25,
  "has_more": true,
  "next_start": 25,
  "results": [
    {
      "id": "123456789",
      "title": "Rollback procedure",
      "space_key": "ENG",
      "type": "page",
      "last_modified": "2026-08-01T09:12:00.000Z",
      "url": "https://confluence.company.internal/display/ENG/Rollback+procedure",
      "excerpt": "To roll back, first drain the node pool then..."
    }
  ]
}
```

**CQL is not JQL.** Text matching is `~`, not `=`. `text ~ "drain"` searches
content; `title ~ "drain"` searches titles only.

### `confluence_get_page(page_id, body_format="storage")`

```
page_id = '123456789'
```

The body is fetched as storage format (XHTML) and **converted to Markdown**:

```json
{
  "id": "123456789",
  "title": "Rollback procedure",
  "space_key": "ENG",
  "last_modified": "2026-08-01T09:12:00.000Z",
  "url": "https://confluence.company.internal/display/ENG/Rollback+procedure",
  "version": 14,
  "body_format": "markdown",
  "body_note": "Converted from Confluence storage format (XHTML) to Markdown.",
  "body": "# Rollback procedure\n\nDrain the pool first.\n\n```bash\nkubectl drain node-1 --ignore-daemonsets\n```\n\n| Env | Region |\n| --- | --- |\n| prod | eu-west-1 |\n"
}
```

Pass `body_format="none"` for metadata only — much cheaper when you only need
the title, space or modification date.

### `confluence_list_spaces(query=None)`

Exists so CQL can be written against a real space key. A wrong key gives a 400.

```
query = 'eng'
```

```json
{
  "spaces": [
    { "key": "ENG", "name": "Engineering", "id": 98, "type": "global",
      "url": "https://confluence.company.internal/display/ENG" }
  ]
}
```

---

## Why it is built this way

**Storage format is converted, not returned.** This is the biggest design
decision in this server. Confluence storage format is XHTML with Confluence's
own namespaces: a modest page is 15–30 KB of markup wrapping 2 KB of prose.
Returning it raw would waste the context the answer needs, and it is close to
unreadable.

Tag-stripping with a regex is worse than it looks, and the converter handles
each case it gets wrong:

| | naive stripping | here |
| --- | --- | --- |
| Code macros | body is in CDATA — **vanishes entirely** | fenced block, language preserved |
| Tables | cells concatenate into run-on prose | Markdown table |
| Internal links | target is in an attribute — **lost** | `[text](confluence page: Title)` |
| Task lists | checkbox state is a sibling element | `- [x]` / `- [ ]` |
| `toc`, `pagetree` | render-time macros leak config | dropped |

**Built on `html.parser`, not lxml or BeautifulSoup.** Storage format in the
wild is frequently not well-formed XML — unescaped ampersands from old editors,
unclosed `<br>` — and a strict XML parser rejects those pages outright. Neither
dependency earns its weight for one conversion, and a malformed page returns
partial text rather than raising, because partial content beats an exception.

**Internal links say `confluence page:`, not a URL.** An `<ac:link>` target is a
page *title*, not an address. Rendering it as a URL invites a model to try to
fetch it.

**`has_more` comes from the `next` link, not arithmetic.** Confluence reports
`size` and sometimes `totalSize`, and which you get varies by endpoint and
version — so `total` is the unreliable field here. The `_links.next` presence
is not.

**Only three expansions are requested** (`space`, `version`,
`history.lastUpdated`, plus `body.storage` when a body is wanted). Confluence's
expansion model is where payloads balloon; each one is there because a
projection field needs it.
