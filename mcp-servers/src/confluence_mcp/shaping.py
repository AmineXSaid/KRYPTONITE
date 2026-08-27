"""Trimming Confluence payloads to the fields specified in the brief.

Confluence's expansion model means a payload's size is decided by what you ask
to expand - but even a minimal response carries a ``_links`` block on every
object, a ``_expandable`` map listing everything you did not request, and
version metadata nested three deep. All of that is dropped here.

The projection is { id, title, space_key, type, last_modified, url, excerpt }.
``url`` is built from the instance base plus the webui link, because the
``self`` link in the payload is the REST URL and is no use to a person.
"""

from __future__ import annotations

from typing import Any, Mapping

from .storage import html_excerpt, storage_to_markdown


def _webui_url(raw: Mapping[str, Any], base_url: str) -> str | None:
    """Build the human-facing page URL.

    Confluence returns a relative ``webui`` path under ``_links``. On Data
    Center that is relative to the instance root; the ``base`` the payload
    sometimes carries is the same thing, so we prefer our configured base_url
    and fall back to the payload's only if ours is somehow absent.
    """
    links = raw.get("_links")
    if not isinstance(links, Mapping):
        return None
    webui = links.get("webui")
    if not isinstance(webui, str) or not webui:
        return None
    return f"{base_url.rstrip('/')}{webui}"


def _last_modified(raw: Mapping[str, Any]) -> str | None:
    """The modification timestamp, from whichever expansion supplied it.

    ``version.when`` is present when ``version`` was expanded;
    ``history.lastUpdated.when`` when ``history.lastUpdated`` was. Search and
    content responses differ in which they carry, so both are checked.
    """
    version = raw.get("version")
    if isinstance(version, Mapping) and isinstance(version.get("when"), str):
        return version["when"]
    history = raw.get("history")
    if isinstance(history, Mapping):
        last = history.get("lastUpdated")
        if isinstance(last, Mapping) and isinstance(last.get("when"), str):
            return last["when"]
    return None


def _space_key(raw: Mapping[str, Any]) -> str | None:
    space = raw.get("space")
    if isinstance(space, Mapping):
        key = space.get("key")
        if isinstance(key, str):
            return key
    return None


def shape_result(raw: Mapping[str, Any], *, base_url: str) -> dict[str, Any]:
    """One search hit, reduced to the standard projection."""
    return {
        "id": raw.get("id"),
        "title": raw.get("title"),
        "space_key": _space_key(raw),
        "type": raw.get("type"),
        "last_modified": _last_modified(raw),
        "url": _webui_url(raw, base_url),
        "excerpt": html_excerpt(str(raw.get("excerpt") or "")),
    }


def shape_search(
    raw: Mapping[str, Any], *, base_url: str, start: int
) -> dict[str, Any]:
    """A ``/content/search`` response, with pagination facts.

    Confluence reports ``size`` (this page) and sometimes ``totalSize`` (the
    whole set), and which you get varies by endpoint and version. When
    ``totalSize`` is absent we report the page size as the total and rely on
    ``has_more``, which is derived from the ``next`` link and is always right.
    """
    results = raw.get("results")
    items = results if isinstance(results, list) else []
    returned = len(items)

    total_size = raw.get("totalSize")
    total = total_size if isinstance(total_size, int) else raw.get("size", returned)

    links = raw.get("_links")
    has_more = bool(isinstance(links, Mapping) and links.get("next"))

    return {
        "total": total if isinstance(total, int) else returned,
        "start": start,
        "returned": returned,
        # Derived from the `next` link rather than arithmetic on total, because
        # `total` is the unreliable one here.
        "has_more": has_more,
        "next_start": start + returned if has_more else None,
        "results": [shape_result(r, base_url=base_url) for r in items],
    }


def shape_page(
    raw: Mapping[str, Any], *, base_url: str, include_body: bool
) -> dict[str, Any]:
    """One page, with its body converted to Markdown when requested."""
    version = raw.get("version")
    version_number = (
        version.get("number") if isinstance(version, Mapping) else None
    )

    shaped: dict[str, Any] = {
        "id": raw.get("id"),
        "title": raw.get("title"),
        "space_key": _space_key(raw),
        "type": raw.get("type"),
        "last_modified": _last_modified(raw),
        "url": _webui_url(raw, base_url),
        "version": version_number,
    }

    if include_body:
        body = raw.get("body")
        storage = ""
        if isinstance(body, Mapping):
            node = body.get("storage")
            if isinstance(node, Mapping) and isinstance(node.get("value"), str):
                storage = node["value"]
        shaped["body"] = storage_to_markdown(storage)
        shaped["body_format"] = "markdown"
        # Says plainly that a conversion happened, so a caller comparing this
        # against the page in a browser knows why the markup differs.
        shaped["body_note"] = (
            "Converted from Confluence storage format (XHTML) to Markdown."
        )

    return shaped


def shape_space(raw: Mapping[str, Any], *, base_url: str) -> dict[str, Any]:
    """A space reduced to what is needed to write CQL against it."""
    return {
        "key": raw.get("key"),
        "name": raw.get("name"),
        "id": raw.get("id"),
        "type": raw.get("type"),
        "url": _webui_url(raw, base_url),
    }
