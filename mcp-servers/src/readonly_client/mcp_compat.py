"""One import that works on both major versions of the Python MCP SDK.

The brief asked for FastMCP. In SDK 2.x FastMCP was renamed to ``MCPServer``:
the decorator-based programming model is unchanged - ``@server.tool()`` and
``server.run()`` behave the same - but the import path and class name moved,
and ``from mcp.server.fastmcp import FastMCP`` now raises on a default install.

Rather than pin the SDK backwards to keep an old name, or silently rewrite the
servers against an API the brief did not ask for, this resolves whichever is
installed. The servers are written once against the shared model.

If you specifically want the 1.x line, pin ``mcp<2`` in pyproject.toml and this
module will pick up ``FastMCP`` without any other change.
"""

from __future__ import annotations

from typing import Any

_IMPORT_ERROR: Exception | None = None

try:  # SDK 2.x - current
    from mcp.server.mcpserver import MCPServer as _Server  # type: ignore[import-not-found]
    from mcp.server.mcpserver import Image as _Image  # type: ignore[import-not-found]

    SDK_MAJOR = 2
except Exception as exc_2:  # pragma: no cover - depends on installed version
    try:  # SDK 1.x - FastMCP, as named in the brief
        from mcp.server.fastmcp import FastMCP as _Server  # type: ignore[import-not-found]
        from mcp.server.fastmcp import Image as _Image  # type: ignore[import-not-found]

        SDK_MAJOR = 1
    except Exception as exc_1:  # pragma: no cover
        _Server = None  # type: ignore[assignment]
        _Image = None  # type: ignore[assignment]
        SDK_MAJOR = 0
        _IMPORT_ERROR = exc_1 if isinstance(exc_2, ModuleNotFoundError) else exc_2


def build_server(name: str, instructions: str | None = None) -> Any:
    """Construct the SDK's server object under whichever name it ships as."""
    if _Server is None:  # pragma: no cover
        raise RuntimeError(
            "No usable MCP SDK found. Install one with:  pip install 'mcp[cli]'\n"
            f"Underlying import error: {_IMPORT_ERROR}"
        )
    if instructions is not None:
        try:
            return _Server(name, instructions=instructions)
        except TypeError:
            # 1.x FastMCP took instructions too, but be tolerant of either.
            pass
    return _Server(name)


def image_block(data: bytes, mime_type: str) -> Any:
    """Wrap bytes so the SDK renders them as an MCP image content block.

    The helper moved with the server class - ``fastmcp.Image`` in 1.x,
    ``mcpserver.Image`` in 2.x - so it is resolved here beside it rather than
    imported at four call sites that would each have to know the version.

    It takes a `format`, not a media type: the SDK builds ``image/<format>``
    itself, so passing ``image/png`` through would produce ``image/image/png``
    and a content block no client can read. Splitting on the slash is the whole
    conversion, and it is exactly the kind of thing that looks like noise until
    it silently costs a picture.

    A tool returns ``[summary_dict, image_block(...)]`` and the SDK flattens
    that into a text block followed by an image block. Returning the image
    ALONE would be simpler and is wrong: the model would get pixels with no
    file name, no page and no size, and no way to cite where the diagram came
    from.
    """
    if _Image is None:  # pragma: no cover - no SDK at all; build_server says so
        raise RuntimeError("No usable MCP SDK found; cannot build an image block.")
    fmt = (mime_type or "").split("/")[-1].strip().lower() or "png"
    return _Image(data=data, format=fmt)


# The resolved `Image` class, exported so a tool can NAME it in its return
# annotation. That is load-bearing rather than cosmetic:
#
# The SDK decides between "these are content blocks" and "this is structured
# data" by inspecting the annotation, not the value. A tool annotated
# `-> list[Any]` gets the structured-data path, which tries to serialise the
# Image through pydantic and raises `Unable to serialize unknown type: Image`
# at call time - after the download has already been paid for, and only when
# a client actually calls the tool, so nothing in an import check or a unit
# test on the function catches it.
#
# `-> list[dict[str, Any] | ImageBlock]` is what makes the SDK render blocks.
# tests/test_attachments.py calls the tool through the server for exactly this
# reason: the failure is invisible from the function's own return value.
ImageBlock = _Image
