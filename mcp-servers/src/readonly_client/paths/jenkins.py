"""Every Jenkins path jenkins-mcp uses, with its provenance.

── VERIFICATION STATUS ──────────────────────────────────────────────────────
These are read off the primary source: the Java that serves them, in
``jenkinsci/jenkins`` core and ``jenkinsci/stapler``, at master on 2026-08-27.
Each entry names the class and method. That confirms the SHAPE; it does not
confirm your instance's version or its plugins, so each still carries a status:

    CONFIRMED     the web method exists in core and its behaviour is read
                  from the implementation, not inferred
    NEEDS-PROBE   depends on your instance's layout, plugins or permissions

``probe.py --jenkins`` checks each root and reports the version.

── URL SHAPE ────────────────────────────────────────────────────────────────
Jenkins nests jobs one ``/job/`` segment at a time, so a job called ``build``
inside folder ``team/backend`` lives at ``/job/team/job/backend/job/build``.
That is why :func:`job_path` exists: joining the segments with ``/`` produces a
URL that 404s, and the failure looks like a missing job rather than a malformed
path.

── AUTH ─────────────────────────────────────────────────────────────────────
Jenkins has no personal-access-token header. A user authenticates with HTTP
Basic as ``username:apiToken`` - the API token from the user's own
Configure page, never the account password.

No CSRF crumb is involved here: Jenkins' crumb requirement applies to state-
changing requests, and this client issues none.

── THE CONSOLE, AND WHY IT TAKES TWO REQUESTS ───────────────────────────────
Read from ``LargeText.doProgressTextImpl`` in stapler, which is what serves
``/logText/progressiveText``:

  * ``X-Text-Size`` is ALWAYS set, and carries the full byte length of the log.
  * ``X-More-Data: true`` appears while the build is still writing.
  * ``?start=N`` streams from byte N to the end.
  * **``start`` greater than the length resets to 0 and sends the whole log.**
    The source comments this "text rolled over". So a speculative huge start,
    to discover the size cheaply, does the exact opposite - it downloads
    everything.
  * A negative ``start`` means "tail" ONLY on the multipart streaming path, not
    on this one, where it reaches ``writeLogUncounted`` and throws EOFException.

So the tail is: one request whose HEADERS give the size and whose body is
abandoned after a chunk, then a second with ``start = size - wanted``. Two round
trips, and a hundred kilobytes off the wire instead of two hundred megabytes.

``/consoleText`` (``Run.doConsoleTextImpl``) is the fallback: it is
``text/plain;charset=UTF-8``, has no ``start``, and must be streamed in full.
"""

from __future__ import annotations

from urllib.parse import quote

# Response headers on /logText/progressiveText. See the module docstring.
TEXT_SIZE_HEADER = "X-Text-Size"
MORE_DATA_HEADER = "X-More-Data"

#: Build numbers Jenkins resolves as path segments in their own right. Handy
#: because "why did the last build fail" is the actual question, and it does
#: not require knowing a number first. Source: Job.getLastBuild() and friends,
#: which Stapler exposes under these names.
BUILD_ALIASES: tuple[str, ...] = (
    "lastBuild",
    "lastCompletedBuild",
    "lastSuccessfulBuild",
    "lastStableBuild",
    "lastFailedBuild",
    "lastUnsuccessfulBuild",
    "lastUnstableBuild",
)


def job_path(job: str) -> str:
    """Turn ``team/backend/build`` into ``/job/team/job/backend/job/build``.

    Status: CONFIRMED. Every path segment gets its own ``/job/`` prefix, and
    each is quoted because a job name may legally contain a space.

    A leading or trailing slash, or the ``/job/`` prefixes already written out
    by a caller who pasted a URL, are all accepted - a model will produce each
    of those, and rejecting them costs a turn teaching it which we wanted.
    """
    raw = (job or "").strip().strip("/")
    if not raw:
        raise ValueError("A job path is required, e.g. 'team/backend/build'.")
    parts = [p for p in raw.split("/") if p and p != "job"]
    if not parts:
        raise ValueError(f"{job!r} contains no job name.")
    return "".join(f"/job/{quote(p, safe='')}" for p in parts)


def build_path(job: str, build: int | str) -> str:
    """Status: CONFIRMED. ``build`` is a number or one of BUILD_ALIASES."""
    return f"{job_path(job)}/{quote(str(build), safe='')}"


