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

from atlassian_client.config import ConfigError, load_config
from atlassian_client.mcp_compat import build_server
from atlassian_client.errors import AtlassianError
from atlassian_client.http import ReadOnlyClient
from atlassian_client.paths import (
    CONFLUENCE_CONTENT,
    CONFLUENCE_SEARCH,
    CONFLUENCE_SPACES,
)

from .shaping import shape_page, shape_search, shape_space

# FastMCP in SDK 1.x, MCPServer in 2.x - same decorator model either way.
# See atlassian_client.mcp_compat.
mcp = build_server(
    "confluence-mcp",
    instructions=(
        "Read-only access to a Confluence Data Center instance. Search with CQL"
        ", read pages as Markdown, list spaces. This server cannot modify anything."
    ),
)

_config = None
_client: ReadOnlyClient | None = None


def _require_client() -> ReadOnlyClient:
    if _client is None or _config is None:
        raise AtlassianError(
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
        raise AtlassianError(
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
        raise AtlassianError(
            "page_id is required. It is the numeric content id from "
            "confluence_search, e.g. 123456789 - not the page title."
        )

    fmt = (body_format or "storage").strip().lower()
    if fmt not in ("storage", "none"):
        raise AtlassianError(
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
        _config = load_config("CONFLUENCE_BASE_URL", "Confluence")
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
