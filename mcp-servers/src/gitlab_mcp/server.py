"""gitlab-mcp - read-only search and read over a self-managed GitLab instance.

Every tool here is a read. The HTTP layer underneath refuses to build anything
but a GET - this server passes no POST allowlist at all, so unlike jira-mcp it
cannot POST anywhere, to a search path or otherwise.

Two facts about GitLab shape the whole surface, and both are in the tool
descriptions rather than only here, because a model choosing between tools
reads the description and nothing else:

  * **A project is addressed by `group/subgroup/repo` or by numeric id.** The
    path is what a human has; the id is what a GitLab URL carries. Both work
    everywhere here, and the encoding is handled for you - pass the path with
    real slashes.

  * **A merge request is addressed by its `iid`, not its `id`.** The iid is
    the number in the MR's URL and the one every human uses. The `id` field
    also exists, is globally unique, and silently addresses a different MR.
    Tools take `iid` and say so.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from readonly_client.config import ConfigError, load_config
from readonly_client.errors import NotFoundError, ServiceError
from readonly_client.http import ReadOnlyClient
from readonly_client.mcp_compat import build_server
from readonly_client.paths import gitlab as paths

from .shaping import (
    BinaryFile,
    decode_file,
    paginated,
    shape_blob_hit,
    shape_diffs,
    shape_merge_request,
    shape_project,
)

# FastMCP in SDK 1.x, MCPServer in 2.x - same decorator model either way.
# See readonly_client.mcp_compat.
mcp = build_server(
    "gitlab-mcp",
    instructions=(
        "Read-only access to a self-managed GitLab instance. Find projects,"
        " search code, read files, and read merge requests and their diffs."
        " This server cannot modify anything: it issues GET requests only."
    ),
)

# Resolved at startup by main(). Module-level because the SDK's tool functions
# are plain callables with no injection point for dependencies.
_config = None
_client: ReadOnlyClient | None = None


def _require_client() -> ReadOnlyClient:
    if _client is None or _config is None:
        raise ServiceError(
            "gitlab-mcp is not initialised. This is a bug: main() must run "
            "before any tool is called."
        )
    return _client


def _page_size(requested: int | None) -> int:
    """Clamp to both the configured cap and GitLab's own per_page maximum."""
    assert _config is not None
    return min(_config.clamp_max_results(requested), paths.MAX_PER_PAGE)


def _paging(resp: Any) -> dict[str, Any]:
    """Pull GitLab's pagination out of the response headers.

    It is entirely in headers on this API - there is no envelope around the
    JSON array - which is why every list tool here uses `get_full`.
    """
    return {
        "total": resp.header_int("x-total"),
        "next_page": resp.header_int("x-next-page"),
        "page": resp.header_int("x-page"),
        "per_page": resp.header_int("x-per-page"),
    }


def _as_list(data: Any, what: str) -> list[dict[str, Any]]:
    if not isinstance(data, list):
        raise ServiceError(
            f"GitLab returned {type(data).__name__} where a list of {what} was "
            "expected. If this instance sits behind a gateway that rewrites "
            "responses, that is the first thing to check."
        )
    return [d for d in data if isinstance(d, dict)]


@mcp.tool()
async def gitlab_list_projects(
    search: str | None = None,
    membership: bool = True,
    max_results: int = 25,
    page: int = 1,
) -> dict[str, Any]:
    """Find projects by name or path. READ-ONLY - this never modifies anything.

    Start here when you have a repository name but not its full path. Every
    other tool in this server takes a project as either the numeric `id` or the
    `path` this returns, so this is how you get one.

    Args:
        search: Substring matched against a project's path, name and
            description, case-insensitively. Omit to list everything you can
            see, most recently created first.
        membership: Restrict to projects you are a member of. True by default,
            because on a corporate instance the unrestricted list is thousands
            of projects and almost none of them are the one you want. Set False
            to search the whole instance.
        max_results: Page size. Clamped to the configured cap and to GitLab's
            own maximum of 100.
        page: 1-based page number. Pass `next_page` from a previous result.

    Returns a page. Check `total` and `has_more` - and note that `total` is
    null rather than zero when GitLab declines to count a result set above
    10,000, which is not the same as an empty one.
    """
    client = _require_client()
    resp = await client.get_full(
        paths.PROJECTS,
        params={
            "search": search or None,
            "membership": "true" if membership else None,
            # A list call wants the small record; get_project returns the full
            # one. Without this each row carries ~100 keys of which we keep 6.
            "simple": "true",
            "order_by": "last_activity_at",
            "per_page": _page_size(max_results),
            "page": max(1, int(page or 1)),
        },
    )
    rows = [shape_project(p) for p in _as_list(resp.data, "projects")]
    return paginated(rows, key="projects", **_paging(resp))


