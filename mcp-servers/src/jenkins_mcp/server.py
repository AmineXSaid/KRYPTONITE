"""jenkins-mcp - read-only job, build, console and artifact access.

Every tool here is a read. This server passes no POST allowlist, so its client
can POST nowhere at all - which matters more on Jenkins than anywhere else in
this package, because Jenkins' interesting endpoints (``/build``, ``/stop``,
``/doDelete``) are all POSTs sitting one path segment away from the ones we
read.

The server is built around one question - *why did this build fail* - and the
tools are ordered so an agent can answer it without being told how:

    jenkins_list_jobs      -> find the job
    jenkins_list_builds    -> find the failing build
    jenkins_get_build      -> what happened, what changed, what it archived
    jenkins_get_console    -> the tail, with the failure lines pulled out
    jenkins_list_artifacts -> what it archived, if anything
    jenkins_get_artifact   -> read a test report or a log it archived

Two behaviours are worth knowing about before reading further:

  * **The console tail costs two requests, on purpose.** Jenkins' progressive
    log endpoint reports the log's full size in a header, so the first request
    is abandoned after a chunk and the second asks for exactly the tail. On a
    200 MB log that is the difference between a tool call and an outage. The
    mechanics, and the trap that makes the obvious version wrong, are in
    ``readonly_client/paths/jenkins.py``.

  * **A build with no artifacts is a normal answer.** Most jobs archive
    nothing. Reporting that as an error makes an agent announce a failure that
    did not happen and stop before reading the console log.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from readonly_client.config import ConfigError, load_config
from readonly_client.errors import NotFoundError, ServiceError
from readonly_client.http import ReadOnlyClient
from readonly_client.mcp_compat import build_server
from readonly_client.paths import jenkins as paths

from .shaping import (
    DEFAULT_CONSOLE_BYTES,
    MAX_ARTIFACT_BYTES,
    find_failure_lines,
    flatten_jobs,
    looks_like_text,
    no_artifacts_note,
    shape_artifact,
    shape_build,
)

# FastMCP in SDK 1.x, MCPServer in 2.x - same decorator model either way.
# See readonly_client.mcp_compat.
mcp = build_server(
    "jenkins-mcp",
    instructions=(
        "Read-only access to a Jenkins instance. Find jobs, read builds and"
        " their console output, and read archived artifacts. Use this to"
        " explain why a build failed. This server cannot start, stop or"
        " modify anything: it issues GET requests only."
    ),
)

# Resolved at startup by main(). Module-level because the SDK's tool functions
# are plain callables with no injection point for dependencies.
_config = None
_client: ReadOnlyClient | None = None


def _require_client() -> ReadOnlyClient:
    if _client is None or _config is None:
        raise ServiceError(
            "jenkins-mcp is not initialised. This is a bug: main() must run "
            "before any tool is called."
        )
    return _client


def _job(job: str) -> str:
    """Validate a job path, turning the ValueError into a tool-shaped error."""
    try:
        paths.job_path(job)
    except ValueError as exc:
        raise ServiceError(str(exc)) from None
    return job


def _limit(requested: int | None, default: int = 20) -> int:
    assert _config is not None
    return _config.clamp_max_results(requested if requested is not None else default)


@mcp.tool()
async def jenkins_list_jobs(folder: str = "", max_results: int = 40) -> dict[str, Any]:
    """List jobs, optionally inside a folder. READ-ONLY.

    Start here when you have part of a job name. Every other tool takes the
    `path` this returns - which is the full folder path, not the bare name,
    because two folders on a corporate instance will both contain a `build`.

    Args:
        folder: Folder to list, e.g. `team/backend`. Omit for the top level.
            Folders are listed one level deep, so their own children come back
            too; pass a folder to go deeper.
        max_results: How many jobs to return.

    Each job carries `status` translated out of Jenkins' ball colours - note
    that `UNSTABLE` (yellow) means the build passed and its tests did not,
    which is a different problem from `FAILURE` (red).
    """
    client = _require_client()
    path = paths.job_api(_job(folder)) if folder.strip() else paths.ROOT_API
    raw = await client.get(path, params={"tree": paths.JOBS_TREE})
    if not isinstance(raw, dict):
        raise ServiceError("Jenkins returned no job list.")

    jobs = flatten_jobs(raw, prefix=folder.strip().strip("/"))
    cap = _limit(max_results, 40)
    out: dict[str, Any] = {
        "jobs": jobs[:cap],
        "returned": min(len(jobs), cap),
        "total": len(jobs),
        "has_more": len(jobs) > cap,
    }
    if folder.strip():
        out["folder"] = folder.strip().strip("/")
    if not jobs:
        out["note"] = (
            "No jobs here. If you expected some, check the folder path - "
            "Jenkins folders nest, so `team/backend` is a path, not a name. "
            "Jenkins also hides jobs your account cannot read rather than "
            "refusing the request."
        )
    return out


@mcp.tool()
async def jenkins_list_builds(job: str, max_results: int = 20) -> dict[str, Any]:
    """List a job's recent builds, newest first. READ-ONLY.

    Args:
        job: Full job path, e.g. `team/backend/build`. Take it from
            `jenkins_list_jobs`.
        max_results: How many builds to return.

    Each build carries `number` (what the other tools take) and `status`, where
    a running build reads `BUILDING` rather than an empty result.
    """
    client = _require_client()
    cap = _limit(max_results, 20)
    raw = await client.get(
        paths.job_api(_job(job)),
        # The range on the tree is load-bearing: without it Jenkins serialises
        # every build the job has ever had, which on a nightly job is tens of
        # thousands of records built server-side before anything is sent.
        params={"tree": paths.builds_tree(cap)},
    )
    if not isinstance(raw, dict):
        raise ServiceError(f"Jenkins returned no record for job {job!r}.")

    builds = [shape_build(b) for b in (raw.get("builds") or []) if isinstance(b, dict)]
    out: dict[str, Any] = {"job": job, "builds": builds, "returned": len(builds)}
    if not builds:
        out["note"] = (
            "This job has no build history. It may never have run, or its "
            "builds may have been discarded by a log-rotation policy."
        )
    return out


@mcp.tool()
async def jenkins_get_build(job: str, build: str = "lastBuild") -> dict[str, Any]:
    """Read one build: result, timing, what triggered it, what changed. READ-ONLY.

    Args:
        job: Full job path, e.g. `team/backend/build`.
        build: Build number, or one of Jenkins' own aliases -
            `lastBuild`, `lastFailedBuild`, `lastSuccessfulBuild`,
            `lastCompletedBuild`, `lastStableBuild`, `lastUnstableBuild`,
            `lastUnsuccessfulBuild`. Defaults to `lastBuild`, so you can ask
            about the most recent run without looking its number up first.

    Returns the causes that triggered it and the commits it contains, which is
    usually where an investigation starts. `artifact_count` says whether
    `jenkins_list_artifacts` is worth calling.
    """
    client = _require_client()
    raw = await client.get(
        paths.build_api(_job(job), build),
        params={"tree": paths.BUILD_DETAIL_TREE},
    )
    if not isinstance(raw, dict):
        raise ServiceError(f"Jenkins returned no record for {job!r} build {build!r}.")
    out = shape_build(raw, full=True)
    out["job"] = job
    return out


@mcp.tool()
async def jenkins_get_console(
    job: str,
    build: str = "lastBuild",
    max_bytes: int = DEFAULT_CONSOLE_BYTES,
    whole_log: bool = False,
) -> dict[str, Any]:
    """Read a build's console output, from the end. READ-ONLY.

    The END is the default because that is where the answer is: a failing build
    prints its stack trace last, and the first 60 KB of a 200 MB log is the
    dependency download.

    Args:
        job: Full job path, e.g. `team/backend/build`.
        build: Build number or alias. Defaults to `lastBuild`.
        max_bytes: How much of the tail to return. Default ~60 KB, which is
            roughly the last thousand lines.
        whole_log: Read from the START instead, still capped at `max_bytes`.
            Use this when the question is about setup or configuration rather
            than a failure.

    Returns the text plus `failure_lines` - lines matching known failure
    markers, quoted verbatim with a little context - so a short answer is
    possible without reading the whole tail. `truncated` says whether anything
    was cut, and `log_bytes` how big the log actually is.
    """
    client = _require_client()
    limit = max(1_000, min(int(max_bytes or DEFAULT_CONSOLE_BYTES), 1_000_000))
    _job(job)
    progressive = paths.progressive_text(job, build)

    if whole_log:
        body = await client.get_text(progressive, params={"start": 0}, max_bytes=limit)
        return _console_result(job, build, body, limit, tail=False, log_bytes=None)

    # Step one: the headers carry the log's full size, and they arrive before
    # the body. `max_bytes=1` makes the reader stop at the first chunk, so this
    # costs one chunk rather than the whole log.
    probe = await client.get_text(progressive, params={"start": 0}, max_bytes=1)
    size = probe.header_int(paths.TEXT_SIZE_HEADER)

    if size is None:
        # No X-Text-Size means this is not the endpoint we think it is - an
        # older instance, or a proxy stripping headers. /consoleText always
        # works; it just has to be streamed in full to reach its end.
        body = await client.get_text(
            paths.console_text(job, build), max_bytes=limit, tail=True
        )
        return _console_result(job, build, body, limit, tail=True, log_bytes=None)

    # Step two. NEVER a start past the size: Jenkins treats that as "the log
    # rolled over" and answers with the whole thing from byte zero.
    start = max(0, size - limit)
    body = await client.get_text(
        progressive, params={"start": start}, max_bytes=limit, tail=True
    )
    out = _console_result(job, build, body, limit, tail=start > 0, log_bytes=size)
    if probe.headers.get(paths.MORE_DATA_HEADER):
        out["still_running"] = True
        out["note"] = (
            "This build is still running, so the log ends where it had got to "
            "when it was read, not at a result."
        )
    return out


def _console_result(
    job: str,
    build: Any,
    body: Any,
    limit: int,
    *,
    tail: bool,
    log_bytes: int | None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "job": job,
        "build": build,
        "console": body.text,
        "returned_bytes": len(body.text.encode("utf-8", errors="ignore")),
        "from_end": tail,
    }
    if log_bytes is not None:
        out["log_bytes"] = log_bytes
        # Only claim truncation when we can actually tell. `body.truncated`
        # answers "did the reader hit its cap", which on a second-request tail
        # is not the same question.
        out["truncated"] = log_bytes > limit
    elif body.truncated:
        out["truncated"] = True

    hits = find_failure_lines(body.text)
    if hits:
        out["failure_lines"] = hits
    elif tail:
        out["failure_lines_note"] = (
            "No known failure markers in this section. The cause may be "
            "earlier in the log - raise max_bytes, or read an archived test "
            "report with jenkins_list_artifacts."
        )
    return out


@mcp.tool()
async def jenkins_list_artifacts(job: str, build: str = "lastBuild") -> dict[str, Any]:
    """List what a build archived. READ-ONLY.

    A test report, a coverage summary or a packaged binary is often a better
    answer than the console log - a surefire XML says which test failed and
    why, where the console says only that the suite did.

    Args:
        job: Full job path, e.g. `team/backend/build`.
        build: Build number or alias. Defaults to `lastBuild`.

    An empty list is a normal answer, not a failure: most jobs archive nothing.
    The result says so and points at the console log instead.

    Note there is no file size here. Jenkins' API does not export one for an
    artifact, and inventing a placeholder would be worse than its absence.
    """
    client = _require_client()
    raw = await client.get(
        paths.build_api(_job(job), build), params={"tree": paths.ARTIFACTS_TREE}
    )
    if not isinstance(raw, dict):
        raise ServiceError(f"Jenkins returned no record for {job!r} build {build!r}.")

    items = [shape_artifact(a) for a in (raw.get("artifacts") or []) if isinstance(a, dict)]
    if not items:
        return no_artifacts_note(job, build)
    return {
        "job": job,
        "build": build,
        "artifacts": items,
        "returned": len(items),
    }


@mcp.tool()
async def jenkins_get_artifact(
    job: str,
    path: str,
    build: str = "lastBuild",
    max_bytes: int = MAX_ARTIFACT_BYTES,
) -> dict[str, Any]:
    """Read one archived artifact as text. READ-ONLY.

    Args:
        job: Full job path, e.g. `team/backend/build`.
        path: The artifact's `path` from `jenkins_list_artifacts`, e.g.
            `target/surefire-reports/TEST-com.acme.AuthTest.xml`.
        build: Build number or alias. Defaults to `lastBuild`.
        max_bytes: Cap on how much text to return. Default ~200 KB.

    Only text is returned. A binary artifact - a JAR, a tarball, an image - is
    described rather than decoded, because its bytes teach a model nothing and
    cost a context window.
    """
    client = _require_client()
    _job(job)
    try:
        url = paths.artifact(job, build, path)
    except ValueError as exc:
        raise ServiceError(str(exc)) from None

    if not looks_like_text(path):
        # Refused before the request, not after: downloading a 400 MB tarball
        # to conclude it is a tarball is the mistake worth not making.
        return {
            "job": job,
            "build": build,
            "path": path,
            "content": None,
            "refused": (
                f"{path} does not look like a text file, so its bytes are not "
                "returned. If it really is text, rename the request to the "
                "file's real extension or read it from the console log."
            ),
        }

    limit = max(1_000, min(int(max_bytes or MAX_ARTIFACT_BYTES), 1_000_000))
    try:
        body = await client.get_text(url, max_bytes=limit)
    except NotFoundError as exc:
        # 404 here has two meanings and they lead different places: the build
        # archived nothing at all, or it archived something else.
        raise NotFoundError(
            f"{exc}\n\nList what this build actually archived with "
            f"jenkins_list_artifacts(job={job!r}, build={build!r}) - the path "
            "must match its `path` exactly, including directories."
        ) from None

    out: dict[str, Any] = {
        "job": job,
        "build": build,
        "path": path,
        "content": body.text,
        "returned_bytes": len(body.text.encode("utf-8", errors="ignore")),
    }
    if body.truncated:
        out["truncated"] = True
        out["note"] = f"Only the first {limit} bytes are shown."
    return out


def main() -> int:
    """Start the server, or refuse to start and say exactly what is missing."""
    global _config, _client
    try:
        _config = load_config(
            "JENKINS_BASE_URL",
            "Jenkins",
            env_prefix="JENKINS",
            # Basic only. Jenkins has no personal-access-token header: a user
            # authenticates as username + API token over HTTP Basic. Offering
            # `bearer` would be offering a mode that produces a 401 looking
            # exactly like a bad credential.
            auth_modes=("basic",),
            default_auth_mode="basic",
            # No search_post_allowlist. Jenkins' /build, /stop and /doDelete
            # are POSTs one segment away from paths we read, so this client is
            # GET-only and there is nothing to widen.
            wrong_path_hint=paths.WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        # stderr, not stdout: stdout is the MCP transport. A message written
        # there corrupts the protocol stream instead of reaching the user.
        print(f"jenkins-mcp: configuration error\n  {exc}", file=sys.stderr)
        return 2

    _client = ReadOnlyClient(_config)
    try:
        mcp.run()
    finally:
        try:
            asyncio.run(_client.aclose())
        except RuntimeError:
            # Event loop already closed by the transport during shutdown; the
            # process is exiting and the sockets go with it.
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
