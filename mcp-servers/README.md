# Read-only MCP servers

MCP servers for the internal systems a coding agent needs to read and must
never write to. Search-only, by construction rather than by convention.

| | |
| --- | --- |
| `src/readonly_client/` | shared auth, HTTP client, read-only guard, error mapping, redaction |
| `src/readonly_client/paths/` | every REST path, one module per product, each with its provenance |
| `src/jira_mcp/` | Jira — JQL search, issues, projects, fields — [README](docs/jira.md) |
| `src/confluence_mcp/` | Confluence — CQL search, pages, spaces — [README](docs/confluence.md) |
| `src/gitlab_mcp/` | GitLab — projects, code search, files, merge requests — [README](docs/gitlab.md) |
| `src/jenkins_mcp/` | Jenkins — jobs, builds, console logs, artifacts — [README](docs/jenkins.md) |
| `probe.py` | standalone connectivity + capability check. **Run this first.** |

The shared core is named for the property it enforces, not for the first vendor
that used it: it began as `atlassian_client`, and that name stopped being true
the moment a second vendor's server imported it.

---

## ⚠️ Read this before you trust the endpoint paths

**Nothing here has been verified against your instances.** How well each path
set is corroborated differs, and it is worth knowing which is which:

| | source | status |
| --- | --- | --- |
| GitLab | `gitlab-org/gitlab`'s own `doc/api/` tree, read at master | shape read off the primary reference |
| Jenkins | the Java that serves the endpoints, in `jenkinsci/jenkins` and `jenkinsci/stapler` | shape read off the implementation |
| Jira / Confluence | secondary sources | **corroborated only** — `developer.atlassian.com` was unreachable from the build environment |

Every path carries its own status comment in
`src/readonly_client/paths/`. None of it says anything about *your* instance:
its version, its licence tier, whether a reverse proxy sits in front of it.

`probe.py` closes that gap and takes about ten seconds:

```bash
cp .env.example .env      # fill in your tokens
set -a; source .env; set +a
python probe.py           # everything you configured
```

It answers a different question per product:

- **Jira / Confluence** — Data Center or Cloud. If it says **Cloud**, stop: the
  path set targets Data Center. See [Open questions](#open-questions).
- **GitLab** — the version, and whether project-scoped code search actually
  works here. Neither a licence tier nor Elasticsearch should be required for
  it, but "should not be" is a claim about GitLab, not about your instance.
- **Jenkins** — whether `X-Text-Size` reaches the client. The console tail is
  built on that header; a proxy stripping it turns a 100 KB read into a 200 MB
  one. The server still works, just slowly, and this is how you find out
  before the instance's worst job finds out for you.

A product with no `*_BASE_URL` set is skipped, not failed.

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
gitlab-mcp        # or: python -m gitlab_mcp.server
jenkins-mcp       # or: python -m jenkins_mcp.server
```

Each server is independent: run only the ones you have configured. A server
whose variables are missing refuses to start and names them, rather than
starting and 401ing on every call.

## Test

```bash
pytest            # 261 tests, no network access required
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

Raw payloads will blow the context window. A single Jira issue is routinely
40–80 KB, mostly avatar URLs at four pixel sizes per user and several hundred
null custom fields. A GitLab project record runs past a hundred keys. A Jenkins
console log can be hundreds of megabytes.

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
- **GitLab merge-request diffs** are capped twice — 8 KB per file, 60 KB over
  the whole result — so one generated lockfile cannot crowd out every real
  change. A file whose diff was cut keeps its entry and its paths.
- **Jenkins builds** convert epoch milliseconds to ISO timestamps and readable
  durations, keeping the originals for anything that has to compute; and
  `status` is never null, because Jenkins leaves `result` null on a build that
  is merely still running.
- **Jenkins consoles** are read from the END, capped, with failure lines pulled
  out and gaps marked, and the log's true size reported alongside.
- **Attachments** are the one thing NOT shaped down, because there is nothing
  to shape: `confluence_get_attachment` and `jira_get_attachment` return a
  summary block followed by the image itself. The summary is not decoration —
  pixels with no filename, size or page give the model nothing to cite when it
  reports what the diagram showed. They are also the one path that refuses
  rather than truncates: a capped log still answers "why did the build fail",
  while the first three megabytes of a four-megabyte PNG is a decode error that
  cost a full transfer.

Three things are reported as absent rather than guessed at, because guessing in
each case produces a confident and wrong answer:

| | absent means | not |
| --- | --- | --- |
| GitLab `x-total` above 10,000 records | `total: null` plus a note | `total: 0` |
| GitLab `collapsed` / `too_large` below 18.4 | the key is omitted | `false` |
| Jenkins artifact size (never exported) | no `size` key at all | `0` |

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
4. **GitLab code search.** `gitlab_search_code` is project-scoped, because
   instance-wide blob search needs Premium/Ultimate *and* Elasticsearch. If
   `probe.py --gitlab` says advanced search is available on your instance and
   you want cross-project search, say so — it is a second tool, not a change
   to this one, because the two have genuinely different availability and a
   single tool that sometimes works is worse than two that each say what they
   need.
5. **Jenkins job naming.** Your `CTH-8899` example reads like a Jira issue key
   rather than a Jenkins job path. If your jobs really are named after Jira
   keys, `jenkins_list_jobs` will find them and nothing changes. If instead the
   question is "the build for ticket CTH-8899", that needs a link between the
   two — a Jira field naming the job, or a job parameter carrying the key — and
   I need to know which your instance uses before building it.
6. **Images from Confluence and Jira now reach the model — if the endpoint can
   look at one.** All three blockers are fixed. The servers download
   attachments (`confluence_get_attachment`, `jira_get_attachment`); the
   extension's MCP bridge carries an image content block through to the request
   body instead of flattening it to `[image: image/png]`; and the third is
   yours to set rather than mine to fix — **the active endpoint profile must
   declare vision**, either `capabilities.vision: true` or `kind: multimodal`,
   which implies it. Without it the pixels are withheld deliberately: a gateway
   that does not support images answers an image block with a 400 for the whole
   turn, which is worse than the description it replaced. The model is told, in
   the tool result, that a picture existed and which field would have shown it.

   Two limits are worth knowing before you file a bug against them. Only PNG,
   JPEG, GIF and WebP are fetched, because those are what the model wires
   accept inline — a PDF or an SVG lists with `viewable: false` rather than
   arriving as a blob nobody can read. And an attachment over ~3.75 MB is
   refused rather than truncated: half a file is a decode error, not a picture.
   That figure is exactly the largest file whose base64 fits the extension's
   per-image cap, so nothing is fetched that would be dropped one hop later.
