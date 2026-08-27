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

    SDK_MAJOR = 2
except Exception as exc_2:  # pragma: no cover - depends on installed version
    try:  # SDK 1.x - FastMCP, as named in the brief
        from mcp.server.fastmcp import FastMCP as _Server  # type: ignore[import-not-found]

        SDK_MAJOR = 1
    except Exception as exc_1:  # pragma: no cover
        _Server = None  # type: ignore[assignment]
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
