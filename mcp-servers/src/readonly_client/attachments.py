"""What an attachment looks like once it is on its way to a model.

Jira and Confluence disagree about almost every field name here - ``filename``
against ``title``, ``mimeType`` against ``extensions.mediaType``, an absolute
``content`` URL against a relative ``_links.download`` - so the per-product
readers stay in their own shaping modules. What lives here is everything that
is the same on both sides, and each of those is a decision rather than a
convenience:

* **Which types are worth downloading at all.** The client at the other end of
  the pipe sends png, jpeg, gif and webp on the wire and describes everything
  else, because those four are what the model APIs accept. Fetching a 3 MB TIFF
  to have it dropped one hop later spends the request and answers nothing, so
  the refusal happens here, before the download, and says what it refused.

* **How a name is matched.** A model asking for an attachment has read the
  filename out of page text or a Jira field, so it usually has it exactly. When
  it does not - a trailing space, the wrong case, "topology" for
  "topology-v2.png" - a 404 teaches it nothing. Matching widens in steps and a
  miss lists what is actually there, which is the one answer that lets the next
  call succeed.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from .errors import ServiceError
from .mcp_compat import image_block

# Must agree with WIRE_IMAGE_TYPES in the extension's src/mcp/client.ts. These
# are the four media types the model wires accept inline; anything else is a
# 400 there, so it is not worth a download here.
VIEWABLE_IMAGE_TYPES: frozenset[str] = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)


def is_viewable_image(media_type: str | None) -> bool:
    """Whether the model could actually look at this, if we fetched it."""
    return (media_type or "").split(";")[0].strip().lower() in VIEWABLE_IMAGE_TYPES


def shape_attachment(
    *,
    attachment_id: str | None,
    filename: str | None,
    media_type: str | None,
    size: int | None,
    download_path: str | None,
    page_url: str | None = None,
    created: str | None = None,
    author: str | None = None,
) -> dict[str, Any]:
    """One attachment, projected to the fields a caller can act on.

    ``viewable`` is computed rather than left for the caller to work out from
    ``media_type``: it is the difference between "ask for this one" and "this
    one can only be described", and a model reading a list should not have to
    know which four strings this build happens to support.
    """
    return {
        # Private, and stripped before the summary reaches the model: it is
        # plumbing for `fetch_attachment`, and a path in the payload invites a
        # model to ask for an arbitrary one.
        "_download_path": download_path,
        "id": attachment_id,
        "filename": filename,
        "media_type": media_type,
        "size": size,
        "viewable": is_viewable_image(media_type),
        # Absent when the payload named no download location. That is not the
        # same as an attachment with no bytes: it means this client cannot
        # reach them, which the get_* tools report rather than guessing a path.
        "downloadable": bool(download_path),
        "created": created,
        "author": author,
        "url": page_url,
    }


def pick_attachment(
    items: Sequence[Mapping[str, Any]], filename: str, *, where: str
) -> Mapping[str, Any]:
    """Find the one attachment a caller named, or explain what is there instead.

    Widening in three steps, stopping at the first that gives exactly one hit:
    exact, case-insensitive, then substring. Substring is last and requires
    uniqueness, because "diagram" matching four files must not silently return
    whichever happened to be first - a model told "topology.png" when it asked
    for "diagram" can correct itself; one handed the wrong picture cannot.
    """
    wanted = (filename or "").strip()
    if not wanted:
        raise ServiceError(
            f"filename is required. {_inventory(items, where)}"
        )

    def named(item: Mapping[str, Any]) -> str:
        return str(item.get("filename") or "")

    exact = [i for i in items if named(i) == wanted]
    if len(exact) == 1:
        return exact[0]
    # More than one attachment can genuinely share a name on both products -
    # different versions, or the same file added to two comments. The newest is
    # last in both payloads, and it is the one a caller naming a file means.
    if len(exact) > 1:
        return exact[-1]

    folded = [i for i in items if named(i).lower() == wanted.lower()]
    if folded:
        return folded[-1]

    partial = [i for i in items if wanted.lower() in named(i).lower()]
    if len(partial) == 1:
        return partial[0]
    if len(partial) > 1:
        names = ", ".join(sorted(named(i) for i in partial))
        raise ServiceError(
            f"{wanted!r} matches more than one attachment on {where}: {names}. "
            "Ask for one by its full filename."
        )

    raise ServiceError(f"No attachment named {wanted!r} on {where}. {_inventory(items, where)}")


def _inventory(items: Sequence[Mapping[str, Any]], where: str) -> str:
    """The list that makes the next call succeed."""
    if not items:
        return f"{where} has no attachments at all."
    names = ", ".join(str(i.get("filename") or "?") for i in items[:25])
    more = f" (and {len(items) - 25} more)" if len(items) > 25 else ""
    return f"{where} has: {names}{more}."


async def fetch_attachment(chosen: Mapping[str, Any], client: Any) -> list[Any]:
    """Download one already-resolved attachment and wrap it for the model.

    Both products end here, because from this point the two are the same
    problem: a path on the instance, a size limit, and a content block.

    Refuses BEFORE the request in the two ways that matter, and each refusal
    tells the caller something different about what to do next:

      * A media type the model cannot be shown. The next move is a human with
        a browser, not another tool call.
      * A payload that named no download location. The next move is
        ``probe.py``: this deployment is not shaped the way these paths assume,
        and no amount of retrying will change that.

    Returns ``[summary, image]``. The summary is not decoration - pixels with
    no filename, no size and no page give the model nothing to cite when it
    reports what the diagram showed.
    """
    name = chosen.get("filename") or "the attachment"
    media = chosen.get("media_type") or "unknown"
    if not chosen.get("viewable"):
        raise ServiceError(
            f"{name} is {media}, which cannot be shown to a model. Only PNG, JPEG, GIF "
            "and WebP are fetched; anything else would arrive as a blob the model "
            "cannot read. Open it in a browser instead."
        )
    path = chosen.get("_download_path")
    if not path:
        raise ServiceError(
            f"The instance did not say where the bytes of {name} are, so there is "
            "nothing to fetch. That usually means this deployment is shaped "
            "differently from what these REST paths assume - run probe.py."
        )

    got = await client.get_bytes(str(path))
    # The response header wins over the metadata. The metadata is what someone
    # typed when they uploaded; the header is what the bytes actually are, and
    # it is the header the model's endpoint has to decode.
    served = (got.content_type or media).split(";")[0].strip() or media
    if not is_viewable_image(served):
        raise ServiceError(
            f"{name} was listed as {media} but the instance served it as "
            f"{served or 'nothing'}, which cannot be shown to a model. The listed "
            "type was wrong, not the request."
        )
    summary = {k: v for k, v in chosen.items() if not k.startswith("_")}
    summary["bytes"] = len(got.content)
    summary["served_as"] = served
    return [summary, image_block(got.content, served)]