@mcp.tool()
async def gitlab_get_project(project: str) -> dict[str, Any]:
    """Read one project's details. READ-ONLY - this never modifies anything.

    Use this to confirm a project's default branch before reading files from
    it: `gitlab_get_file` needs a ref, and the default branch is not always
    `main` on an older instance.

    Args:
        project: `group/subgroup/repo` or the numeric project id. Pass the path
            with real slashes; encoding is handled here.

    Returns the project with its namespace, visibility, default branch and last
    activity.
    """
    client = _require_client()
    raw = await client.get(paths.project(project))
    if not isinstance(raw, dict):
        raise ServiceError(f"GitLab returned no project record for {project!r}.")
    return shape_project(raw, full=True)


@mcp.tool()
async def gitlab_search_code(
    project: str,
    query: str,
    ref: str | None = None,
    max_results: int = 20,
    page: int = 1,
) -> dict[str, Any]:
    """Search code inside one project. READ-ONLY - this never modifies anything.

    This is project-scoped deliberately. GitLab's instance-wide code search
    needs Premium or Ultimate AND advanced search (Elasticsearch) switched on;
    project-scoped blob search needs neither, so it is the one that works on a
    plain self-managed instance. Use `gitlab_list_projects` first if you do not
    know which project to search.

    The query supports GitLab's own filters, which go inside the search string:

        connectTimeout filename:*.java
        parseConfig path:internal/config
        TODO extension:go

    `*` globs. Matches are found in filenames as well as contents, and
    filename matches are listed first.

    Args:
        project: `group/subgroup/repo` or the numeric project id.
        query: The search term, optionally with filename:/path:/extension:.
        ref: Branch or tag to search. Defaults to the project's default branch.
        max_results: Page size, clamped to the configured cap and to 100.
        page: 1-based page number.

    Returns hits with `path`, `startline` and the matching text. Read the whole
    file with `gitlab_get_file` once you know where to look.
    """
    client = _require_client()
    if not query or not query.strip():
        raise ServiceError(
            "query is required and cannot be empty. To find a file by name "
            "rather than by content, search for its name with a filename: "
            "filter, e.g. 'filename:Dockerfile'."
        )

    try:
        resp = await client.get_full(
            paths.project_search(project),
            params={
                "scope": "blobs",
                "search": query,
                "ref": ref or None,
                "per_page": _page_size(max_results),
                "page": max(1, int(page or 1)),
            },
        )
    except NotFoundError as exc:
        # A 404 here has a second meaning worth separating: GitLab answers 404
        # for a project you cannot see, AND the search endpoint itself is
        # absent on very old instances. Saying only "not found" sends someone
        # to check a project path that was correct.
        raise NotFoundError(
            f"{exc}\n\nIf {project!r} is correct and you can open it in the "
            "browser, the other possibility is that this instance does not "
            "expose /search on a project. Run probe.py --gitlab to tell the "
            "two apart."
        ) from None

    hits = [shape_blob_hit(h) for h in _as_list(resp.data, "search hits")]
    out = paginated(hits, key="hits", **_paging(resp))
    if not hits:
        out["note"] = (
            "No matches. Blob search reads the default branch unless you pass "
            "`ref`, and it does not match across line breaks. If you expected "
            "results, try a shorter distinctive substring."
        )
    return out


@mcp.tool()
async def gitlab_get_file(project: str, path: str, ref: str = "HEAD") -> dict[str, Any]:
    """Read one file from a repository. READ-ONLY - this never modifies anything.

    Args:
        project: `group/subgroup/repo` or the numeric project id.
        path: Path within the repository, with real slashes, e.g.
            `internal/config/loader.go`. Encoding is handled here.
        ref: Branch, tag or commit SHA. Defaults to `HEAD`, which GitLab
            resolves to the project's default branch.

    Returns the decoded text. A binary file is refused with its size and path
    rather than returned as base64, and a file over ~100 KB is truncated with
    a note saying so - use `gitlab_search_code` to locate the part you need.
    """
    client = _require_client()
    if not path or not path.strip():
        raise ServiceError("path is required, e.g. 'src/main.go'.")

    raw = await client.get(
        paths.file(project, path.strip().lstrip("/")),
        params={"ref": ref or "HEAD"},
    )
    if not isinstance(raw, dict):
        raise ServiceError(f"GitLab returned no file record for {path!r}.")
    try:
        return decode_file(raw)
    except BinaryFile as exc:
        # A refusal with a reason, not an error: the model asked a reasonable
        # question and this IS the answer.
        return {
            "path": raw.get("file_path", path),
            "ref": raw.get("ref", ref),
            "size": raw.get("size"),
            "content": None,
            "refused": str(exc),
        }


