"""confluence-mcp - read-only CQL search and page retrieval over Confluence Data Center.

Same guarantees as jira-mcp: every tool is a read, and the shared HTTP layer
refuses to build anything else.

The one substantive difference from Jira is `confluence_get_page`, which
converts storage-format XHTML to Markdown before returning. That conversion is
not a nicety - raw storage format is an order of magnitude larger than the prose
it contains and is close to unreadable, so returning it would waste the context
the answer needs.
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
    CONFLUENCE_ATTACHMENTS,
    CONFLUENCE_CONTENT,
    CONFLUENCE_SEARCH,
    CONFLUENCE_SPACES,
    EXTRA_HEADERS,
    WRONG_PATH_HINT,
)

from .shaping import shape_confluence_attachment, shape_page, shape_search, shape_space

# FastMCP in SDK 1.x, MCPServer in 2.x - same decorator model either way.
# See readonly_client.mcp_compat.
mcp = build_server(
    "confluence-mcp",
    instructions=(
        "Read-only access to a Confluence Data Center instance. Search with CQL"
        ", read pages as Markdown, list spaces, and fetch attached images so"
        " they can actually be looked at. This server cannot modify anything."
    ),
)

_config = None
_client: ReadOnlyClient | None = None


def _require_client() -> ReadOnlyClient:
    if _client is None or _config is None:
        raise ServiceError(
            "confluence-mcp is not initialised. This is a bug: main() must run "
            "before any tool is called."
        )
    return _client


@mcp.tool()
async def confluence_search(
    cql: str,
    max_results: int = 25,
    start: int = 0,
) -> dict[str, Any]:
    """Search Confluence with CQL. READ-ONLY - this never modifies anything.

    `cql` is raw Confluence Query Language, passed through untouched. Example:
        space = ENG AND type = page AND text ~ "rollback procedure" ORDER BY lastmodified DESC

    CQL is not JQL. Text matching uses `~`, not `=`. Use confluence_list_spaces
    first if you do not know the space key - guessing gives a 400, not an empty
    result.

    Args:
        cql: The CQL query. Required.
        max_results: Page size. Clamped to the server's cap (default 50, max 100).
        start: Offset for pagination. Pass `next_start` from a previous
            response to continue. Note Confluence uses start/limit where Jira
            uses startAt/maxResults.

    Returns a page, not the whole result set: check `total` and `has_more`.
    Each hit carries id, title, space_key, type, last_modified, url and excerpt.
    Use confluence_get_page with the id to read the body.
    """
    client = _require_client()
    assert _config is not None

    if not cql or not cql.strip():
        raise ServiceError(
            'cql is required and cannot be empty. To list recent pages, try: '
            'type = page ORDER BY lastmodified DESC'
        )

    limit = _config.clamp_max_results(max_results)

    # Doc: https://developer.atlassian.com/server/confluence/rest/v920/
    # API version: rest/api (v1), Data Center - NO /wiki prefix.
    # NOTE Cloud divergence: Cloud serves this at /wiki/rest/api/content/search
    # and additionally offers /wiki/api/v2, which does not exist on DC.
    # Pagination is start/limit here, not Jira's startAt/maxResults.
    raw = await client.get(
        CONFLUENCE_SEARCH,
        params={
            "cql": cql.strip(),
            "start": max(0, int(start or 0)),
            "limit": limit,
            # `space` gives us the key without a second call; `version` gives
            # the modification date. Nothing else is expanded - expansions are
            # where Confluence payloads balloon.
            "expand": "space,version,history.lastUpdated",
        },
    )
    return shape_search(raw, base_url=_config.base_url, start=max(0, int(start or 0)))


@mcp.tool()
async def confluence_get_page(
    page_id: str,
    body_format: str = "storage",
) -> dict[str, Any]:
    """Fetch one Confluence page and return its body as readable Markdown.

    READ-ONLY - this never modifies anything.

    `page_id` is the numeric content id, which you get from confluence_search.
    Example: page_id="123456789"

    The body is fetched in Confluence's storage format (XHTML) and converted to
    Markdown before it is returned. Storage format is unusable as-is: a short
    page is tens of kilobytes of markup, and its code blocks, tables and links
    are encoded in Confluence-specific elements that plain tag-stripping
    destroys.

    Args:
        page_id: Numeric content id, e.g. "123456789".
        body_format: "storage" (default) converts to Markdown. Pass "none" to
            fetch metadata only, which is much cheaper if you only need the
            title, space and modification date.

    Returns id, title, space_key, type, last_modified, url, version and body.
    """
    client = _require_client()
    assert _config is not None

    pid = (page_id or "").strip()
    if not pid:
        raise ServiceError(
            "page_id is required. It is the numeric content id from "
            "confluence_search, e.g. 123456789 - not the page title."
        )

    fmt = (body_format or "storage").strip().lower()
    if fmt not in ("storage", "none"):
        raise ServiceError(
            f"body_format must be 'storage' or 'none', got {body_format!r}. "
            "'storage' fetches the body and converts it to Markdown; 'none' "
            "returns metadata only."
        )

    expand = ["space", "version", "history.lastUpdated"]
    if fmt == "storage":
        expand.append("body.storage")

    # Doc: https://developer.atlassian.com/server/confluence/rest/v920/
    # API version: rest/api (v1), Data Center - NO /wiki prefix.
    raw = await client.get(
        CONFLUENCE_CONTENT.format(page_id=pid),
        params={"expand": ",".join(expand)},
    )
    return shape_page(raw, base_url=_config.base_url, include_body=fmt == "storage")


async def _attachments_for(page_id: str) -> list[dict[str, Any]]:
    """Every attachment on a page, projected. Shared by both tools below.

    Not a tool itself: `confluence_get_attachment` needs the same list in order
    to resolve a filename to a download link, and calling the listing tool from
    inside the fetching one would mean the fetch inherits whatever the listing
    tool's paging did.
    """
    client = _require_client()
    assert _config is not None
    raw = await client.get(
        CONFLUENCE_ATTACHMENTS.format(page_id=page_id),
        # `version` carries who attached it and when. The cap is the config's,
        # so a page with hundreds of attachments cannot flood the context.
        params={"limit": _config.max_results_cap, "start": 0, "expand": "version"},
    )
    results = raw.get("results") if isinstance(raw, dict) else None
    return [
        shape_confluence_attachment(a, base_url=_config.base_url)
        for a in (results or [])
        if isinstance(a, dict)
    ]


@mcp.tool()
async def confluence_list_attachments(page_id: str) -> dict[str, Any]:
    """List the files attached to a Confluence page. READ-ONLY.

    A page body converted to Markdown shows an image as `[image: name.png]`,
    which is a filename and not a picture. This is how you find out what those
    names refer to, and which of them confluence_get_attachment can actually
    show you.

    Args:
        page_id: Numeric content id, e.g. "123456789" - the same id
            confluence_get_page takes, not the page title.

    Each entry carries filename, media_type, size, author and two flags worth
    reading before you ask for the bytes:

        viewable      - the model can look at this one. png, jpeg, gif, webp.
        downloadable  - the instance told us where the bytes are.

    A PDF or an .xlsx lists with viewable: false. That is not a failure, it is
    the honest answer: this server does not convert documents, and pretending
    otherwise would hand the model a blob it cannot read.
    """
    pid = (page_id or "").strip()
    if not pid:
        raise ServiceError(
            "page_id is required. It is the numeric content id from "
            "confluence_search, e.g. 123456789 - not the page title."
        )
    items = await _attachments_for(pid)
    return {
        "page_id": pid,
        "returned": len(items),
        "viewable": sum(1 for a in items if a.get("viewable")),
        "attachments": items,
    }


@mcp.tool()
async def confluence_get_attachment(page_id: str, filename: str) -> list[dict[str, Any] | ImageBlock]:
    """Fetch one image attached to a Confluence page, so the model can SEE it.

    READ-ONLY - this never modifies anything.

    This is the tool that turns `[image: topology.png]` in a page body into an
    actual picture. Use confluence_list_attachments first if you do not know
    the exact filename; a near miss is matched case-insensitively and by
    substring, but an ambiguous one is refused rather than guessed.

    Args:
        page_id: Numeric content id, e.g. "123456789".
        filename: The attachment's name, e.g. "topology.png".

    Returns a summary followed by the image itself. Only png, jpeg, gif and
    webp are fetched - those are what a model can be shown - and anything
    larger than a few megabytes is refused rather than truncated, because half
    a file is a decode error rather than a picture.
    """
    pid = (page_id or "").strip()
    if not pid:
        raise ServiceError("page_id is required, e.g. 123456789.")

    items = await _attachments_for(pid)
    chosen = pick_attachment(items, filename, where=f"page {pid}")
    return await fetch_attachment(chosen, _require_client())


@mcp.tool()
async def confluence_list_spaces(query: str | None = None) -> dict[str, Any]:
    """List Confluence spaces you can see. READ-ONLY - never modifies anything.

    Exists so CQL can be written against a real space key instead of a guessed
    one. Example: query="eng" matches the ENG space and any space whose name
    contains "eng".

    Args:
        query: Optional case-insensitive substring, matched against both key
            and name. Omit to list everything visible to your account.

    Returns key, name, id, type and url for each space. Use the key in CQL,
    e.g. space = ENG.
    """
    client = _require_client()
    assert _config is not None

    # Doc: https://developer.atlassian.com/server/confluence/rest/v920/
    # API version: rest/api (v1), Data Center. Paginated with start/limit; the
    # cap is applied to the page we request, then filtered client-side.
    raw = await client.get(
        CONFLUENCE_SPACES,
        params={"limit": _config.max_results_cap, "start": 0},
    )
    results = raw.get("results") if isinstance(raw, dict) else None
    spaces = [shape_space(s, base_url=_config.base_url) for s in (results or [])]

    if query and query.strip():
        needle = query.strip().lower()
        spaces = [
            s
            for s in spaces
            if needle in str(s.get("key", "")).lower()
            or needle in str(s.get("name", "")).lower()
        ]

    size = raw.get("size", len(spaces)) if isinstance(raw, dict) else len(spaces)
    total = raw.get("totalSize") if isinstance(raw, dict) else None
    return {
        # Confluence does not always report a grand total on this endpoint, so
        # `total` may be the page size. `has_more` is what to trust.
        "total": total if isinstance(total, int) else size,
        "returned": len(spaces),
        "has_more": bool(isinstance(raw, dict) and raw.get("_links", {}).get("next")),
        "query": query,
        "spaces": spaces,
    }


def main() -> int:
    """Start the server, or refuse to start and say exactly what is missing."""
    global _config, _client
    try:
        _config = load_config(
            "CONFLUENCE_BASE_URL",
            "Confluence",
            env_prefix="ATLASSIAN",
            auth_modes=("bearer", "basic"),
            extra_headers=EXTRA_HEADERS,
            # No search_post_allowlist: CQL search is a GET. This client cannot
            # POST anywhere at all.
            wrong_path_hint=WRONG_PATH_HINT,
        )
    except ConfigError as exc:
        # stderr: stdout is the MCP transport.
        print(f"confluence-mcp: configuration error\n  {exc}", file=sys.stderr)
        return 2

    _client = ReadOnlyClient(_config)
    try:
        mcp.run()
    finally:
        try:
            asyncio.run(_client.aclose())
        except RuntimeError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
