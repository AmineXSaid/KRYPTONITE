# jenkins-mcp

Read-only job, build, console and artifact access over a Jenkins instance.
Built around one question: **why did this build fail.**

**This server cannot modify anything.** That matters more here than anywhere
else in this package: Jenkins' `/build`, `/stop` and `/doDelete` are POSTs
sitting one path segment away from the endpoints we read. This server passes no
POST allowlist at all, so its client cannot POST anywhere — see
[read-only enforcement](../README.md#how-read-only-is-enforced).

## Generating your own API token

Jenkins has no personal-access-token header. You authenticate as your username
plus an API token, over HTTP Basic. **Not your password.**

1. Sign in to Jenkins (`https://jenkins.company.internal`).
2. Click your **name**, top right → **Configure** (older versions:
   **People** → your user → **Configure**).
3. Under **API Token**, click **Add new Token** and name it, e.g.
   `mcp-readonly`.
4. **Generate**, then **copy it now** — Jenkins shows it once.
5. Put your login in `.env` as `JENKINS_USER` and the token as
   `JENKINS_TOKEN`.

An API token inherits your permissions exactly. If you cannot see a job in the
UI, this server cannot see it either — Jenkins hides it rather than refusing
the request, so an empty job list is a permissions answer, not a bug.

> No CSRF crumb is needed. Jenkins requires a crumb for state-changing
> requests; this client makes none.

## Environment

```bash
JENKINS_BASE_URL=https://jenkins.company.internal
JENKINS_AUTH_MODE=basic
JENKINS_USER=<your login>
JENKINS_TOKEN=<your API token>

# Console reads are the slowest call here. 120s is a sensible ceiling.
# JENKINS_READ_TIMEOUT=120

# Only if your instance uses an internally-signed certificate.
# MCP_CA_BUNDLE=/etc/ssl/certs/corp-root.pem
```

The base URL is the instance root, plus a context path (`/jenkins`) if it is
deployed under one — but nothing from `/job` or `/api` onward.

Verify before wiring anything up:

```bash
set -a; source .env; set +a
python probe.py --jenkins
```

The probe reports the version and then checks the one thing the console tail
depends on: whether `X-Text-Size` survives to the client. See
[reading a console log](#reading-a-console-log).

## MCP client config

```json
{
  "mcpServers": {
    "jenkins": {
      "command": "/absolute/path/to/mcp-servers/.venv/bin/jenkins-mcp",
      "env": {
        "JENKINS_BASE_URL": "https://jenkins.company.internal",
        "JENKINS_AUTH_MODE": "basic",
        "JENKINS_USER": "<your login>",
        "JENKINS_TOKEN": "<your API token>",
        "JENKINS_READ_TIMEOUT": "120"
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
| `jenkins_list_jobs` | find a job; everything else takes its `path` |
| `jenkins_list_builds` | recent builds, newest first |
| `jenkins_get_build` | result, timing, what triggered it, what changed |
| `jenkins_get_console` | the log, from the end, with failure lines pulled out |
| `jenkins_list_artifacts` | what the build archived |
| `jenkins_get_artifact` | read an archived test report or log |

### Addressing a job

Jenkins folders nest, and a job is addressed by its **full path**:

```
team/backend/build
```

which becomes `/job/team/job/backend/job/build` — one `/job/` segment per
level. Joining with plain slashes produces a URL that 404s, and the failure
reads as a missing job rather than a malformed path, so the tools take the path
and build the URL. A pasted Jenkins URL works too; the `/job/` segments are
recognised and collapsed.

### Addressing a build

Every tool that takes a build accepts a number **or** one of Jenkins' own
aliases, which it resolves server-side:

```
lastBuild  lastCompletedBuild  lastSuccessfulBuild  lastStableBuild
lastFailedBuild  lastUnsuccessfulBuild  lastUnstableBuild
```

The default is `lastBuild`, so *"why did the last build fail"* needs no number
looked up first — and `lastFailedBuild` answers it directly when the job has
since gone green.

## Reading a console log

`jenkins_get_console` returns the **end** of the log, because that is where the
answer is: a failing build prints its stack trace last, and the first 60 KB of
a 200 MB log is the dependency download.

Getting the end cheaply takes two requests, and the obvious version of this is
backwards. From `LargeText.doProgressTextImpl` in Stapler, which serves
`/logText/progressiveText`:

- `X-Text-Size` always carries the log's full byte length.
- `?start=N` streams from byte N to the end.
- **`start` greater than the length resets to 0 and sends the whole log** — the
  source comments this "text rolled over". So asking for a huge offset to
  discover the size cheaply downloads everything instead.
- A negative `start` means "tail" only on the multipart streaming path, not
  this one, where it throws `EOFException`.

So: one request whose headers give the size and whose body is abandoned after a
chunk, then a second with `start = size − wanted`. On a 200 MB log that is a
hundred kilobytes off the wire instead of all of it.

If `X-Text-Size` does not arrive — an older instance, or a reverse proxy
stripping it — the server falls back to `/consoleText`, which is correct and
slower: the whole log crosses the wire, memory stays bounded at the cap, and
only the tail is kept. `probe.py --jenkins` tells you which case you are in
before you find out on the instance's worst job.

### `failure_lines`

Each console result carries lines matching known failure markers, quoted
verbatim with two lines of context, so a short answer is possible without
reading the whole tail. Gaps are marked `…` — two lines from opposite ends of a
log printed adjacently read as consecutive output and invent a causal link that
is not there.

The marker list is short and specific on purpose. A list that matched `error`
as a substring would flag every line of a build that compiles
`error_handler.go`, and a summary of two hundred false positives is worse than
no summary.

## Artifacts

A test report is often a better answer than the console log — a surefire XML
says *which* test failed and why, where the console says only that the suite
did.

**A build with no artifacts is a normal answer, not an error.** Most jobs
archive nothing. `jenkins_list_artifacts` returns an empty list with a note
pointing at the console log, because raising here would make an agent report a
failure that did not happen and stop before reading the log where the cause
actually was.

**Only text is returned.** `jenkins_get_artifact` refuses a binary — a JAR, a
tarball, an image — *before* making the request, by extension. Downloading a
400 MB tarball to conclude that it is a tarball is the mistake worth not
making.

**There is no file size.** Jenkins' `Run.Artifact` has a `getLength()` but does
not export it, so asking for `size` in a tree returns nothing and makes every
artifact look like zero bytes. Its absence is honest; a placeholder would not
be.

## Two things reported carefully

**`result: null` means running, not failed.** Jenkins leaves `result` null
while a build is in progress. Passed through, that makes a slow build look like
an unclassifiable failure. `status` here is never null: a running build reads
`BUILDING`, and a console read of one says `still_running` so a log that stops
mid-sentence is not mistaken for a crash.

**`UNSTABLE` is not `FAILURE`.** Jenkins reports job health as a ball colour,
and yellow means the build succeeded and its tests did not — a different
problem from red, which is the build itself failing. Collapsing them reports
every flaky suite as a broken build. The `_anime` suffix on a colour means
"currently building" and is reported as a separate `building` flag rather than
being lost.

## A worked investigation

> *Why did CTH-8899 fail?*

```
jenkins_list_jobs(folder="")                    → find the job path
jenkins_get_build(job="…", build="lastFailedBuild")
                                                → result, cause, commits
jenkins_get_console(job="…", build=…)           → the tail + failure_lines
jenkins_list_artifacts(job="…", build=…)        → a surefire report?
jenkins_get_artifact(job="…", path="target/surefire-reports/TEST-x.xml")
```

If the job name is actually a **Jira issue key** rather than a Jenkins job —
`CTH-8899` reads like one — that is a `jira-mcp` question, and the two servers
answer different halves of it: Jira for what the ticket says, Jenkins for what
the build did.
