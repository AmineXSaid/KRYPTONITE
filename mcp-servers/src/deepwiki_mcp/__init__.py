"""deepwiki-mcp - a local, endpoint-driven codebase wiki for Genesis.

Unlike the read-only servers beside it, this one is not a client to an
external system. It reads the workspace off local disk, generates a wiki
*through a Genesis endpoint profile* (the same proxy/cert/air-gap path the
rest of the agent uses), writes it into the repo under ``.agent/wiki/``, and
then serves it back to any agent or MCP client that asks.

The serving surface is deliberately pull, not push: an agent calls
``search_wiki`` / ``read_wiki_page`` / ``ask_wiki`` when a task needs repo
understanding, and pays no context for it otherwise. The wiki is a source
agents query, never context they are given.
"""

from __future__ import annotations

__all__ = ["__version__"]

__version__ = "1.0.0"
