"""jira-mcp - read-only JQL search and issue lookup over a Jira Data Center instance.

Every tool here is a read. The HTTP layer underneath refuses to build anything
but a GET (plus POST to the one allowlisted search path), so this module could
not perform a write even if a tool asked it to.

Tool descriptions carry a worked JQL example in the description string itself,
not just in the README. A model choosing between tools reads the description
and nothing else, and "jql: str" with no example produces guessed field names
and a 400 the model cannot diagnose.
"""

from __future__ import annotations

import asyncio
import sys
from typing import Any

from readonly_client.attachments import fetch_attachment, pick_attachment
from readonly_client.config import ConfigError, load_config
from readonly_client.mcp_compat import ImageBlock, build_server
from readonly_client.errors import ServiceError
from readonly_client.http import ReadOnlyClient
from readonly_client.paths.atlassian import (
    EXTRA_HEADERS,
    JIRA_FIELDS,
    JIRA_ISSUE,
    JIRA_PROJECTS,
    JIRA_SEARCH,
    SEARCH_POST_ALLOWLIST,
    WRONG_PATH_HINT,
)

from .shaping import (
    DEFAULT_ISSUE_FIELDS,
    shape_field,
    shape_issue,
    shape_jira_attachment,
    shape_project,
    shape_search,
)

# FastMCP in SDK 1.x, MCPServer in 2.x - same decorator model either way.
# See readonly_client.mcp_compat.
mcp = build_server(
    "jira-mcp",
    instructions=(
        "Read-only access to a Jira Data Center instance. Search with JQL, read"
        " issues, list projects and fields, and fetch attached images so they"
        " can actually be looked at. This server cannot modify anything."
    ),
)

# Resolved at startup by main(). Module-level because FastMCP tool functions
# are plain callables with no injection point for dependencies.
_config = None
_client: ReadOnlyClient | None = None


def _require_client() -> ReadOnlyClient:
    if _client is None or _config is None:
        raise ServiceError(
            "jira-mcp is not initialised. This is a bug: main() must run before "
            "any tool is called."
        )
    return _client


def _split_fields(fields: str | list[str] | None) -> tuple[str, ...]:
    """Accept either a comma string or a list.

    Models produce both, and rejecting one form wastes a turn teaching them
    which. Empty entries are dropped rather than sent as ``fields=,,``.
    """
    if fields is None:
        return ()
    if isinstance(fields, str):
        parts = fields.split(",")
    else:
        parts = list(fields)
    return tuple(p.strip() for p in parts if str(p).strip())


@mcp.tool()
async def jira_search(
    jql: str,
    max_results: int = 25,
    fields: str | list[str] | None = None,
    start_at: int = 0,
) -> dict[str, Any]:
    """Search Jira issues with JQL. READ-ONLY - this never modifies anything.

    `jql` is raw Jira Query Language, passed through untouched. Example:
        project = PLATFORM AND status != Done AND updated >= -14d ORDER BY updated DESC

    Use jira_list_projects first if you do not know the project key - guessing
    a key gives a 400, not an empty result. Use jira_list_fields to find custom
    field names before referencing them in JQL or in `fields`.

    Args:
        jql: The JQL query. Required.
        max_results: Page size. Clamped to the server's cap (default 50, max 100).
        fields: Extra fields beyond the standard projection, as a comma string
            or list, e.g. "labels,customfield_10101". The projection always
            includes key, summary, status, issue_type, assignee, reporter,
            priority, updated and url.
        start_at: Offset for pagination. Data Center uses offset paging; pass
            the `next_start_at` from a previous response to continue.

    Returns a page, not the whole result set: check `total` and `has_more`.
    """
    client = _require_client()
    assert _config is not None

    if not jql or not jql.strip():
        raise ServiceError(
            "jql is required and cannot be empty. To list everything recently "
            "updated, try: ORDER BY updated DESC"
        )

    extra = _split_fields(fields)
    limit = _config.clamp_max_results(max_results)
    requested = list(DEFAULT_ISSUE_FIELDS) + [f for f in extra if f not in DEFAULT_ISSUE_FIELDS]

    # Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
    # API version 2 (Data Center). Offset pagination: startAt + maxResults.
    # NOTE Cloud divergence: Jira Cloud has retired this endpoint in favour of
    # /rest/api/3/search/jql with nextPageToken. That does NOT apply to DC.
    #
    # GET rather than POST: the read-only guard allows POST here, but only
    # because Atlassian requires it for JQL too long for a URL. A GET is the
    # honest default and keeps the request visible in access logs.
    raw = await client.get(
        JIRA_SEARCH,
        params={
            "jql": jql.strip(),
            "startAt": max(0, int(start_at or 0)),
            "maxResults": limit,
            "fields": ",".join(requested),
            # Suppress the expand blob; we never render it and it is large.
            "validateQuery": "strict",
        },
    )
    return shape_search(raw, base_url=_config.base_url, extra_fields=extra)


