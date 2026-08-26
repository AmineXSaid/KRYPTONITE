# jira-mcp

Read-only JQL search and issue lookup over a Jira Data Center instance.
**This server cannot modify anything** — see [read-only enforcement](../README.md#how-read-only-is-enforced).

## Generating your own Personal Access Token

You authenticate as yourself. There is no service account and no shared
credential: the server sees exactly what your Jira account can see, and nothing
more.

1. Sign in to Jira (`https://jira.company.internal`).
2. Click your **avatar**, top right → **Profile**.
3. In the left sidebar, choose **Personal Access Tokens**.
4. **Create token**. Name it something you will recognise later, e.g.
   `mcp-readonly-<yourname>`.
5. Set an expiry. Shorter is better; you can always issue another.
6. **Copy the token now** — Jira shows it exactly once.
7. Put it in `.env` as `ATLASSIAN_PAT`.

> If there is no **Personal Access Tokens** entry in your profile, your admin
> has disabled PATs instance-wide, or this is Jira Cloud rather than Data
> Center. Run `python probe.py --jira` — it reports the deployment type.

A PAT inherits your permissions and cannot exceed them. It is not an admin
credential, and this server would not use one if it were.

## Environment

```bash
JIRA_BASE_URL=https://jira.company.internal
ATLASSIAN_AUTH_MODE=bearer
ATLASSIAN_PAT=<your token>

# Only if your instance uses an internally-signed certificate:
# ATLASSIAN_CA_BUNDLE=/etc/ssl/certs/corp-root.pem
```

Verify before wiring anything up:

```bash
set -a; source .env; set +a
python probe.py --jira
```

## MCP client config

Claude Desktop (`claude_desktop_config.json`), Claude Code (`.mcp.json`), and
most other clients take the same shape:

```json
{
  "mcpServers": {
    "jira": {
      "command": "/absolute/path/to/atlassian-mcp/.venv/bin/jira-mcp",
      "env": {
        "JIRA_BASE_URL": "https://jira.company.internal",
        "ATLASSIAN_AUTH_MODE": "bearer",
        "ATLASSIAN_PAT": "<your token>",
        "MAX_RESULTS_CAP": "50"
      }
    }
  }
}
```

Use an absolute path to the venv's console script — MCP clients do not inherit
your shell's `PATH` or your activated virtualenv.

> The token sits in a config file on your machine. Check its permissions
> (`chmod 600`), and never commit it. If your client supports referencing
> environment variables instead of literals, prefer that.

---

## Tools

### `jira_search(jql, max_results=25, fields=None, start_at=0)`

JQL passthrough. Returns a **page**, not the whole result set.

```
jql = 'project = PLATFORM AND status != Done AND updated >= -14d ORDER BY updated DESC'
```

```json
{
  "total": 431,
  "start_at": 0,
  "returned": 25,
  "has_more": true,
  "next_start_at": 25,
  "issues": [
    {
      "key": "PLATFORM-1423",
      "summary": "Gateway drops streaming responses over HTTP/2",
      "status": "In Progress",
      "issue_type": "Bug",
      "assignee": "Jane Doe",
      "reporter": "Rob Smith",
      "priority": "High",
      "updated": "2026-08-20T11:04:33.000+0000",
      "url": "https://jira.company.internal/browse/PLATFORM-1423"
    }
  ]
}
```

Continue with `start_at=25`. `max_results` is clamped to `MAX_RESULTS_CAP`
rather than rejected.

### `jira_get_issue(issue_key, fields=None)`

```
issue_key = 'PLATFORM-1423'
fields    = 'description,labels,customfield_10101'
```

Extra fields arrive nested under `fields`, never merged into the top level:

```json
{
  "key": "PLATFORM-1423",
  "summary": "Gateway drops streaming responses over HTTP/2",
  "status": "In Progress",
  "url": "https://jira.company.internal/browse/PLATFORM-1423",
  "fields": {
    "labels": ["networking", "http2"],
    "customfield_10101": { "value": "Platform" }
  }
}
```

### `jira_list_projects(query=None)`

Exists so JQL can be written against a real key instead of a guessed one — a
wrong key gives a 400, not an empty result.

```
query = 'platform'
```

```json
{
  "total": 1,
  "projects": [
    { "key": "PLATFORM", "name": "Platform Engineering",
      "id": "10000", "type": "software", "lead": "Jane Doe" }
  ]
}
```

### `jira_list_fields(query=None)`

Custom fields are everywhere in corporate instances and their ids are not
guessable.

```
query = 'sprint'
```

```json
{
  "fields": [
    { "id": "customfield_10007", "name": "Sprint", "custom": true,
      "type": "array", "clause_names": ["cf[10007]", "Sprint"] }
  ]
}
```

Note the two different names: `customfield_10007` is what goes in `fields`;
`cf[10007]` or `Sprint` is what goes in JQL. Returning both is what stops a
model guessing wrong.

---

## Why it is built this way

**JQL is passed through untouched.** Parsing or rewriting it would mean
reimplementing a query language that changes between versions, and every bug
would silently return the wrong issues. `validateQuery=strict` is set so the
instance rejects a malformed query with a message naming the bad field, which
is more useful than anything we could produce locally.

**`fields` is opt-in.** The default projection is nine keys. A corporate
instance defines hundreds of custom fields, and returning them all would blow
the context window with nulls — the biggest single payload risk here.

**GET, not POST, for search.** The guard allows POST to `/rest/api/2/search`
because Atlassian supports it for JQL too long for a URL, but GET is the
default: it keeps the query visible in the instance's access logs, which
matters when someone asks what this integration has been doing.

**`jira_list_projects` is unpaginated.** It calls `/rest/api/2/project` and
filters client-side rather than `/rest/api/2/project/search`, because I could
not confirm the paginated path exists on your DC version. See
[open questions](../README.md#open-questions).

**`total` and `has_more` are always present.** Without them a model that gets
25 issues back has no way to know whether that is the answer or the first page
of four hundred, and will confidently summarise a slice as the whole set.