# ──────────────────────────────── the API ──────────────────────────────────
#
# Source: hudson.model.Api.doJson. Every model object exposes /api/json, and
# the `tree` query parameter prunes it server-side.

ROOT_API = "/api/json"


def job_api(job: str) -> str:
    """Status: CONFIRMED."""
    return f"{job_path(job)}/api/json"


def build_api(job: str, build: int | str) -> str:
    """Status: CONFIRMED."""
    return f"{build_path(job, build)}/api/json"


def console_text(job: str, build: int | str) -> str:
    """Status: CONFIRMED - hudson.model.Run.doConsoleTextImpl.

    text/plain;charset=UTF-8, whole log, no offset. The fallback when
    progressive text is unavailable.
    """
    return f"{build_path(job, build)}/consoleText"


def progressive_text(job: str, build: int | str) -> str:
    """Status: CONFIRMED - AnnotatedLargeText.doProgressiveText, which Stapler
    reaches through Run.getLogText(). Takes ``?start=N``; see the module
    docstring for the exact semantics, which are not what you would guess."""
    return f"{build_path(job, build)}/logText/progressiveText"


def artifact(job: str, build: int | str, relative_path: str) -> str:
    """Status: CONFIRMED - hudson.model.Run.doArtifact serves the archive
    through DirectoryBrowserSupport, so a file is at ``/artifact/<path>``.

    The path is quoted per segment: ``/`` stays a separator here, because
    this is a directory tree rather than a single opaque id, but a space or a
    ``#`` in a filename still has to be escaped.
    """
    clean = "/".join(
        quote(p, safe="")
        for p in relative_path.strip().strip("/").split("/")
        if p and p != ".."
    )
    if not clean:
        raise ValueError("An artifact path is required, e.g. 'target/report.xml'.")
    return f"{build_path(job, build)}/artifact/{clean}"


# ───────────────────────── tree: server-side pruning ───────────────────────
#
# Source: hudson.model.Api.doJson -> NamedPathPruner. Grammar, from
# NamedPathPruner.parseRange: `field[sub,sub]{N,M}`, where the range may be
# {N,M}, {N}, {,M} or {N,}.
#
# This matters more here than anywhere else in this package. A bare
# /api/json on a folder walks every job it contains; on a build it returns
# every action, every changeset entry and every parameter. `tree` prunes on the
# SERVER, so the payload is never built - which is the difference between a
# tool call and a timeout on a large instance.

# Fields exported by Job (hudson.model.Job + AbstractItem).
JOB_FIELDS = "name,fullName,url,color,buildable,description"

# Nested one level so a folder's children come back with the folder. A folder
# is itself a job to this API, so `jobs[jobs[...]]` reads one level down.
JOBS_TREE = f"jobs[{JOB_FIELDS}]"

# Fields exported by Run (hudson.model.Run). `result` is null while building,
# which is why `building` is fetched alongside it rather than inferred.
BUILD_FIELDS = "number,result,building,timestamp,duration,url,displayName"


def builds_tree(limit: int) -> str:
    """`builds[...]{0,N}` - N most recent builds, pruned server-side.

    Without the range Jenkins serialises every build the job has ever had.
    """
    return f"builds[{BUILD_FIELDS}]{{0,{max(1, int(limit))}}}"


# Artifact exports exactly three fields - relativePath, fileName and
# displayPath (hudson.model.Run.Artifact). There is a getLength(), but it
# carries no @Exported annotation, so asking for `size` here returns nothing
# and looks like every artifact is zero bytes.
ARTIFACTS_TREE = "artifacts[fileName,relativePath]"

# Enough of a build to explain a failure, in one call.
BUILD_DETAIL_TREE = (
    f"{BUILD_FIELDS},{ARTIFACTS_TREE},"
    "actions[causes[shortDescription,userName]],"
    "changeSet[items[commitId,msg,author[fullName]]]"
)


# ───────────────────────── the read-only surface ───────────────────────────
#
# No allowlist: every Jenkins call here is a GET, so the config names none and
# the client can POST nowhere. The absence is deliberate and is written down
# because Jenkins' interesting endpoints - /build, /stop, /doDelete - are all
# POSTs, and a carve-out here would reach every one of them.

EXTRA_HEADERS: dict[str, str] = {}

WRONG_PATH_HINT = (
    "Jenkins serves its API from the instance root, so the base URL should "
    "stop at the hostname - plus a context path such as /jenkins if it is "
    "deployed under one, but nothing from /job or /api onward."
)