@mcp.tool()
async def jira_get_issue(
    issue_key: str,
    fields: str | list[str] | None = None,
) -> dict[str, Any]:
    """Fetch one Jira issue by key. READ-ONLY - this never modifies anything.

    `issue_key` is the human key, not the numeric id. Example: PLATFORM-1423

    Args:
        issue_key: e.g. "PLATFORM-1423".
        fields: Extra fields beyond the standard projection, as a comma string
            or list, e.g. "description,labels,customfield_10101". Use
            jira_list_fields to discover custom field ids.

    Returns key, summary, status, issue_type, assignee, reporter, priority,
    updated and url, plus any extra fields requested under `fields`.
    """
    client = _require_client()
    assert _config is not None

    key = (issue_key or "").strip()
    if not key:
        raise ServiceError("issue_key is required, e.g. PLATFORM-1423.")

    extra = _split_fields(fields)
    requested = list(DEFAULT_ISSUE_FIELDS) + [f for f in extra if f not in DEFAULT_ISSUE_FIELDS]

    # Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
    # API version 2 (Data Center).
    raw = await client.get(
        JIRA_ISSUE.format(issue_key=key),
        params={"fields": ",".join(requested)},
    )
    return shape_issue(raw, base_url=_config.base_url, extra_fields=extra)


async def _attachments_for(issue_key: str) -> list[dict[str, Any]]:
    """Every attachment on an issue, projected.

    Jira has no attachment listing endpoint: attachments are a FIELD, so this
    is `jira_get_issue` asking for one field and nothing else. Requesting only
    `attachment` matters on a wide instance - the default projection drags in
    seven more fields, and this call needs none of them.
    """
    client = _require_client()
    assert _config is not None
    raw = await client.get(
        JIRA_ISSUE.format(issue_key=issue_key), params={"fields": "attachment"}
    )
    fields = raw.get("fields") if isinstance(raw, dict) else None
    items = fields.get("attachment") if isinstance(fields, dict) else None
    return [
        shape_jira_attachment(a, base_url=_config.base_url)
        for a in (items or [])
        if isinstance(a, dict)
    ]


@mcp.tool()
async def jira_list_attachments(issue_key: str) -> dict[str, Any]:
    """List the files attached to a Jira issue. READ-ONLY.

    A bug report's evidence is usually a screenshot, and jira_get_issue does
    not carry attachments in its default projection. This is how you find out
    what is attached and which of it jira_get_attachment can show you.

    Args:
        issue_key: The human key, e.g. "PLATFORM-1423" - not the numeric id.

    Each entry carries filename, media_type, size, author and two flags worth
    reading before asking for the bytes:

        viewable      - the model can look at this one. png, jpeg, gif, webp.
        downloadable  - the instance told us where the bytes are.

    A .log or a .har lists with viewable: false. That is the honest answer:
    this server does not convert files, and a model handed one would get a
    blob rather than a document.
    """
    key = (issue_key or "").strip()
    if not key:
        raise ServiceError("issue_key is required, e.g. PLATFORM-1423.")
    items = await _attachments_for(key)
    return {
        "issue_key": key,
        "returned": len(items),
        "viewable": sum(1 for a in items if a.get("viewable")),
        "attachments": items,
    }


