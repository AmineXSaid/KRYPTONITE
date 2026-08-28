"""Turning Jenkins payloads into an answer to "why did this build fail".

Jenkins' API is unusually good at being asked for exactly what you want -
``?tree=`` prunes on the server, so most of the trimming happens before the
payload is built. What is left for this module is the part `tree` cannot do:
making the result legible.

Two things drive everything here.

**A timestamp in epoch milliseconds is not an answer.** Jenkins reports
`timestamp: 1755859200000` and `duration: 754000`. A model reading those has to
do arithmetic to say anything, and gets it wrong. Both are converted, and the
originals are kept for anything that needs to compute.

**`result: null` means "still running", not "no result".** Jenkins leaves
`result` null while a build is in progress, and a shaping layer that reports
that as failure-of-unknown-type describes a build that has not failed. `status`
here is never null: a running build reads `BUILDING`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

#: How much of an artifact `jenkins_get_artifact` will return as text.
MAX_ARTIFACT_BYTES = 200_000

#: Default tail for a console log. Roughly a thousand lines of build output,
#: which is where a stack trace lives.
DEFAULT_CONSOLE_BYTES = 60_000

#: Extensions whose bytes are worth returning as text. Everything else is
#: described rather than decoded - a model handed a JAR has learned nothing.
TEXT_ARTIFACT_SUFFIXES = (
    ".txt", ".log", ".xml", ".json", ".yaml", ".yml", ".csv", ".tsv",
    ".html", ".htm", ".md", ".properties", ".ini", ".cfg", ".conf",
    ".java", ".py", ".js", ".ts", ".go", ".rb", ".sh", ".sql", ".diff",
    ".patch", ".out", ".err", ".tfstate", ".gradle", ".toml",
)


def _epoch_ms(value: Any) -> str | None:
    """Epoch milliseconds as an ISO-8601 UTC string."""
    try:
        return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _duration(ms: Any) -> str | None:
    """Milliseconds as something a person reads without converting."""
    try:
        total = int(ms) // 1000
    except (TypeError, ValueError):
        return None
    if total < 0:
        return None
    if total < 60:
        return f"{total}s"
    if total < 3600:
        return f"{total // 60}m {total % 60}s"
    return f"{total // 3600}h {(total % 3600) // 60}m"


def build_status(b: Mapping[str, Any]) -> str:
    """The one field that must never be null.

    Jenkins leaves `result` null for a build that is still running. Passing
    that through makes a running build look like an unclassifiable failure, and
    an agent asked "did it pass" answers as though something went wrong.
    """
    if b.get("building"):
        return "BUILDING"
    result = b.get("result")
    return str(result) if result else "UNKNOWN"


# ──────────────────────────────── jobs ─────────────────────────────────────


def shape_job(j: Mapping[str, Any]) -> dict[str, Any]:
    """A job as: what to call it, and whether it is currently broken.

    `fullName` leads over `name` because it is the path every other tool here
    takes - `name` alone is ambiguous the moment two folders each contain a
    job called `build`, which on a corporate instance is immediately.
    """
    out: dict[str, Any] = {
        "path": j.get("fullName") or j.get("name"),
        "name": j.get("name"),
        "url": j.get("url"),
    }
    colour = j.get("color")
    if colour is not None:
        out["status"] = colour_to_status(str(colour))
        if str(colour).endswith("_anime"):
            # Jenkins encodes "currently building" as a suffix on the colour,
            # which is easy to miss and changes what the status means.
            out["building"] = True
    if j.get("buildable") is False:
        out["disabled"] = True
    desc = j.get("description")
    if desc:
        out["description"] = str(desc)[:300]
    # A folder is a job to this API, and its children arrive nested. Reporting
    # the count lets a caller decide whether to descend without a second call.
    kids = j.get("jobs")
    if isinstance(kids, list):
        out["is_folder"] = True
        out["contains"] = len(kids)
    return {k: v for k, v in out.items() if v is not None}


#: Jenkins reports job health as a ball colour. The mapping is not obvious -
#: `yellow` is UNSTABLE (tests failed, build succeeded), which is a different
#: thing from `red` (the build itself failed), and conflating them mis-reports
#: every flaky test suite as a broken build.
COLOUR_STATUS = {
    "blue": "SUCCESS",
    "green": "SUCCESS",
    "yellow": "UNSTABLE",
    "red": "FAILURE",
    "grey": "NOT_BUILT",
    "disabled": "DISABLED",
    "aborted": "ABORTED",
    "notbuilt": "NOT_BUILT",
}


def colour_to_status(colour: str) -> str:
    return COLOUR_STATUS.get(colour.removesuffix("_anime"), colour)


def flatten_jobs(node: Mapping[str, Any], *, prefix: str = "") -> list[dict[str, Any]]:
    """Walk one level of folders into a flat list of jobs.

    Folders nest, and a caller asking "what jobs are there" does not want a
    tree - it wants names it can pass to the next tool. Only the levels the
    `tree` parameter actually fetched are walked; nothing here issues requests.
    """
    out: list[dict[str, Any]] = []
    for j in node.get("jobs") or []:
        if not isinstance(j, Mapping):
            continue
        row = shape_job(j)
        if prefix and row.get("path") and "/" not in str(row["path"]):
            row["path"] = f"{prefix}/{row['path']}"
        out.append(row)
        if isinstance(j.get("jobs"), list):
            out.extend(flatten_jobs(j, prefix=str(row.get("path") or "")))
    return out


# ─────────────────────────────── builds ────────────────────────────────────


def shape_build(b: Mapping[str, Any], *, full: bool = False) -> dict[str, Any]:
    """A build as: which one, what happened, when, and for how long."""
    out: dict[str, Any] = {
        "number": b.get("number"),
        "status": build_status(b),
        "url": b.get("url"),
    }
    started = _epoch_ms(b.get("timestamp"))
    if started:
        out["started_at"] = started
    took = _duration(b.get("duration"))
    if took:
        out["duration"] = took
    if b.get("building"):
        out["building"] = True
    if not full:
        return out

    out["display_name"] = b.get("displayName")
    out["timestamp_ms"] = b.get("timestamp")
    out["duration_ms"] = b.get("duration")

    causes = _causes(b)
    if causes:
        # "Why did this run at all" is half of "why did it fail" - a nightly
        # timer and a push from a named branch fail for different reasons.
        out["causes"] = causes

    changes = _changes(b)
    if changes:
        out["changes"] = changes

    arts = b.get("artifacts")
    if isinstance(arts, list):
        out["artifact_count"] = len(arts)
    return {k: v for k, v in out.items() if v is not None}


def _causes(b: Mapping[str, Any]) -> list[str]:
    """Pull build causes out of the `actions` array.

    `actions` is a heterogeneous list where most entries are plugin payloads
    and only some carry `causes`. Anything without one is skipped rather than
    guessed at.
    """
    found: list[str] = []
    for action in b.get("actions") or []:
        if not isinstance(action, Mapping):
            continue
        for cause in action.get("causes") or []:
            if isinstance(cause, Mapping):
                text = cause.get("shortDescription")
                if text:
                    found.append(str(text))
    return found[:5]


def _changes(b: Mapping[str, Any], limit: int = 10) -> list[dict[str, Any]]:
    """The commits in this build, which is usually the first place to look."""
    changeset = b.get("changeSet")
    if not isinstance(changeset, Mapping):
        return []
    rows: list[dict[str, Any]] = []
    for item in (changeset.get("items") or [])[:limit]:
        if not isinstance(item, Mapping):
            continue
        author = item.get("author")
        rows.append(
            {
                "commit": str(item.get("commitId") or "")[:12] or None,
                "message": str(item.get("msg") or "")[:200] or None,
                "author": author.get("fullName") if isinstance(author, Mapping) else None,
            }
        )
    return [{k: v for k, v in r.items() if v is not None} for r in rows]


# ────────────────────────────── artifacts ──────────────────────────────────


def shape_artifact(a: Mapping[str, Any]) -> dict[str, Any]:
    """An artifact as the path `jenkins_get_artifact` takes.

    `relativePath` leads because that is the argument; `fileName` is kept
    because it is what a human recognises. There is deliberately no `size`:
    Jenkins' Artifact class has a getLength() but does not export it, so asking
    for `size` in a tree returns nothing at all - which would look like every
    artifact is empty.
    """
    return {
        "path": a.get("relativePath"),
        "file_name": a.get("fileName"),
    }


def looks_like_text(path: str) -> bool:
    lowered = path.lower()
    return lowered.endswith(TEXT_ARTIFACT_SUFFIXES)


def no_artifacts_note(job: str, build: Any) -> dict[str, Any]:
    """The answer when a build archived nothing.

    This is a normal outcome, not an error. Most builds archive nothing, and
    raising here would make an agent report a failure that did not happen -
    then stop, instead of reading the console log, which is where the answer
    was all along.
    """
    return {
        "job": job,
        "build": build,
        "artifacts": [],
        "returned": 0,
        "note": (
            "This build archived no artifacts. That is normal - most jobs "
            "archive nothing unless a pipeline step asks them to. Use "
            "jenkins_get_console for the build output instead."
        ),
    }


# ──────────────────────────────── console ──────────────────────────────────

#: Lines that mark where a build went wrong. Deliberately short and specific:
#: a list that matches "error" as a substring flags every line of a build that
#: compiles a file called error_handler.go, and a summary of two hundred false
#: positives is worse than no summary.
FAILURE_MARKERS = (
    "BUILD FAILURE",
    "BUILD FAILED",
    "FAILURE: Build failed",
    "Finished: FAILURE",
    "Finished: UNSTABLE",
    "Finished: ABORTED",
    "ERROR: script returned exit code",
    "Traceback (most recent call last)",
    "Exception in thread",
    "AssertionError",
    "Tests run:",
    "npm ERR!",
    "fatal error:",
    "error: cannot find symbol",
    "The command '/bin/sh -c",
    "OOMKilled",
    "No space left on device",
    "Connection refused",
    "signal: killed",
)


def find_failure_lines(text: str, *, limit: int = 25, context: int = 2) -> list[str]:
    """Lines that name what broke, with a little context around each.

    This is a hint, not a diagnosis. A model reading a 60 KB tail can find
    these itself; the value is in putting them at the top so a short answer is
    possible without reading the whole tail. The lines are quoted verbatim -
    nothing here interprets them.
    """
    lines = text.splitlines()
    hits: list[int] = [
        n for n, line in enumerate(lines) if any(m in line for m in FAILURE_MARKERS)
    ]
    if not hits:
        return []

    wanted: set[int] = set()
    for n in hits[-limit:]:
        wanted.update(range(max(0, n - context), min(len(lines), n + context + 1)))

    out: list[str] = []
    previous: int | None = None
    for n in sorted(wanted):
        if previous is not None and n > previous + 1:
            out.append("…")
        out.append(lines[n][:500])
        previous = n
    return out
