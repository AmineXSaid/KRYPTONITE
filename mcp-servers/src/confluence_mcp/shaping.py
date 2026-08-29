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

from readonly_client.attachments import shape_attachment
from readonly_client.paths.atlassian import download_url_for

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
        markdown = storage_to_markdown(storage)
        shaped["body"] = markdown
        shaped["body_format"] = "markdown"
        # Says plainly that a conversion happened, so a caller comparing this
        # against the page in a browser knows why the markup differs.
        note = "Converted from Confluence storage format (XHTML) to Markdown."
        # An image survives the conversion as `[image: topology.png]`, which is
        # a filename and not a picture. Said ONCE here rather than inlined at
        # every marker: a page with twenty screenshots would otherwise repeat
        # the same sentence twenty times, and the model needs the tool name, not
        # the reminder. Without it, `[image: ...]` is a dead end that reads like
        # one - which is how a model ends up describing a diagram it never saw.
        images = markdown.count("[image: ")
        if images:
            note += (
                f" {images} image(s) appear as [image: filename] markers. Those are"
                " names, not pictures: call confluence_get_attachment(page_id,"
                " filename) to actually see one, or confluence_list_attachments"
                " to find out which of them are images at all."
            )
        shaped["body_note"] = note

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


def shape_confluence_attachment(raw: Mapping[str, Any], *, base_url: str) -> dict[str, Any]:
    """One entry from ``content/{id}/child/attachment``.

    Two fields are read from two places each, and neither pair is redundant:

    ``extensions.mediaType`` and ``extensions.fileSize`` are where Data Center
    puts them; ``metadata.mediaType`` is where Cloud does. This package targets
    DC, but a user who points it at Cloud gets a working list rather than a
    row of nulls that looks like an empty page - and the probe, not a silently
    degraded payload, is what should tell them which they are on.

    The download link is taken from ``_links.download`` rather than built,
    because that is the only form that already carries the instance's context
    path and its version query. See ``download_url_for``.
    """
    ext = raw.get("extensions") if isinstance(raw.get("extensions"), Mapping) else {}
    meta = raw.get("metadata") if isinstance(raw.get("metadata"), Mapping) else {}
    links = raw.get("_links") if isinstance(raw.get("_links"), Mapping) else {}

    media = ext.get("mediaType") or meta.get("mediaType")
    size = ext.get("fileSize")
    if not isinstance(size, int):
        size = None

    version = raw.get("version") if isinstance(raw.get("version"), Mapping) else {}
    by = version.get("by") if isinstance(version.get("by"), Mapping) else {}

    return shape_attachment(
        attachment_id=str(raw.get("id")) if raw.get("id") is not None else None,
        filename=raw.get("title") if isinstance(raw.get("title"), str) else None,
        media_type=media if isinstance(media, str) else None,
        size=size,
        download_path=download_url_for(links.get("download"), base_url),
        page_url=_webui_url(raw, base_url),
        created=version.get("when") if isinstance(version.get("when"), str) else None,
        author=by.get("displayName") if isinstance(by.get("displayName"), str) else None,
    )
