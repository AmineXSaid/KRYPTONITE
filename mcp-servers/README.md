# Read-only MCP servers

MCP servers for the internal systems a coding agent needs to read and must
never write to. Search-only, by construction rather than by convention.

| | |
| --- | --- |
| `src/readonly_client/` | shared auth, HTTP client, read-only guard, error mapping, redaction |
| `src/readonly_client/paths/` | every REST path, one module per product, each with its provenance |
| `src/jira_mcp/` | Jira server — [README](docs/jira.md) |
| `src/confluence_mcp/` | Confluence server — [README](docs/confluence.md) |
| `probe.py` | standalone connectivity + deployment-type check. **Run this first.** |

The shared core is named for the property it enforces, not for the first vendor
that used it: it began as `atlassian_client`, and that name stopped being true
the moment a second vendor's server imported it.

---

## ⚠️ Read this before you trust the endpoint paths

**The paths in `src/readonly_client/paths/` have not been verified against
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

Every setting is read as `<PREFIX>_NAME` first and `MCP_NAME` second, so one
`MCP_CA_BUNDLE` covers every server while `JENKINS_READ_TIMEOUT` still wins for
the one that needs longer. Credentials have no shared form — four services do
not share a token.

| Variable | Required | Notes |
| --- | --- | --- |
| `JIRA_BASE_URL` | jira-mcp | Instance root, no `/rest` path |
| `CONFLUENCE_BASE_URL` | confluence-mcp | Instance root. Cloud needs the `/wiki` suffix |
| `ATLASSIAN_AUTH_MODE` | yes | `bearer` (DC PAT) or `basic` (Cloud email+token) |
| `ATLASSIAN_TOKEN` | yes | Your own PAT, or Cloud API token |
| `ATLASSIAN_USER` | basic mode | Your account email |
| `<PREFIX>_CA_BUNDLE` / `MCP_CA_BUNDLE` | optional | PEM bundle for a corporate root CA |
| `HTTPS_PROXY` / `NO_PROXY` | optional | Standard vars, honoured automatically |
| `<PREFIX>_MAX_RESULTS_CAP` / `MCP_…` | optional | Default 50, hard ceiling 100 |
| `<PREFIX>_CONNECT_TIMEOUT` / `MCP_…` | optional | Default 10s |
| `<PREFIX>_READ_TIMEOUT` / `MCP_…` | optional | Default 30s |

A missing or blank required variable **fails at startup** with a message naming
it — and naming the variable it actually read, so a bad `MCP_MAX_RESULTS_CAP`
does not send you looking for an `ATLASSIAN_MAX_RESULTS_CAP` you never wrote.
The servers never start half-configured.

### Auth modes

| mode | header sent | who uses it |
| --- | --- | --- |
| `bearer` | `Authorization: Bearer <token>` | Jira/Confluence Data Center PAT |
| `basic` | `Authorization: Basic base64(user:token)` | Atlassian Cloud, Jenkins |
| `header` | `<name>: <token>` | GitLab's `PRIVATE-TOKEN` |

Each server declares which modes it will accept, because offering one that
cannot work is offering a choice that can only be a mistake — and it fails as a
401 that looks exactly like a bad token, rather than as a config error.

## Run

```bash
jira-mcp          # or: python -m jira_mcp.server
confluence-mcp    # or: python -m confluence_mcp.server
```

## Test

```bash
pytest            # 137 tests, no network access required
```

---

## How read-only is enforced

Not by convention — in the HTTP layer, in `src/readonly_client/http.py`:

```python
def assert_read_only(method: str, path: str, allowlist: Iterable[str] = ()) -> None:
    if method.upper() not in {"GET", "POST"}:
        raise ReadOnlyViolation(...)          # before a request object exists
    if method.upper() == "POST" and normalise_path(path) not in tuple(allowlist):
        raise ReadOnlyViolation(...)
```

The only allowlist in the codebase is Jira's `("/rest/api/2/search",)` —
Atlassian requires POST there so a long JQL string can travel in a body instead
of a URL. Every other client passes none and is therefore GET-only.

Four details that matter:

- **The allowlist travels on the config, and defaults to empty.** It is not a
  module global the client consults, because that would let Jira's one
  exception silently apply to a GitLab or Jenkins client that never asked for
  it. A product that names no allowlist gets GET and only GET.

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
| **401** | "Token rejected." Names `<PREFIX>_TOKEN` and the auth mode. |
| **403** | "Authenticated, but no permission on this resource." Says explicitly that regenerating the token will not help. |
| **404 + HTML** | Reads as a wrong path — appends the product's own hint about what a wrong API root looks like, and points at `probe.py`. |
| **404 + JSON** | Item missing *or* invisible. These products return 404 rather than 403 for content you cannot see, so these genuinely cannot be told apart. |
| **429** | Honours `Retry-After`, exponential backoff, capped at 3 retries. |
| **TLS** | Names the real cause and points at `<PREFIX>_CA_BUNDLE` / `MCP_CA_BUNDLE`. |

Every message names the variable for the server that raised it. A GitLab
failure that says `ATLASSIAN_TOKEN` is worse than one that names nothing.

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
   `/wiki` prefix — a `paths/atlassian.py` change plus paging changes in two
   tools.
2. **`jira_list_projects` pagination.** I used `/rest/api/2/project`
   (unpaginated, filtered client-side) rather than `/rest/api/2/project/search`,
   because I could not confirm the paginated path exists on your DC version.
   If `probe.py` reports 8.x+ and you want it paginated, say so — but on an
   instance with thousands of projects the current call returns one large
   payload before we trim it.
3. **MCP SDK version.** You asked for FastMCP; the current SDK is 2.x, where it
   was renamed `MCPServer`. `mcp_compat.py` resolves whichever is installed, so
   both work. Pin `mcp<2` if you want the 1.x line specifically.
4. **Reading large text.** `get_text()` streams and caps text bodies, with
   `tail=True` for the case that matters — a stack trace is the last thing a
   failing build prints, so a cap that keeps the first 2 MB of a 200 MB log
   keeps everything except the answer. Truncation is reported alongside the
   text rather than hidden, because a truncated log that looks whole makes an
   agent report that a build failed for no visible reason.
