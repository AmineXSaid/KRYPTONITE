# gitlab-mcp

Read-only project, code, file and merge-request access over a self-managed
GitLab instance.
**This server cannot modify anything** — and unlike `jira-mcp` it has no POST
carve-out at all, so its client is GET-only. See
[read-only enforcement](../README.md#how-read-only-is-enforced).

## Generating your own access token

You authenticate as yourself. There is no service account and no shared
credential: the server sees exactly what your GitLab account can see.

1. Sign in to GitLab (`https://gitlab.company.internal`).
2. Click your **avatar**, top right → **Edit profile**.
3. In the left sidebar, choose **Access tokens**.
4. **Add new token**. Name it something you will recognise, e.g.
   `mcp-readonly-<yourname>`, and set an expiry — shorter is better.
5. Tick **`read_api`**, and only `read_api`.
6. **Create**, then **copy the token now** — GitLab shows it once.
7. Put it in `.env` as `GITLAB_TOKEN`.

> **Do not tick `api`.** `api` is read *and write*: it can push commits, close
> issues and delete projects. `read_api` covers everything the six tools here
> do. The HTTP layer would refuse to build a write regardless, but a token that
> cannot write is a second lock on the same door, and it is free.

### Why `PRIVATE-TOKEN` and not `Authorization: Bearer`

GitLab's own reference calls `PRIVATE-TOKEN` the recommended header for a
personal, project or group access token; `Authorization: Bearer` is the
OAuth-compliant alternative and is also accepted on current versions. Older
self-managed instances reject the Bearer form for a PAT with a **401 that is
indistinguishable from a bad token** — you would spend an afternoon reissuing a
credential that was working.

So this server sends `PRIVATE-TOKEN` and accepts no other auth mode. That is
why `GITLAB_AUTH_MODE=header` is the only valid value: a mode that produces
that 401 is a choice that can only be a mistake.

## Environment

```bash
GITLAB_BASE_URL=https://gitlab.company.internal
GITLAB_AUTH_MODE=header
GITLAB_TOKEN=<your token>

# Only if your instance uses an internally-signed certificate.
# MCP_CA_BUNDLE covers every server here; GITLAB_CA_BUNDLE overrides it.
# MCP_CA_BUNDLE=/etc/ssl/certs/corp-root.pem
```

The base URL is the instance root. If GitLab is served from a subdirectory
(`https://tools.company.internal/gitlab`), include that prefix and nothing
more — never `/api/v4`.

Verify before wiring anything up:

```bash
set -a; source .env; set +a
python probe.py --gitlab
```

The probe reports the version and then answers the one question the
documentation cannot: whether project-scoped code search actually works on
*your* instance.

## MCP client config

```json
{
  "mcpServers": {
    "gitlab": {
      "command": "/absolute/path/to/mcp-servers/.venv/bin/gitlab-mcp",
      "env": {
        "GITLAB_BASE_URL": "https://gitlab.company.internal",
        "GITLAB_AUTH_MODE": "header",
        "GITLAB_TOKEN": "<your token>",
        "MCP_MAX_RESULTS_CAP": "50"
      }
    }
  }
}
```

In KRYPTONITE's `.agent/mcp.json`, add `"readOnly": true` alongside — that is
what lets these tools run in **Ask** and **Plan** as well as Act.

## Tools

| tool | what it is for |
| --- | --- |
| `gitlab_list_projects` | find a project by name; everything else takes its `path` |
| `gitlab_get_project` | its default branch, visibility, namespace, last activity |
| `gitlab_search_code` | search code inside one project |
| `gitlab_get_file` | read one file at a ref |
| `gitlab_list_merge_requests` | open/merged/closed MRs, newest first |
| `gitlab_get_merge_request` | one MR, optionally with its per-file diff |

### Addressing a project

Both of these work everywhere a `project` argument is taken:

```
platform/services/gateway     the namespaced path, with real slashes
13083                         the numeric id
```

Pass the path unencoded; the `%2F` encoding GitLab requires is applied here.
Getting that wrong is the single most common way a GitLab client fails, and it
fails only on nested groups — which is most of a corporate instance.

### Addressing a merge request

`gitlab_get_merge_request` takes **`iid`**, the per-project number in the MR's
URL. GitLab also has a globally unique `id` on the same object; passing that
returns a different merge request or a 404, and neither is visible in a tool
result. The list tool reports `iid` and does not report `id` at all.

### Code search

`gitlab_search_code` is **project-scoped**, deliberately:

| | needs |
| --- | --- |
| `GET /search?scope=blobs` (instance-wide) | Premium or Ultimate, **and** advanced search (Elasticsearch) or exact code search enabled |
| `GET /projects/:id/search?scope=blobs` | neither |

The project-scoped form is the one that works on a plain self-managed
instance, so it is what the tool uses. Instance-wide search would have returned
an empty list on a Free instance — which reads as "not in the codebase" when
the real answer is "this instance cannot do that".

The query takes GitLab's own filters inline:

```
connectTimeout filename:*.java
parseConfig path:internal/config
TODO extension:go
```

`*` globs. Matches are found in filenames as well as contents, filename matches
first.

## What is capped, and why

| | cap | reason |
| --- | --- | --- |
| one file's diff | 8 KB | one generated lockfile would otherwise eat the whole budget and every real change would be dropped |
| all diffs in one result | 60 KB | two hundred small files still add up past what a tool result should carry |
| `gitlab_get_file` | 100 KB | a context window is not a file viewer |
| a code-search match | 2 KB | enough to judge relevance; read the file for the rest |

A file whose diff was cut **keeps its entry and its paths**. Knowing that
`src/auth.go` changed is most of the value even when the hunks are gone.

## Two things the tools report honestly rather than guessing

**A missing total is not zero.** GitLab stops sending the `x-total` header once
a query returns more than 10,000 records. Reported as `total: 0`, that would
tell a model it had the whole answer when it had the first page of hundreds. It
comes back as `total: null` with `total_unavailable` saying why.

**Absent is not `false`.** The `collapsed` and `too_large` flags on the diffs
endpoint arrived in GitLab 18.4. On an older instance they are simply not there,
so the keys appear only when GitLab actually sent them. Claiming a diff is
complete when we cannot know is how a confidently wrong review gets written.

## Version notes

| | |
| --- | --- |
| `/merge_requests/:iid/diffs` | replaces the deprecated `/changes`. Present from 15.7. |
| `collapsed`, `too_large` | 18.4+. Absent below that; not reported as false. |
| offset pagination | `page` + `per_page`, max 100. `x-total` absent above 10,000 records. |

`probe.py --gitlab` reports your version and flags both of these.
