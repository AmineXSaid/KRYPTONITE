# atlassian-mcp

Two read-only MCP servers for an internal Atlassian instance: **jira-mcp** and
**confluence-mcp**. Search-only. They cannot write to your instance.

| | |
| --- | --- |
| `src/atlassian_client/` | shared auth, HTTP client, read-only guard, error mapping, redaction |
| `src/jira_mcp/` | Jira server — [README](docs/jira.md) |
| `src/confluence_mcp/` | Confluence server — [README](docs/confluence.md) |
| `probe.py` | standalone connectivity + deployment-type check. **Run this first.** |

---

## ⚠️ Read this before you trust the endpoint paths

**The paths in `src/atlassian_client/paths.py` have not been verified against
your instance.** The environment this was built in cannot reach
`*.company.internal`, and its egress proxy blocks `developer.atlassian.com` and
`docs.atlassian.com`, so the Data Center API shapes are corroborated from
secondary sources rather than confirmed against the primary reference.

`probe.py` exists to close that gap and takes about ten seconds:

```bash
cp .env.example .env      # fill in your PAT
set -a; source .env; set +a
python probe.py
```

It reports the deployment type from the instance itself. If it says **Cloud**,
stop — the path set targets Data Center and I need to add a Cloud one. See
[Open questions](#open-questions).

---

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

Python 3.11+. Two dependencies: `mcp` and `httpx`.

## Configure

Copy `.env.example` to `.env` and fill it in. `.env.example` contains no
secrets and is safe to commit; `.env` is gitignored.

| Variable | Required | Notes |
| --- | --- | --- |
| `JIRA_BASE_URL` | jira-mcp | Instance root, no `/rest` path |
| `CONFLUENCE_BASE_URL` | confluence-mcp | Instance root. Cloud needs the `/wiki` suffix |
| `ATLASSIAN_AUTH_MODE` | yes | `bearer` (DC PAT) or `basic` (Cloud email+token) |
| `ATLASSIAN_PAT` | bearer mode | Your own PAT |
| `ATLASSIAN_EMAIL` | basic mode | |
| `ATLASSIAN_API_TOKEN` | basic mode | |
| `ATLASSIAN_CA_BUNDLE` | optional | PEM bundle for a corporate root CA |
| `HTTPS_PROXY` / `NO_PROXY` | optional | Standard vars, honoured automatically |
| `MAX_RESULTS_CAP` | optional | Default 50, hard ceiling 100 |
| `ATLASSIAN_CONNECT_TIMEOUT` | optional | Default 10s |
| `ATLASSIAN_READ_TIMEOUT` | optional | Default 30s |

A missing or blank required variable **fails at startup** with a message naming
it. The servers never start half-configured.

## Run

```bash
jira-mcp          # or: python -m jira_mcp.server
confluence-mcp    # or: python -m confluence_mcp.server
```

## Test

```bash
pytest            # 116 tests, no network access required
```

---

## How read-only is enforced

Not by convention — in the HTTP layer, in `src/atlassian_client/http.py`:

```python
def assert_read_only(method: str, path: str) -> None:
    if method.upper() not in {"GET", "POST"}:
        raise ReadOnlyViolation(...)          # before a request object exists
    if method.upper() == "POST" and normalise_path(path) not in SEARCH_POST_ALLOWLIST:
        raise ReadOnlyViolation(...)
```

`SEARCH_POST_ALLOWLIST` is `("/rest/api/2/search",)` — Atlassian requires POST
there so a long JQL string can travel in a body instead of a URL. That is the
only POST this client can make.

Three details that matter:

- **The guard runs before the request is built**, so a refusal cannot have
  reached the network. The error says "No request was made".
- **The check uses the normalised path.** `/rest/api/2/search/../issue/X/transitions`
  resolves to a write endpoint at the server and would pass a naive
  `startswith` test; it is normalised first, then matched exactly.
- **Absolute URLs are reduced to their path**, so a caller cannot point the
  client at another host.

`tests/test_readonly_guard.py` asserts all of this, including that the guard
fires without touching a transport that raises if called.

## Token handling

- Read from the environment once at startup, and registered with
  `redaction.py` before it is used for anything.
- Every error this package raises passes through `scrub()`. Both the raw token
  **and** its derived forms — the base64 Basic blob, the assembled
  `Authorization` header — are registered, because redacting only the literal
  token leaves the encoded form intact.
- `safe_exception_text()` deliberately returns no traceback: frame locals can
  hold the token, and a rendered traceback cannot be scrubbed without
  destroying what makes it useful.
- The token is never logged, never written to disk, never included in a tool
  result.

## Output shaping

Raw Atlassian payloads will blow the context window — a single Jira issue is
routinely 40–80 KB, mostly avatar URLs at four pixel sizes per user and several
hundred null custom fields.

- **Jira issue** → `key, summary, status, issue_type, assignee, reporter,
  priority, updated, url`. Anything else must be named in `fields`, and arrives
  nested under `fields` rather than merged, so a custom field called `status`
  cannot shadow the real one.
- **Confluence result** → `id, title, space_key, type, last_modified, url,
  excerpt`.
- Both carry `total`, `returned` and `has_more`, plus `next_start_at` /
  `next_start`. Without those a model receiving 25 issues cannot tell whether it
  has the answer or the first page of four hundred — and will summarise the
  slice as the whole.
- `avatarUrls`, `_links`, `_expandable`, `expand` and `self` are stripped
  everywhere, including from caller-requested extra fields.

## Error mapping

| | |
| --- | --- |
| **401** | "Token rejected." Names `ATLASSIAN_PAT` and the auth mode. |
| **403** | "Authenticated, but no permission on this project/space." Says explicitly that regenerating the token will not help. |
| **404 + HTML** | Reads as a wrong path — points at the Cloud/DC split and `probe.py`. |
| **404 + JSON** | Item missing *or* invisible. Both products return 404 rather than 403 for content you cannot see, so these genuinely cannot be told apart. |
| **429** | Honours `Retry-After`, exponential backoff, capped at 3 retries. |
| **TLS** | Names the real cause and points at `ATLASSIAN_CA_BUNDLE`. |

401 and 403 are never collapsed. They are opposite problems with opposite
fixes, and merging them sends people to re-issue a credential that was working.

**There is no `verify=False` anywhere in this codebase, and the TLS error does
not offer it as a fix.** That connection carries your personal token; an
unverified TLS session cannot distinguish your instance from anything
intercepting it. A test asserts the string never appears in the error message.

## Open questions

1. **Deployment type.** Run `probe.py` and send me the output. If it reports
   Cloud, the Jira path set needs to move to `/rest/api/3` with
   `/rest/api/3/search/jql` and `nextPageToken` paging, and Confluence needs the
   `/wiki` prefix — a `paths.py` change plus paging changes in two tools.
2. **`jira_list_projects` pagination.** I used `/rest/api/2/project`
   (unpaginated, filtered client-side) rather than `/rest/api/2/project/search`,
   because I could not confirm the paginated path exists on your DC version.
   If `probe.py` reports 8.x+ and you want it paginated, say so — but on an
   instance with thousands of projects the current call returns one large
   payload before we trim it.
3. **MCP SDK version.** You asked for FastMCP; the current SDK is 2.x, where it
   was renamed `MCPServer`. `mcp_compat.py` resolves whichever is installed, so
   both work. Pin `mcp<2` if you want the 1.x line specifically.
4. **Where should this live?** It is currently a standalone directory. It is not
   in the KRYPTONITE repo, which is unrelated. Tell me the repo and I will push.