@mcp.tool()
async def jira_get_attachment(issue_key: str, filename: str) -> list[dict[str, Any] | ImageBlock]:
    """Fetch one image attached to a Jira issue, so the model can SEE it.

    READ-ONLY - this never modifies anything.

    Use jira_list_attachments first if you do not know the exact filename; a
    near miss is matched case-insensitively and by substring, but an ambiguous
    one is refused rather than guessed - a model told the right name can
    correct itself, one handed the wrong screenshot cannot.

    Args:
        issue_key: e.g. "PLATFORM-1423".
        filename: The attachment's name, e.g. "stacktrace.png".

    Returns a summary followed by the image itself. Only png, jpeg, gif and
    webp are fetched, and anything larger than a few megabytes is refused
    rather than truncated: half a file is a decode error, not a picture.
    """
    key = (issue_key or "").strip()
    if not key:
        raise ServiceError("issue_key is required, e.g. PLATFORM-1423.")

    items = await _attachments_for(key)
    chosen = pick_attachment(items, filename, where=f"issue {key}")
    return await fetch_attachment(chosen, _require_client())


@mcp.tool()
async def jira_list_projects(query: str | None = None) -> dict[str, Any]:
    """List Jira projects you can see. READ-ONLY - this never modifies anything.

    Exists so JQL can be written against a real project key instead of a
    guessed one. Example: query="platform" matches the PLATFORM project and any
    project whose name contains "platform".

    Args:
        query: Optional case-insensitive substring, matched against both key
            and name. Omit to list everything visible to your account.

    Returns key, name, id, type and lead for each project.
    """
    client = _require_client()
    assert _config is not None

    # Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
    # API version 2 (Data Center). Returns all visible projects, unpaginated.
    #
    # NOTE Cloud divergence: Cloud offers a paginated /rest/api/2/project/search.
    # Whether a given DC version serves that path is not something this client
    # will assume, so we take the endpoint that has been stable across DC
    # releases and filter here. See paths.py.
    raw = await client.get(JIRA_PROJECTS)
    projects = [shape_project(p) for p in (raw if isinstance(raw, list) else [])]

    if query and query.strip():
        needle = query.strip().lower()
        projects = [
            p
            for p in projects
            if needle in str(p.get("key", "")).lower()
            or needle in str(p.get("name", "")).lower()
        ]

    return {
        "total": len(projects),
        "returned": len(projects),
        "has_more": False,  # unpaginated endpoint; the filter is client-side
        "query": query,
        "projects": projects,
    }


@mcp.tool()
async def jira_list_fields(query: str | None = None) -> dict[str, Any]:
    """List Jira fields, including custom fields. READ-ONLY - never modifies anything.

    Corporate instances define hundreds of custom fields, and their ids are not
    guessable. Use this to find the id before passing it to `fields`, or the
    JQL clause name before using it in a query. Example: query="sprint" finds
    the Sprint field, its customfield_* id and its JQL clause names.

    Args:
        query: Optional case-insensitive substring matched against field name
            and id. Omit to list every field.

    Returns id (use in `fields`), name, custom, type and clause_names (use in
    JQL). The id and the JQL clause name are often different - a custom field
    is `customfield_10101` in `fields` but may be `cf[10101]` or a quoted name
    in JQL.
    """
    client = _require_client()

    # Doc: https://developer.atlassian.com/server/jira/platform/rest/v10004/
    # API version 2 (Data Center). Returns all fields, system and custom.
    raw = await client.get(JIRA_FIELDS)
    fields = [shape_field(f) for f in (raw if isinstance(raw, list) else [])]

    if query and query.strip():
        needle = query.strip().lower()
        fields = [
            f
            for f in fields
            if needle in str(f.get("name", "")).lower()
            or needle in str(f.get("id", "")).lower()
        ]

    return {
        "total": len(fields),
        "returned": len(fields),
        "has_more": False,
        "query": query,
        "fields": fields,
    }


def main() -> int:
    """Start the server, or refuse to start and say exactly what is missing."""
    global _config, _client
    try:
        _config = load_config(
            "JIRA_BASE_URL",
            "Jira",
            env_prefix="ATLASSIAN",
            auth_modes=("bearer", "basic"),
            extra_headers=EXTRA_HEADERS,
            # Only Jira gets the POST carve-out, and only for /search. The
            # Confluence server below passes no allowlist at all, so its client
            # is GET-only however the code around it changes.
            search_post_allowlist=SEARCH_POST_ALLOWLIST,
            wrong_path_hint=WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        # stderr, not stdout: stdout is the MCP transport. A message written
        # there corrupts the protocol stream instead of reaching the user.
        print(f"jira-mcp: configuration error\n  {exc}", file=sys.stderr)
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