@mcp.tool()
async def gitlab_list_merge_requests(
    project: str,
    state: str = "opened",
    target_branch: str | None = None,
    author: str | None = None,
    max_results: int = 20,
    page: int = 1,
) -> dict[str, Any]:
    """List a project's merge requests. READ-ONLY - this never modifies anything.

    Args:
        project: `group/subgroup/repo` or the numeric project id.
        state: `opened`, `closed`, `merged`, `locked` or `all`. Defaults to
            `opened`, which is what a question about current work means.
        target_branch: Restrict to MRs targeting this branch, e.g. `main`.
        author: Restrict to one author's username (not their display name).
        max_results: Page size, clamped to the configured cap and to 100.
        page: 1-based page number.

    Returns each MR by `iid` - the number in its URL, and the one
    `gitlab_get_merge_request` takes. Sorted most recently updated first.
    """
    client = _require_client()
    allowed = ("opened", "closed", "merged", "locked", "all")
    if state not in allowed:
        raise ServiceError(
            f"state must be one of {', '.join(allowed)}, got {state!r}."
        )

    resp = await client.get_full(
        paths.merge_requests(project),
        params={
            "state": state,
            "target_branch": target_branch or None,
            "author_username": author or None,
            "order_by": "updated_at",
            "sort": "desc",
            "per_page": _page_size(max_results),
            "page": max(1, int(page or 1)),
        },
    )
    rows = [shape_merge_request(m) for m in _as_list(resp.data, "merge requests")]
    return paginated(rows, key="merge_requests", **_paging(resp))


@mcp.tool()
async def gitlab_get_merge_request(
    project: str,
    iid: int,
    include_diff: bool = False,
    diff_page: int = 1,
) -> dict[str, Any]:
    """Read one merge request, optionally with its diff. READ-ONLY.

    Args:
        project: `group/subgroup/repo` or the numeric project id.
        iid: The merge request's per-project number - the one in its URL, shown
            as `iid` by `gitlab_list_merge_requests`. NOT the global `id`,
            which addresses a different MR.
        include_diff: Also fetch the per-file diff. Off by default because a
            large MR's diff is most of a context window and is usually not what
            was asked for.
        diff_page: Which page of changed files to fetch when `include_diff` is
            set. 20 files per page.

    The diff is capped twice - per file and over the whole result - so one
    generated lockfile cannot crowd out every real change. A file whose diff
    was cut keeps its entry and its path, and says it was cut.
    """
    client = _require_client()
    raw = await client.get(paths.merge_request(project, int(iid)))
    if not isinstance(raw, dict):
        raise ServiceError(f"GitLab returned no merge request !{iid} in {project!r}.")
    out = shape_merge_request(raw, full=True)

    if include_diff:
        # /diffs, not the deprecated /changes: /changes returns every file in
        # one unpaginated envelope, which is unreadable on a large MR.
        diffs = await client.get(
            paths.merge_request_diffs(project, int(iid)),
            params={"page": max(1, int(diff_page or 1)), "per_page": 20},
        )
        out["diff"] = shape_diffs(_as_list(diffs, "diff entries"))
        out["diff"]["page"] = max(1, int(diff_page or 1))
    return out


def main() -> int:
    """Start the server, or refuse to start and say exactly what is missing."""
    global _config, _client
    try:
        _config = load_config(
            "GITLAB_BASE_URL",
            "GitLab",
            env_prefix="GITLAB",
            # `header` only. GitLab documents PRIVATE-TOKEN as the home for a
            # personal access token, and older self-managed instances reject
            # the same token sent as `Authorization: Bearer` with a 401 that
            # looks exactly like a bad credential. Offering `bearer` here would
            # be offering a choice that can only turn into that.
            auth_modes=("header",),
            default_auth_mode="header",
            auth_header_name="PRIVATE-TOKEN",
            # No search_post_allowlist. Every call this server makes is a GET,
            # so its client can POST nowhere at all.
            wrong_path_hint=paths.WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        # stderr, not stdout: stdout is the MCP transport. A message written
        # there corrupts the protocol stream instead of reaching the user.
        print(f"gitlab-mcp: configuration error\n  {exc}", file=sys.stderr)
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
